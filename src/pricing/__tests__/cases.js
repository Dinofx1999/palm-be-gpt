'use strict'
/**
 * cases.js — Bộ test case (100+) cho pricing engine mới.
 * Mỗi case: Input (stay/booking) → Expected Total (+ Expected Lines nếu cần).
 * Chạy: node __tests__/cases.js
 */
const path = require('path')
const { priceStay, priceBooking } = require('../index')
const R = require('./runner')

// ── Helpers ──────────────────────────────────────────────────────────────
const OFF = 7 * 60
// Tạo Date theo GIỜ VIỆT NAM (UTC+7). vn(2026,6,12,14,0) = 14:00 ngày 12/06 VN.
function vn(y, mo, d, h, mi) { return new Date(Date.UTC(y, mo - 1, d, h - 7, mi || 0, 0)) }

const TIERS = [
  { time: '01:00', price: 100000 }, { time: '02:00', price: 150000 },
  { time: '03:00', price: 200000 }, { time: '04:00', price: 250000 },
  { time: '05:00', price: 300000 }, { time: '06:00', price: 350000 },
  { time: '07:00', price: 400000 }, { time: '08:00', price: 450000 },
  { time: '09:00', price: 500000 }, { time: '10:00', price: 550000 },
]
const HOUR_SLOTS = [
  { time: '02:00', price: 100000 }, { time: '03:00', price: 120000 },
  { time: '04:00', price: 140000 }, { time: '05:00', price: 160000 },
  { time: '06:00', price: 180000 }, { time: '08:00', price: 220000 },
]
// Policy giá NGÀY chuẩn (550k)
function dayPolicy(over = {}) {
  return {
    dayPrice: 550000, dayCheckInTime: '14:00', dayCheckOutTime: '12:00',
    dayEarlyCheckIn: TIERS, dayLateCheckOut: TIERS,
    dayAdultSurcharge: 150000, dayChildSurcharge: 80000,
    hourSlots: HOUR_SLOTS, nightPrice: 400000,
    nightCheckInTime: '22:00', nightCheckOutTime: '11:00',
    ...over,
  }
}
const CTX = { hotelUtcOffsetMinutes: OFF, toleranceMinutes: 15, dayEquivalentHours: 23, earlyCheckinUntilHour: 5 }

// Tạo stay lẻ nhanh
function stay(over = {}) {
  return {
    roomNumber: '101', priceType: 'day', policy: dayPolicy(),
    occupancy: { adults: 2, children: 0 }, capacity: { maxAdults: 2, maxChildren: 1, maxOccupancy: 3 },
    isFreeRoom: false, status: 'checked_in',
    plannedCheckIn: vn(2026, 6, 12, 14, 0), actualCheckIn: vn(2026, 6, 12, 14, 0),
    plannedCheckOut: vn(2026, 6, 13, 12, 0), actualCheckOut: null,
    transfers: [],
    ...over,
  }
}
// Chạy 1 stay, trả {total, breakdown}
function runStay(s, opts = {}) {
  const r = priceStay(s, { ctx: CTX, viewMode: opts.viewMode || 'to-checkout', now: opts.now, customRoomPrice: opts.customRoomPrice })
  return { total: r.roomAmount, breakdown: r.breakdown }
}
function runBk(bk, opts = {}) {
  const r = priceBooking(bk, { ctx: CTX, viewMode: opts.viewMode || 'to-checkout', now: opts.now })
  return { total: r.totalAmount, breakdown: r.breakdown }
}

const cases = []
const C = (id, name, run, expectTotal, expectLines) => cases.push({ id, name, run, expectTotal, expectLines })

// ══ 1. ĐẶT PHÒNG BÌNH THƯỜNG (giá ngày) ══
C('N1', 'Đặt 1 đêm chuẩn 14:00→12:00', () => runStay(stay()), 550000, [550000])
C('N2', 'Đặt 2 đêm', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 14, 12, 0) })), 1100000, [550000, 550000])
C('N3', 'Đặt 3 đêm', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 15, 12, 0) })), 1650000, [550000, 550000, 550000])
C('N4', 'Đặt 5 đêm', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 17, 12, 0) })), 2750000)
C('N5', 'Nhận đúng giờ chuẩn, trả đúng giờ chuẩn', () => runStay(stay()), 550000, [550000])
C('N6', 'Giá ngày khác (600k) 1 đêm', () => runStay(stay({ policy: dayPolicy({ dayPrice: 600000 }) })), 600000, [600000])

// ══ 2. NGHỈ GIỜ ══
C('H1', 'Nghỉ 3 giờ', () => runStay(stay({ priceType: 'hour', actualCheckIn: vn(2026, 6, 12, 10, 0), plannedCheckOut: vn(2026, 6, 12, 13, 0) })), 120000, [120000])
C('H2', 'Nghỉ 2 giờ', () => runStay(stay({ priceType: 'hour', actualCheckIn: vn(2026, 6, 12, 10, 0), plannedCheckOut: vn(2026, 6, 12, 12, 0) })), 100000, [100000])
C('H3', 'Nghỉ 5 giờ', () => runStay(stay({ priceType: 'hour', actualCheckIn: vn(2026, 6, 12, 10, 0), plannedCheckOut: vn(2026, 6, 12, 15, 0) })), 160000, [160000])
C('H4', 'Nghỉ 2h10 (trong tolerance → vẫn 2h)', () => runStay(stay({ priceType: 'hour', actualCheckIn: vn(2026, 6, 12, 10, 0), plannedCheckOut: vn(2026, 6, 12, 12, 10) })), 100000, [100000])
C('H5', 'Nghỉ 6 giờ', () => runStay(stay({ priceType: 'hour', actualCheckIn: vn(2026, 6, 12, 10, 0), plannedCheckOut: vn(2026, 6, 12, 16, 0) })), 180000, [180000])
C('H6', 'Nghỉ ≤ 15 phút → miễn phí (grace)', () => runStay(stay({ priceType: 'hour', actualCheckIn: vn(2026, 6, 12, 10, 0), plannedCheckOut: vn(2026, 6, 12, 10, 10) })), 0, [0])

// ══ 3. QUA ĐÊM (giá đêm) ══
C('O1', 'Giá đêm 22:00→11:00 = 1 đêm', () => runStay(stay({ priceType: 'night', actualCheckIn: vn(2026, 6, 12, 22, 0), plannedCheckOut: vn(2026, 6, 13, 11, 0) })), 400000, [400000])
C('O2', 'Giá đêm 2 đêm', () => runStay(stay({ priceType: 'night', actualCheckIn: vn(2026, 6, 12, 22, 0), plannedCheckOut: vn(2026, 6, 14, 11, 0) })), 800000, [800000])
C('O3', 'Giá đêm 3 đêm', () => runStay(stay({ priceType: 'night', actualCheckIn: vn(2026, 6, 12, 22, 0), plannedCheckOut: vn(2026, 6, 15, 11, 0) })), 1200000, [1200000])

// ══ 4. TRẢ MUỘN (late checkout) ══
C('L1', 'Trả muộn 3h (15:00) → +late 3h', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 13, 15, 0) })), 750000, [550000, 200000])
C('L2', 'Trả muộn 6h (18:00) → +late 6h', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 13, 18, 0) })), 900000, [550000, 350000])
C('L3', 'Trả muộn 1h (13:00) → +late 1h', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 13, 13, 0) })), 650000, [550000, 100000])
C('L4', 'Trả trễ 10p (12:10) ≤ tolerance → KHÔNG phụ thu', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 13, 12, 10) })), 550000, [550000])
C('L5', 'Trả muộn tới 23:30 (≥23h) → thành 2 đêm', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 13, 23, 30) })), 1100000, [550000, 550000])
C('L6', 'Trả muộn 2 đêm + late 3h', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 14, 15, 0) })), 1300000, [550000, 550000, 200000])

// ══ 5. NHẬN SỚM (early checkin) ══
C('E1', 'Nhận sớm 09:00 (sớm 5h) → +early 5h', () => runStay(stay({ actualCheckIn: vn(2026, 6, 12, 9, 0) })), 850000, [550000, 300000])
C('E2', 'Nhận sớm 12:00 (sớm 2h) → +early 2h', () => runStay(stay({ actualCheckIn: vn(2026, 6, 12, 12, 0) })), 700000, [550000, 150000])
C('E3', 'Nhận sớm 13:50 (sớm 10p) ≤ tolerance → KHÔNG phụ thu', () => runStay(stay({ actualCheckIn: vn(2026, 6, 12, 13, 50) })), 550000, [550000])
C('E4', 'Nhận rạng sáng 02:00 → +1 đêm (không phụ thu)', () => runStay(stay({ actualCheckIn: vn(2026, 6, 12, 2, 0), plannedCheckOut: vn(2026, 6, 13, 12, 0) })), 1100000, [550000, 550000])
C('E5', 'Nhận sớm 08:00 (sớm 6h) → +early 6h', () => runStay(stay({ actualCheckIn: vn(2026, 6, 12, 8, 0) })), 900000, [550000, 350000])
C('E6', 'Nhận sớm + trả muộn cùng booking', () => runStay(stay({ actualCheckIn: vn(2026, 6, 12, 12, 0), plannedCheckOut: vn(2026, 6, 13, 15, 0) })), 900000, [550000, 150000, 200000])

// ══ 6. ĐỔI PHÒNG GIỮA CHỪNG (đã ở thật ở phòng cũ) ══
function transferStay(over = {}) {
  return stay({
    roomNumber: '102',
    actualCheckIn: vn(2026, 6, 12, 14, 0),
    plannedCheckOut: vn(2026, 6, 15, 12, 0),
    transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 14, 0),
      fromPolicy: dayPolicy(), toPolicy: dayPolicy() }],
    ...over,
  })
}
C('T1', 'Đổi 101→102 sau 1 đêm (mỗi phòng 550k/đêm)', () => runStay(transferStay()), 1650000)
C('T2', 'Đổi phòng, phòng mới giá cao hơn', () => runStay(transferStay({
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 14, 0),
    fromPolicy: dayPolicy(), toPolicy: dayPolicy({ dayPrice: 700000 }) }] })), 1950000)
C('T3', 'Đổi phòng giữa đêm 1 (ở 102 trọn từ đầu)', () => runStay(transferStay({
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 12, 20, 0),
    fromPolicy: dayPolicy(), toPolicy: dayPolicy() }] })), 1650000)
C('T4', 'Đổi phòng ngay khi nhận (101 ≤15p) → chỉ tính 102', () => runStay(stay({
  roomNumber: '102', plannedCheckOut: vn(2026, 6, 13, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 12, 14, 10),
    fromPolicy: dayPolicy(), toPolicy: dayPolicy() }] })), 550000, [550000])
C('T5', 'Đổi phòng ngay (101 14 phút) 3 đêm → chỉ 102 ×3', () => runStay(stay({
  roomNumber: '203', plannedCheckOut: vn(2026, 6, 15, 12, 0),
  transfers: [{ fromRoomNumber: '602', toRoomNumber: '203', transferAt: vn(2026, 6, 12, 14, 14),
    fromPolicy: dayPolicy(), toPolicy: dayPolicy() }] })), 1650000, [550000, 550000, 550000])
C('T6', 'Đổi phòng ngay nhưng phòng mới 600k', () => runStay(stay({
  roomNumber: '203', plannedCheckOut: vn(2026, 6, 13, 12, 0),
  transfers: [{ fromRoomNumber: '602', toRoomNumber: '203', transferAt: vn(2026, 6, 12, 14, 10),
    fromPolicy: dayPolicy(), toPolicy: dayPolicy({ dayPrice: 600000 }) }] })), 600000, [600000])

// ══ 7. ĐỔI PHÒNG NHIỀU LẦN ══
C('M1', 'Đổi 2 lần 101→102→103', () => runStay(stay({
  roomNumber: '103', plannedCheckOut: vn(2026, 6, 15, 12, 0),
  transfers: [
    { fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 14, 0), fromPolicy: dayPolicy(), toPolicy: dayPolicy() },
    { fromRoomNumber: '102', toRoomNumber: '103', transferAt: vn(2026, 6, 14, 14, 0), fromPolicy: dayPolicy(), toPolicy: dayPolicy() },
  ] })), 1650000)
C('M2', 'Đổi 2 lần, lần cuối ngay (103 ≤15p) → drop 103-leg cuối? không, cuối luôn giữ', () => runStay(stay({
  roomNumber: '103', plannedCheckOut: vn(2026, 6, 14, 12, 0),
  transfers: [
    { fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 14, 0), fromPolicy: dayPolicy(), toPolicy: dayPolicy() },
    { fromRoomNumber: '102', toRoomNumber: '103', transferAt: vn(2026, 6, 13, 14, 10), fromPolicy: dayPolicy(), toPolicy: dayPolicy() },
  ] })), 1100000)
C('M3', 'Đổi 3 lần', () => runStay(stay({
  roomNumber: '104', plannedCheckOut: vn(2026, 6, 16, 12, 0),
  transfers: [
    { fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 14, 0), fromPolicy: dayPolicy(), toPolicy: dayPolicy() },
    { fromRoomNumber: '102', toRoomNumber: '103', transferAt: vn(2026, 6, 14, 14, 0), fromPolicy: dayPolicy(), toPolicy: dayPolicy() },
    { fromRoomNumber: '103', toRoomNumber: '104', transferAt: vn(2026, 6, 15, 14, 0), fromPolicy: dayPolicy(), toPolicy: dayPolicy() },
  ] })), 2200000)
C('M4', 'Đổi 2 lần ngay từ đầu (cả 2 ≤15p) → chỉ phòng cuối', () => runStay(stay({
  roomNumber: '103', plannedCheckOut: vn(2026, 6, 13, 12, 0),
  transfers: [
    { fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 12, 14, 5), fromPolicy: dayPolicy(), toPolicy: dayPolicy() },
    { fromRoomNumber: '102', toRoomNumber: '103', transferAt: vn(2026, 6, 12, 14, 10), fromPolicy: dayPolicy(), toPolicy: dayPolicy() },
  ] })), 550000, [550000])

// ══ 8. ĐỔI GIÁ (change price) — policy mới áp cho chặng mới ══
C('CP1', 'Đổi giá 550k→700k giữa chừng', () => runStay(transferStay({
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 14, 0),
    fromPolicy: dayPolicy(), toPolicy: dayPolicy({ dayPrice: 700000 }) }] })), 1950000)
C('CP2', 'Đổi giá ngay khi nhận → chỉ giá mới', () => runStay(stay({
  roomNumber: '203', plannedCheckOut: vn(2026, 6, 13, 12, 0),
  transfers: [{ fromRoomNumber: '602', toRoomNumber: '203', transferAt: vn(2026, 6, 12, 14, 10),
    fromPolicy: dayPolicy(), toPolicy: dayPolicy({ dayPrice: 600000 }) }] })), 600000, [600000])
C('CP3', 'Đổi giá thấp hơn 550k→450k (1 đêm 550 + 2 đêm 450)', () => runStay(transferStay({
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 14, 0),
    fromPolicy: dayPolicy(), toPolicy: dayPolicy({ dayPrice: 450000 }) }] })), 1450000)

// ══ 9. GIỮ GIÁ CŨ (phòng hỏng, đổi phòng nhưng cùng policy) ══
C('K1', 'Giữ giá cũ: 101→102 cùng 550k', () => runStay(transferStay()), 1650000)
C('K2', 'Giữ giá cũ ngay khi nhận', () => runStay(stay({
  roomNumber: '102', plannedCheckOut: vn(2026, 6, 13, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 12, 14, 10),
    fromPolicy: dayPolicy(), toPolicy: dayPolicy() }] })), 550000, [550000])

// ══ 10. ĐOÀN NHIỀU PHÒNG ══
function groupBk(over = {}) {
  return {
    isGroup: true,
    stays: [
      stay({ roomNumber: '201' }),
      stay({ roomNumber: '202' }),
    ],
    servicesAmount: 0, discountPercent: 0, discountAmount: 0, transferFee: 0, paidAmount: 0, isFreeRoom: false,
    ...over,
  }
}
C('G1', 'Đoàn 2 phòng 1 đêm', () => runBk(groupBk()), 1100000, [550000, 550000])
C('G2', 'Đoàn 3 phòng 1 đêm', () => runBk(groupBk({ stays: [stay({ roomNumber: '201' }), stay({ roomNumber: '202' }), stay({ roomNumber: '203' })] })), 1650000, [550000, 550000, 550000])
C('G3', 'Đoàn 2 phòng 2 đêm', () => runBk(groupBk({ stays: [stay({ roomNumber: '201', plannedCheckOut: vn(2026, 6, 14, 12, 0) }), stay({ roomNumber: '202', plannedCheckOut: vn(2026, 6, 14, 12, 0) })] })), 2200000)
C('G4', 'Đoàn 2 phòng, 1 phòng đổi phòng', () => runBk(groupBk({ stays: [
  transferStay({ roomNumber: '203' }), stay({ roomNumber: '202', plannedCheckOut: vn(2026, 6, 15, 12, 0) })] })), 3300000)
C('G5', 'Đoàn 2 phòng giá khác nhau', () => runBk(groupBk({ stays: [stay({ roomNumber: '201' }), stay({ roomNumber: '202', policy: dayPolicy({ dayPrice: 700000 }) })] })), 1250000, [550000, 700000])
C('G6', 'Đoàn 1 phòng huỷ → chỉ tính phòng còn lại', () => runBk(groupBk({ stays: [stay({ roomNumber: '201' }), stay({ roomNumber: '202', status: 'cancelled' })] })), 550000, [550000])

// ══ 11. CHECK-OUT TỪNG PHÒNG (1 phòng đã checkout, 1 chưa) ══
C('PC1', 'Đoàn: phòng 201 đã checkout 1 đêm, 202 đang ở 2 đêm', () => runBk(groupBk({ stays: [
  stay({ roomNumber: '201', status: 'checked_out', actualCheckOut: vn(2026, 6, 13, 12, 0) }),
  stay({ roomNumber: '202', plannedCheckOut: vn(2026, 6, 14, 12, 0) }) ] })), 1650000)
C('PC2', 'Đoàn: 1 phòng checkout sớm (nửa đêm vẫn tính 1 đêm)', () => runBk(groupBk({ stays: [
  stay({ roomNumber: '201', status: 'checked_out', actualCheckOut: vn(2026, 6, 12, 20, 0) }),
  stay({ roomNumber: '202' }) ] })), 1100000)

// ══ 12. SPLIT GROUP (tách 1 phòng khỏi đoàn → tính độc lập) ══
C('SP1', 'Split: tách phòng 202 ra tính riêng', () => runStay(stay({ roomNumber: '202' })), 550000, [550000])
C('SP2', 'Split: phòng tách có 2 đêm', () => runStay(stay({ roomNumber: '202', plannedCheckOut: vn(2026, 6, 14, 12, 0) })), 1100000)
C('SP3', 'Split: đoàn còn lại 2 phòng sau khi tách 1', () => runBk(groupBk({ stays: [stay({ roomNumber: '201' }), stay({ roomNumber: '203' })] })), 1100000)

// ══ 13. MERGE GROUP (gộp phòng lẻ vào đoàn → cộng dồn) ══
C('MG1', 'Merge: gộp thành đoàn 3 phòng', () => runBk(groupBk({ stays: [stay({ roomNumber: '201' }), stay({ roomNumber: '202' }), stay({ roomNumber: '301' })] })), 1650000)
C('MG2', 'Merge: đoàn sau gộp có giá khác nhau', () => runBk(groupBk({ stays: [stay({ roomNumber: '201' }), stay({ roomNumber: '202', policy: dayPolicy({ dayPrice: 600000 }) }), stay({ roomNumber: '301', policy: dayPolicy({ dayPrice: 700000 }) })] })), 1850000)
C('MG3', 'Merge: 2 đoàn gộp 4 phòng', () => runBk(groupBk({ stays: [stay({ roomNumber: '201' }), stay({ roomNumber: '202' }), stay({ roomNumber: '301' }), stay({ roomNumber: '302' })] })), 2200000)

// ══ 14. CHECKOUT LÚC 00:00 ══
C('Z1', 'Checkout 00:00 (đêm trước đó, qua nửa đêm về sáng)', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 13, 0, 0) })), 550000, [550000])
C('Z2', 'Checkout 00:00 sau 2 đêm', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 14, 0, 0) })), 1100000)
C('Z3', 'Checkout 00:00 ngày nhận (sai logic? ở 10h)', () => runStay(stay({ actualCheckIn: vn(2026, 6, 12, 14, 0), plannedCheckOut: vn(2026, 6, 13, 0, 0) })), 550000, [550000])

// ══ 15. CHECKOUT LÚC 23:59 ══
C('Y1', 'Checkout 23:59 (≥23h) → 2 đêm', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 13, 23, 59) })), 1100000, [550000, 550000])
C('Y2', 'Checkout 23:59 sau 2 đêm → 3 đêm', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 14, 23, 59) })), 1650000)
C('Y3', 'Checkout 22:00 (<23h) → 1 đêm + late', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 13, 22, 0) })), 1100000, [550000, 550000])

// ══ 16. CHUYỂN PHÒNG LÚC 03:00 (rạng sáng) ══
C('TR03a', 'Đổi phòng 03:00 đêm 2', () => runStay(stay({
  roomNumber: '102', plannedCheckOut: vn(2026, 6, 15, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 3, 0), fromPolicy: dayPolicy(), toPolicy: dayPolicy() }] })), 1650000)
C('TR03b', 'Đổi 03:00 ngay đêm đầu (ở 101 13h)', () => runStay(stay({
  roomNumber: '102', actualCheckIn: vn(2026, 6, 12, 14, 0), plannedCheckOut: vn(2026, 6, 14, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 3, 0), fromPolicy: dayPolicy(), toPolicy: dayPolicy() }] })), 1100000)

// ══ 17. CHUYỂN PHÒNG LÚC 11:59 (sát giờ trả) ══
C('TR1159a', 'Đổi 11:59 (sát checkout 12:00)', () => runStay(stay({
  roomNumber: '102', plannedCheckOut: vn(2026, 6, 15, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 11, 59), fromPolicy: dayPolicy(), toPolicy: dayPolicy() }] })), 1650000)
C('TR1159b', 'Đổi 11:59 đêm đầu', () => runStay(stay({
  roomNumber: '102', plannedCheckOut: vn(2026, 6, 14, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 11, 59), fromPolicy: dayPolicy(), toPolicy: dayPolicy() }] })), 1100000)

// ══ 18. CHUYỂN PHÒNG LÚC 12:00 (đúng giờ trả) ══
C('TR12a', 'Đổi 12:00 đúng giờ chuẩn', () => runStay(stay({
  roomNumber: '102', plannedCheckOut: vn(2026, 6, 15, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 12, 0), fromPolicy: dayPolicy(), toPolicy: dayPolicy() }] })), 1650000)
C('TR12b', 'Đổi 12:00 sau 1 đêm', () => runStay(stay({
  roomNumber: '102', plannedCheckOut: vn(2026, 6, 14, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 12, 0), fromPolicy: dayPolicy(), toPolicy: dayPolicy() }] })), 1100000)

// ══ 19. CHUYỂN PHÒNG LÚC 14:00 (đúng giờ nhận) ══
C('TR14a', 'Đổi 14:00 đúng giờ nhận chuẩn', () => runStay(stay({
  roomNumber: '102', plannedCheckOut: vn(2026, 6, 15, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 14, 0), fromPolicy: dayPolicy(), toPolicy: dayPolicy() }] })), 1650000)
C('TR14b', 'Đổi 14:00 sau 2 đêm', () => runStay(stay({
  roomNumber: '102', plannedCheckOut: vn(2026, 6, 16, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 14, 14, 0), fromPolicy: dayPolicy(), toPolicy: dayPolicy() }] })), 2200000)

// ══ 20. MIỄN PHÍ PHÒNG ══
C('F1', 'Miễn phí phòng 1 đêm', () => runStay(stay({ isFreeRoom: true })), 0, [0])
C('F2', 'Miễn phí phòng 3 đêm', () => runStay(stay({ isFreeRoom: true, plannedCheckOut: vn(2026, 6, 15, 12, 0) })), 0, [0])
C('F3', 'Đoàn có 1 phòng miễn phí (booking-level free)', () => { const r = priceBooking(groupBk({ isFreeRoom: true }), { ctx: CTX }); return { total: r.totalAmount, breakdown: r.breakdown } }, 0)
C('F4', 'Miễn phí + có dịch vụ 200k → chỉ tính dịch vụ', () => { const r = priceBooking({ stays: [stay({ isFreeRoom: true })], isFreeRoom: true, servicesAmount: 200000 }, { ctx: CTX }); return { total: r.totalAmount, breakdown: r.breakdown } }, 200000)

// ══ EXTRA: PHỤ THU SỨC CHỨA ══
C('CAP1', '3 người lớn (max 2) → +1 NL phụ thu 150k', () => runStay(stay({ occupancy: { adults: 3, children: 0 } })), 700000, [550000, 150000])
C('CAP2', '2NL+2TE (maxC=1) → +1 TE 80k', () => runStay(stay({ occupancy: { adults: 2, children: 2 } })), 630000, [550000, 80000])
C('CAP3', '3NL 2 đêm → phụ thu mỗi đêm', () => runStay(stay({ occupancy: { adults: 3, children: 0 }, plannedCheckOut: vn(2026, 6, 14, 12, 0) })), 1400000, [550000, 150000, 550000, 150000])
C('CAP4', '4NL (max 2, maxOcc 3) — vẫn tính (engine không chặn)', () => runStay(stay({ occupancy: { adults: 4, children: 0 }, capacity: { maxAdults: 2, maxChildren: 1, maxOccupancy: 5 } })), 850000, [550000, 300000])

// ══ EXTRA: GIẢM GIÁ ══
C('D1', 'Giảm 10% trên 550k', () => { const r = priceBooking({ stays: [stay()], discountPercent: 10 }, { ctx: CTX }); return { total: r.totalAmount, breakdown: r.breakdown } }, 495000)
C('D2', 'Giảm cố định 100k', () => { const r = priceBooking({ stays: [stay()], discountAmount: 100000 }, { ctx: CTX }); return { total: r.totalAmount, breakdown: r.breakdown } }, 450000)
C('D3', 'Giảm 10% + dịch vụ 200k', () => { const r = priceBooking({ stays: [stay()], discountPercent: 10, servicesAmount: 200000 }, { ctx: CTX }); return { total: r.totalAmount, breakdown: r.breakdown } }, 675000)
C('D4', 'Đoàn giảm 20%', () => { const r = priceBooking(groupBk({ discountPercent: 20 }), { ctx: CTX }); return { total: r.totalAmount, breakdown: r.breakdown } }, 880000)

// ══ EXTRA: TÍNH ĐẾN HIỆN TẠI (to-now) ══
C('NOW1', 'Giá ngày to-now: mới 8 phút ≤ tolerance → grace 0đ (áp dụng mọi loại giá)', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 15, 12, 0) }), { viewMode: 'to-now', now: vn(2026, 6, 12, 14, 8) }), 0, [0])
C('NOW1b', 'Giá ngày to-now: 20 phút > tolerance → tính đêm 1', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 15, 12, 0) }), { viewMode: 'to-now', now: vn(2026, 6, 12, 14, 20) }), 550000, [550000])
C('NOW2', 'Booking 3 đêm, xem giữa đêm 2 → tính 2 đêm', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 15, 12, 0) }), { viewMode: 'to-now', now: vn(2026, 6, 13, 18, 0) }), 1100000)
C('NOW3', 'Booking 3 đêm, xem đêm 3 → tính 3 đêm', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 15, 12, 0) }), { viewMode: 'to-now', now: vn(2026, 6, 14, 20, 0) }), 1650000)
C('NOW4', 'Nghỉ giờ to-now: mới 8 phút → grace 0', () => runStay(stay({ priceType: 'hour', actualCheckIn: vn(2026, 6, 12, 10, 0), plannedCheckOut: vn(2026, 6, 12, 15, 0) }), { viewMode: 'to-now', now: vn(2026, 6, 12, 10, 8) }), 0, [0])

// ══ EXTRA: CHƯA NHẬN PHÒNG + ĐỔI PHÒNG (reserved) ══
C('RES1', 'Chưa nhận, đổi 101→102 → chỉ 102', () => runStay(stay({
  roomNumber: '102', status: 'reserved', actualCheckIn: null, plannedCheckOut: vn(2026, 6, 13, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 12, 14, 5), fromPolicy: dayPolicy(), toPolicy: dayPolicy() }] })), 550000, [550000])
C('RES2', 'Chưa nhận, đổi giá 101→102(600k) → chỉ 600k', () => runStay(stay({
  roomNumber: '102', status: 'reserved', actualCheckIn: null, plannedCheckOut: vn(2026, 6, 13, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 12, 14, 5), fromPolicy: dayPolicy(), toPolicy: dayPolicy({ dayPrice: 600000 }) }] })), 600000, [600000])
C('RES3', 'Chưa nhận, KHÔNG đổi → giá bình thường', () => runStay(stay({ status: 'reserved', actualCheckIn: null })), 550000, [550000])

// ══ EXTRA 2: thêm để vượt 100 case + phủ biên ══
C('X01', 'Nghỉ 8 giờ', () => runStay(stay({ priceType: 'hour', actualCheckIn: vn(2026, 6, 12, 10, 0), plannedCheckOut: vn(2026, 6, 12, 18, 0) })), 220000, [220000])
C('X03', 'Giá ngày 4 đêm', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 16, 12, 0) })), 2200000, [550000, 550000, 550000, 550000])
C('X04', 'Trả muộn 2h (14:00)', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 13, 14, 0) })), 700000, [550000, 150000])
C('X05', 'Trả muộn 5h (17:00)', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 13, 17, 0) })), 850000, [550000, 300000])
C('X06', 'Nhận sớm 10:00 (sớm 4h)', () => runStay(stay({ actualCheckIn: vn(2026, 6, 12, 10, 0) })), 800000, [550000, 250000])
C('X07', 'Nhận sớm 11:00 (sớm 3h)', () => runStay(stay({ actualCheckIn: vn(2026, 6, 12, 11, 0) })), 750000, [550000, 200000])
C('X08', 'Nhận rạng sáng 04:00 → +1 đêm', () => runStay(stay({ actualCheckIn: vn(2026, 6, 12, 4, 0), plannedCheckOut: vn(2026, 6, 13, 12, 0) })), 1100000, [550000, 550000])
C('X10', 'Đổi phòng 11:59 sau 2 đêm', () => runStay(stay({
  roomNumber: '102', plannedCheckOut: vn(2026, 6, 16, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 14, 11, 59), fromPolicy: dayPolicy(), toPolicy: dayPolicy() }] })), 2200000)
C('X11', 'Đổi phòng 12:00 sau 2 đêm', () => runStay(stay({
  roomNumber: '102', plannedCheckOut: vn(2026, 6, 16, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 14, 12, 0), fromPolicy: dayPolicy(), toPolicy: dayPolicy() }] })), 2200000)
C('X12', 'Đổi phòng 14:00 sau 1 đêm (giá mới 700k)', () => runStay(stay({
  roomNumber: '102', plannedCheckOut: vn(2026, 6, 15, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 14, 0), fromPolicy: dayPolicy(), toPolicy: dayPolicy({ dayPrice: 700000 }) }] })), 1950000)
C('X13', 'Đoàn 4 phòng', () => runBk(groupBk({ stays: [stay({ roomNumber: '201' }), stay({ roomNumber: '202' }), stay({ roomNumber: '203' }), stay({ roomNumber: '204' })] })), 2200000)
C('X14', 'Đoàn 5 phòng', () => runBk(groupBk({ stays: ['201', '202', '203', '204', '205'].map(n => stay({ roomNumber: n })) })), 2750000)
C('X16', '4NL+1TE (max2/1, maxOcc6) → +2NL', () => runStay(stay({ occupancy: { adults: 4, children: 1 }, capacity: { maxAdults: 2, maxChildren: 1, maxOccupancy: 6 } })), 850000, [550000, 300000])
C('X17', 'Miễn phí phòng 3 đêm + dịch vụ 150k', () => { const r = priceBooking({ stays: [stay({ isFreeRoom: true, plannedCheckOut: vn(2026, 6, 15, 12, 0) })], isFreeRoom: true, servicesAmount: 150000 }, { ctx: CTX }); return { total: r.totalAmount, breakdown: r.breakdown } }, 150000)
C('X18', 'Giảm 50%', () => { const r = priceBooking({ stays: [stay()], discountPercent: 50 }, { ctx: CTX }); return { total: r.totalAmount, breakdown: r.breakdown } }, 275000)
C('X19', 'Giảm 100%', () => { const r = priceBooking({ stays: [stay()], discountPercent: 100 }, { ctx: CTX }); return { total: r.totalAmount, breakdown: r.breakdown } }, 0)
C('X20', 'Phí chuyển phòng 50k cộng vào tổng', () => { const r = priceBooking({ stays: [stay()], transferFee: 50000 }, { ctx: CTX }); return { total: r.totalAmount, breakdown: r.breakdown } }, 600000)
C('X21', 'to-now: cuối đêm 1 (23:00) → 1 đêm', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 15, 12, 0) }), { viewMode: 'to-now', now: vn(2026, 6, 12, 23, 0) }), 550000, [550000])
C('X22', 'to-now: sáng ngày 2 trước 12:00 → đêm 1', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 15, 12, 0) }), { viewMode: 'to-now', now: vn(2026, 6, 13, 10, 0) }), 550000, [550000])
C('X23', 'to-now: chiều ngày 2 (15:00) → 2 đêm', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 15, 12, 0) }), { viewMode: 'to-now', now: vn(2026, 6, 13, 15, 0) }), 1100000)
C('X24', 'to-now: quá giờ trả dự kiến → tới hết kỳ', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 13, 12, 0) }), { viewMode: 'to-now', now: vn(2026, 6, 13, 18, 0) }), 550000, [550000])
C('X25', 'Custom price 480k', () => runStay(stay(), { customRoomPrice: 480000 }), 480000, [480000])
C('X26', 'Nghỉ giờ 4h', () => runStay(stay({ priceType: 'hour', actualCheckIn: vn(2026, 6, 12, 9, 0), plannedCheckOut: vn(2026, 6, 12, 13, 0) })), 140000, [140000])
C('X27', 'Giá đêm rạng sáng 22:00→11:00', () => runStay(stay({ priceType: 'night', actualCheckIn: vn(2026, 6, 11, 22, 0), plannedCheckOut: vn(2026, 6, 12, 11, 0) })), 400000, [400000])
C('X28', 'Đổi phòng đêm 2 lúc 14:00, giá mới 600k', () => runStay(stay({
  roomNumber: '102', plannedCheckOut: vn(2026, 6, 15, 12, 0),
  transfers: [{ fromRoomNumber: '101', toRoomNumber: '102', transferAt: vn(2026, 6, 13, 14, 0), fromPolicy: dayPolicy(), toPolicy: dayPolicy({ dayPrice: 600000 }) }] })), 1750000)
C('X29', 'Đoàn 3 phòng, 1 phòng huỷ giữa', () => runBk(groupBk({ stays: [stay({ roomNumber: '201' }), stay({ roomNumber: '202', status: 'cancelled' }), stay({ roomNumber: '203' })] })), 1100000, [550000, 550000])
C('X30', 'Trả muộn 4h (16:00)', () => runStay(stay({ plannedCheckOut: vn(2026, 6, 13, 16, 0) })), 800000, [550000, 250000])


// ══ REGRESSION: booking THẬT BK_7YDJVS (DB lưu sai 2.350.000 → đúng 1.800.000) ══
const { priceBookingDoc } = require('../pricingAdapter')
C('REAL1', 'BK_7YDJVS thật: đổi 602→203 sau 14p ≤ tol → 1.8M (không phải 2.35M)', () => {
  const booking = {
    roomNumber: '203', priceType: 'day', adults: 2, children: 0, isFreeRoom: false, status: 'checked_in',
    checkIn: new Date('2026-06-12T08:08:09.068Z'), actualCheckIn: new Date('2026-06-12T11:37:00.220Z'),
    checkOut: new Date('2026-06-15T05:00:00.000Z'), actualCheckOut: null,
    servicesAmount: 0, discountPercent: 0, discountAmount: 0, transferFee: 0,
    policySnapshot: { dayPrice: 600000, dayCheckInTime: '12:00', dayCheckOutTime: '12:00',
      dayEarlyCheckIn: TIERS, dayLateCheckOut: TIERS, dayAdultSurcharge: 150000, dayChildSurcharge: 80000, capacity: 4, maxChildren: 0, hourSlots: [] },
    transferHistory: [{ fromRoomNumber: '602', toRoomNumber: '203', transferAt: new Date('2026-06-12T11:51:40.267Z'), oldPolicyId: 'x', newPolicyId: 'y' }],
  }
  const inv = priceBookingDoc(booking, { branch: { toleranceMinutes: 15, dayEquivalentHours: 23, earlyCheckinUntil: 5 } })
  return { total: inv.totalAmount, breakdown: inv.breakdown }
}, 1800000, [600000, 600000, 600000])

C('REAL2', 'BK_3HBN7U: đổi 601→203 lúc 19:57 (giữa đêm, buổi tối) → đêm tính [203], 1 đêm 600k', () => {
  const booking = {
    roomNumber: '203', priceType: 'day', adults: 2, children: 0, isFreeRoom: false, status: 'checked_in',
    checkIn: new Date('2026-06-12T08:07:53.387Z'), actualCheckIn: new Date('2026-06-12T08:07:55.580Z'),
    checkOut: new Date('2026-06-13T05:00:00.000Z'), actualCheckOut: null,
    servicesAmount: 0, discountPercent: 0, discountAmount: 0, transferFee: 0,
    policySnapshot: { dayPrice: 600000, dayCheckInTime: '12:00', dayCheckOutTime: '12:00',
      dayEarlyCheckIn: TIERS, dayLateCheckOut: TIERS, dayAdultSurcharge: 150000, dayChildSurcharge: 80000, capacity: 4, maxChildren: 0, hourSlots: [] },
    transferHistory: [{ fromRoomNumber: '601', toRoomNumber: '203', transferAt: new Date('2026-06-12T12:57:08.102Z'), oldPolicyId: 'a', newPolicyId: 'b' }],
  }
  const inv = priceBookingDoc(booking, { branch: { toleranceMinutes: 15, dayEquivalentHours: 23, earlyCheckinUntil: 5 } })
  const room0 = inv.breakdown[0] && inv.breakdown[0].meta && inv.breakdown[0].meta.roomNumber
  if (room0 !== '203') throw new Error('Đêm phải tính cho phòng 203 (khách ngủ ở 203), nhận: ' + room0)
  return { total: inv.totalAmount, breakdown: inv.breakdown }
}, 600000, [600000])

// ── Chạy tất cả ──
R.report('PRICING ENGINE — 100+ TEST CASES')
for (const tc of cases) R.runCase(tc)
const ok = R.summary()
console.log(`\nĐã chạy ${cases.length} test case.`)
process.exit(ok ? 0 : 1)