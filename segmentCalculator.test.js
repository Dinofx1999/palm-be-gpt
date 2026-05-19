/**
 * Test suite cho segmentCalculator.v23.js
 * Chạy: node segmentCalculator.test.js
 */

'use strict';

const {
  TRANSFER_MODES,
  closeOldSegment,
  openNewSegment,
  previewTransfer,
  countNightsForNewSegment,
  countNightsForOldSegment,
} = require('./segmentCalculator.js');

// ──────────────── Test helpers ────────────────
let passed = 0;
let failed = 0;
const failures = [];

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

function assertEqual(actual, expected, label) {
  if (actual === expected) return;
  throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function runTest(testFn, name) {
  try {
    testFn();
    console.log(`${GREEN}✓${RESET} ${name}`);
    passed++;
  } catch (err) {
    console.log(`${RED}✗${RESET} ${name}`);
    console.log(`  ${RED}${err.message}${RESET}`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

// ──────────────── Common fixtures ────────────────
const STANDARD_POLICY = {
  _id: 'pol-std',
  name: 'Standard Policy',
  dayPrice: 500000,
  hourSlots: [
    { time: '2', price: 100000 },
    { time: '3', price: 150000 },
    { time: '5', price: 200000 },
  ],
};

const DELUXE_POLICY = {
  _id: 'pol-deluxe',
  name: 'Deluxe Policy',
  dayPrice: 800000,
  hourSlots: [
    { time: '2', price: 150000 },
    { time: '3', price: 200000 },
    { time: '5', price: 300000 },
  ],
};

const VIP_POLICY = {
  _id: 'pol-vip',
  name: 'VIP Policy',
  dayPrice: 1200000,
  hourSlots: [
    { time: '2', price: 200000 },
    { time: '5', price: 400000 },
  ],
};

const STANDARD_602 = { _id: 'r602', number: '602', type: 'Standard', typeId: 'tid-std' };
const VIP_502 = { _id: 'r502', number: '502', type: 'VIP', typeId: 'tid-vip' };
const DELUXE_301 = { _id: 'r301', number: '301', type: 'Deluxe', typeId: 'tid-deluxe' };

const BRANCH_CONFIG = {
  checkInTime: '14:00',
  checkOutTime: '12:00',
};

const date = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1: Helpers — countNightsForNewSegment
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${CYAN}═══ SECTION 1: countNightsForNewSegment ═══${RESET}`);

runTest(() => {
  // Chuyển 17/05 08:00, CO 20/05 12:00
  // → dayStart(17/05)=17/05 00:00, dayStart(20/05)=20/05 00:00
  // → 3 đêm (17, 18, 19)
  const nights = countNightsForNewSegment(date(2026, 5, 17, 8), date(2026, 5, 20, 12));
  assertEqual(nights, 3, '17/05 08:00 → 20/05 12:00');
}, '17/05 08:00 → 20/05 12:00 = 3 đêm');

runTest(() => {
  // Chuyển 17/05 16:00 (chiều), CO 20/05 12:00 → vẫn 3 đêm (theo spec 5a)
  const nights = countNightsForNewSegment(date(2026, 5, 17, 16), date(2026, 5, 20, 12));
  assertEqual(nights, 3, '17/05 16:00 chiều → vẫn 3 đêm');
}, '17/05 16:00 → 20/05 12:00 = 3 đêm (giờ trong ngày không ảnh hưởng)');

runTest(() => {
  // Cùng ngày → 0 đêm
  const nights = countNightsForNewSegment(date(2026, 5, 17, 8), date(2026, 5, 17, 12));
  assertEqual(nights, 0, 'cùng ngày → 0 đêm');
}, 'Cùng ngày chuyển + checkout → 0 đêm');

runTest(() => {
  // 1 đêm: chuyển 17/05, CO 18/05
  const nights = countNightsForNewSegment(date(2026, 5, 17, 8), date(2026, 5, 18, 12));
  assertEqual(nights, 1, '17→18 = 1 đêm');
}, '17/05 → 18/05 = 1 đêm');

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2: Helpers — countNightsForOldSegment
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${CYAN}═══ SECTION 2: countNightsForOldSegment ═══${RESET}`);

runTest(() => {
  // Ở từ 15/05 14:00, chuyển 17/05 11:30 → dayStart 15 → dayStart 17 = 2 đêm
  const nights = countNightsForOldSegment(date(2026, 5, 15, 14), date(2026, 5, 17, 11, 30));
  assertEqual(nights, 2, '15→17 = 2 đêm');
}, '15/05 14:00 → 17/05 11:30 = 2 đêm');

runTest(() => {
  // Chuyển ngay trong ngày check-in → 0 đêm (fallback hourly)
  const nights = countNightsForOldSegment(date(2026, 5, 15, 14), date(2026, 5, 15, 17));
  assertEqual(nights, 0, 'same day = 0');
}, 'Cùng ngày CI → 0 đêm (fallback hourly)');

// ════════════════════════════════════════════════════════════════════════════
// SECTION 3: closeOldSegment
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${CYAN}═══ SECTION 3: closeOldSegment ═══${RESET}`);

runTest(() => {
  // Phòng 602 Standard, ở 15/05 14:00, chuyển 17/05 11:30
  // 2 đêm × 500k = 1.000k
  const result = closeOldSegment({
    oldSegment: { startAt: date(2026, 5, 15, 14), roomNumber: '602' },
    transferAt: date(2026, 5, 17, 11, 30),
    oldPolicy: STANDARD_POLICY,
  });
  assertEqual(result.amount, 1000000, 'amount');
  assertEqual(result.quantity, 2, 'nights');
  assertEqual(result.rateType, 'RATE_DAY', 'rateType');
}, 'closeOld 2 đêm Standard = 1M');

runTest(() => {
  // < 1 đêm: chuyển trong ngày → tính hourly
  // 15/05 14:00 → 15/05 18:00 = 4h → slot 5h = 200k
  const result = closeOldSegment({
    oldSegment: { startAt: date(2026, 5, 15, 14), roomNumber: '602' },
    transferAt: date(2026, 5, 15, 18),
    oldPolicy: STANDARD_POLICY,
  });
  assertEqual(result.rateType, 'RATE_HOURLY', 'rateType hourly');
  assertEqual(result.amount, 200000, 'amount slot 5h = 200k');
}, 'closeOld < 1 đêm → hourly slot');

// ════════════════════════════════════════════════════════════════════════════
// SECTION 4: openNewSegment — 4 modes
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${CYAN}═══ SECTION 4: openNewSegment (4 modes) ═══${RESET}`);

// MODE 1: KEEP_OLD_RATE
runTest(() => {
  // 602 Standard (500k) chuyển 605 cùng loại lúc 17/05 11:30, CO 20/05 12:00
  // Giữ giá Standard 500k × 3 đêm = 1.500k
  const seg = openNewSegment({
    transferMode: TRANSFER_MODES.KEEP_OLD_RATE,
    transferAt: date(2026, 5, 17, 11, 30),
    plannedCheckOut: date(2026, 5, 20, 12),
    newRoom: { _id: 'r605', number: '605', type: 'Standard', typeId: 'tid-std' },
    oldPolicy: STANDARD_POLICY,
    newPolicy: STANDARD_POLICY,
    sequenceNumber: 2,
  });
  assertEqual(seg.amount, 1500000, 'KEEP_OLD amount');
  assertEqual(seg.quantity, 3, '3 nights');
  assertEqual(seg.rateAmount, 500000, 'rateAmount = old');
  assertEqual(seg.policySource, 'old_room', 'policySource');
}, 'MODE KEEP_OLD_RATE: 602 Std → 605 Std giữ 500k × 3 = 1.5M');

runTest(() => {
  // 602 Standard 500k → 502 VIP nhưng GIỮ GIÁ CŨ (vì lỗi máy lạnh)
  // 500k × 3 đêm = 1.500k (không phải 1.200k × 3 = 3.6M dù chuyển sang VIP)
  const seg = openNewSegment({
    transferMode: TRANSFER_MODES.KEEP_OLD_RATE,
    transferAt: date(2026, 5, 17, 11, 30),
    plannedCheckOut: date(2026, 5, 20, 12),
    newRoom: VIP_502,
    oldPolicy: STANDARD_POLICY,
    newPolicy: VIP_POLICY,
    transferReason: 'Máy lạnh hỏng',
    sequenceNumber: 2,
  });
  assertEqual(seg.amount, 1500000, 'KEEP_OLD upgrade với giá cũ');
  assertEqual(seg.rateAmount, 500000, 'vẫn 500k của Standard');
}, 'MODE KEEP_OLD_RATE: upgrade Std→VIP nhưng giữ giá Std (lỗi máy lạnh)');

// MODE 2: USE_NEW_RATE
runTest(() => {
  // 602 Std 500k → 502 VIP 1.200k, chuyển 17/05 11:30, CO 20/05 12:00
  // Spec 5a: dùng "đêm lịch còn lại" → 3 đêm × 1.200k = 3.600k
  const seg = openNewSegment({
    transferMode: TRANSFER_MODES.USE_NEW_RATE,
    transferAt: date(2026, 5, 17, 11, 30),
    plannedCheckOut: date(2026, 5, 20, 12),
    newRoom: VIP_502,
    oldPolicy: STANDARD_POLICY,
    newPolicy: VIP_POLICY,
    sequenceNumber: 2,
  });
  assertEqual(seg.amount, 3600000, 'USE_NEW upgrade');
  assertEqual(seg.quantity, 3, '3 nights theo spec 5a');
  assertEqual(seg.rateAmount, 1200000, 'rateAmount = new');
  assertEqual(seg.policySource, 'new_room', 'policySource = new');
}, 'MODE USE_NEW_RATE: upgrade Std→VIP = 3 đêm × 1.2M = 3.6M');

runTest(() => {
  // Spec câu 5: chuyển 17/05 08:00 (sáng) → vẫn 3 đêm phòng mới × dayPrice
  const seg = openNewSegment({
    transferMode: TRANSFER_MODES.USE_NEW_RATE,
    transferAt: date(2026, 5, 17, 8),
    plannedCheckOut: date(2026, 5, 20, 12),
    newRoom: VIP_502,
    oldPolicy: STANDARD_POLICY,
    newPolicy: VIP_POLICY,
    sequenceNumber: 2,
  });
  assertEqual(seg.amount, 3600000, 'chuyển sáng vẫn 3 đêm × 1.2M');
  assertEqual(seg.quantity, 3, '3 nights');
}, 'MODE USE_NEW_RATE: chuyển sáng 08:00 → vẫn 3 đêm (không phụ thu CI sớm)');

runTest(() => {
  // Spec câu 5: chuyển 17/05 16:00 (chiều) → vẫn 3 đêm (cùng kết quả)
  const seg = openNewSegment({
    transferMode: TRANSFER_MODES.USE_NEW_RATE,
    transferAt: date(2026, 5, 17, 16),
    plannedCheckOut: date(2026, 5, 20, 12),
    newRoom: VIP_502,
    oldPolicy: STANDARD_POLICY,
    newPolicy: VIP_POLICY,
    sequenceNumber: 2,
  });
  assertEqual(seg.amount, 3600000, 'chuyển chiều vẫn 3 đêm × 1.2M');
}, 'MODE USE_NEW_RATE: chuyển chiều 16:00 → cùng kết quả (giờ không ảnh hưởng)');

// MODE 3: HOURLY_NEW_ROOM
runTest(() => {
  // Case 5 của user: 08:00 chuyển VIP, 12:00 CO = 4h × VIP slot 5h = 400k
  const seg = openNewSegment({
    transferMode: TRANSFER_MODES.HOURLY_NEW_ROOM,
    transferAt: date(2026, 5, 17, 8),
    plannedCheckOut: date(2026, 5, 17, 12),
    newRoom: VIP_502,
    oldPolicy: STANDARD_POLICY,
    newPolicy: VIP_POLICY,
    sequenceNumber: 2,
  });
  assertEqual(seg.rateType, 'RATE_HOURLY', 'rate hourly');
  assertEqual(seg.amount, 400000, 'slot 5h = 400k');
  assertEqual(seg.quantity, 4, '4 hours');
}, 'MODE HOURLY: 08:00 → 12:00 cùng ngày = slot 5h VIP = 400k');

// MODE 4: FREE
runTest(() => {
  // Miễn phí (lỗi KS) → amount = 0
  const seg = openNewSegment({
    transferMode: TRANSFER_MODES.FREE,
    transferAt: date(2026, 5, 17, 11, 30),
    plannedCheckOut: date(2026, 5, 20, 12),
    newRoom: VIP_502,
    oldPolicy: STANDARD_POLICY,
    newPolicy: VIP_POLICY,
    transferReason: 'Lỗi máy lạnh, compensate khách',
    sequenceNumber: 2,
  });
  assertEqual(seg.amount, 0, 'FREE amount = 0');
  assertEqual(seg.rateType, 'FREE', 'rateType FREE');
  assertEqual(seg.isCompensation, true, 'isCompensation = true');
}, 'MODE FREE: amount = 0, isCompensation = true');

// transferFee áp cho mọi mode
runTest(() => {
  const seg = openNewSegment({
    transferMode: TRANSFER_MODES.USE_NEW_RATE,
    transferAt: date(2026, 5, 17, 11, 30),
    plannedCheckOut: date(2026, 5, 20, 12),
    newRoom: VIP_502,
    oldPolicy: STANDARD_POLICY,
    newPolicy: VIP_POLICY,
    transferFee: 100000,
    sequenceNumber: 2,
  });
  assertEqual(seg.amount, 3600000, 'amount KHÔNG bao gồm fee');
  assertEqual(seg.transferFee, 100000, 'transferFee tách riêng');
}, 'transferFee: tách riêng khỏi amount');

// ════════════════════════════════════════════════════════════════════════════
// SECTION 5: previewTransfer — full workflow
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${CYAN}═══ SECTION 5: previewTransfer ═══${RESET}`);

runTest(() => {
  // CASE CHÍNH user: ở 5 ngày, ngày 2 upgrade
  // Booking: CI 15/05 14:00, CO 20/05 12:00
  // Segment 1 đang active: 602 Standard, startAt 15/05 14:00
  // Chuyển 16/05 10:00 sang 301 Deluxe (USE_NEW_RATE)
  //
  // Phòng cũ 602: 15/05 14:00 → 16/05 10:00 = 1 đêm × 500k = 500k
  // Phòng mới 301: 16/05 10:00 → 20/05 12:00 = 4 đêm × 800k = 3.200k
  // Tổng = 3.700k
  const booking = {
    _id: 'bk1',
    checkOut: date(2026, 5, 20, 12),
    totalAmount: 2500000,  // 5 đêm × 500k Standard (giá ban đầu trước move)
    servicesAmount: 0,
    discount: 0,
    discountPercent: 0,
    discountAmount: 0,
    isFreeRoom: false,
    segments: [
      {
        _id: 'seg1',
        sequenceNumber: 1,
        startAt: date(2026, 5, 15, 14),
        endAt: null,
        roomId: 'r602',
        roomNumber: '602',
        roomType: 'Standard',
        rateType: 'RATE_DAY',
        rateAmount: 500000,
        quantity: 5,
        amount: 2500000,
        transferFee: 0,
        status: 'active',
      },
    ],
  };

  const result = previewTransfer({
    booking,
    transferAt: date(2026, 5, 16, 10),
    transferMode: TRANSFER_MODES.USE_NEW_RATE,
    transferFee: 0,
    newRoom: DELUXE_301,
    oldPolicy: STANDARD_POLICY,
    newPolicy: DELUXE_POLICY,
    paidAmount: 0,
  });

  assertEqual(result.oldSegmentClosed.amount, 500000, 'old closed 1 night');
  assertEqual(result.newSegmentOpened.amount, 3200000, 'new 4 nights × 800k');
  assertEqual(result.totals.newTotalAmount, 3700000, 'new total');
  assertEqual(result.totals.allSegmentsAmount, 3700000, 'sum segments');
  assertEqual(result.requiresRefund, false, 'no refund needed');
}, 'PREVIEW CASE CHÍNH: 5 ngày, upgrade ngày 2 → 500k + 3.2M = 3.7M');

runTest(() => {
  // CASE downgrade khi đã trả ĐỦ → requiresRefund
  // Booking 5 đêm VIP × 1.2M = 6M, đã trả 6M
  // Chuyển sang Standard 500k, ngày 2 → 1.2M (cũ) + 4×500k (mới) = 3.2M
  // → paid (6M) > newTotal (3.2M) → refund 2.8M
  const booking = {
    _id: 'bk2',
    checkOut: date(2026, 5, 20, 12),
    totalAmount: 6000000,
    servicesAmount: 0, discount: 0, discountPercent: 0, discountAmount: 0,
    isFreeRoom: false,
    segments: [
      {
        _id: 'segA',
        sequenceNumber: 1,
        startAt: date(2026, 5, 15, 14),
        endAt: null,
        roomNumber: '502',
        roomType: 'VIP',
        rateType: 'RATE_DAY',
        rateAmount: 1200000,
        quantity: 5,
        amount: 6000000,
        transferFee: 0,
        status: 'active',
      },
    ],
  };

  const result = previewTransfer({
    booking,
    transferAt: date(2026, 5, 16, 10),
    transferMode: TRANSFER_MODES.USE_NEW_RATE,
    transferFee: 0,
    newRoom: STANDARD_602,
    oldPolicy: VIP_POLICY,
    newPolicy: STANDARD_POLICY,
    paidAmount: 6000000,
  });

  assertEqual(result.totals.newTotalAmount, 3200000, 'new total downgrade');
  assertEqual(result.requiresRefund, true, 'requires refund');
  assertEqual(result.totals.refundNeeded, 2800000, 'refund 2.8M');
}, 'PREVIEW DOWNGRADE: paid 6M, newTotal 3.2M → refundNeeded = 2.8M');

runTest(() => {
  // CASE FREE (lỗi KS): giữ tiền phòng cũ, phòng mới 0đ
  // Booking 5 đêm Standard 500k, đã trả 2.5M
  // Chuyển sang VIP ngày 2 nhưng FREE → giữ 500k cũ, 0đ mới
  // newTotal = 500k → paid 2.5M dư → refundNeeded = 2M
  const booking = {
    _id: 'bk3',
    checkOut: date(2026, 5, 20, 12),
    totalAmount: 2500000,
    servicesAmount: 0, discount: 0, discountPercent: 0, discountAmount: 0,
    isFreeRoom: false,
    segments: [
      {
        _id: 'segB',
        sequenceNumber: 1,
        startAt: date(2026, 5, 15, 14),
        endAt: null,
        roomNumber: '602',
        roomType: 'Standard',
        rateType: 'RATE_DAY',
        rateAmount: 500000,
        quantity: 5,
        amount: 2500000,
        transferFee: 0,
        status: 'active',
      },
    ],
  };

  const result = previewTransfer({
    booking,
    transferAt: date(2026, 5, 16, 10),
    transferMode: TRANSFER_MODES.FREE,
    transferFee: 0,
    newRoom: VIP_502,
    oldPolicy: STANDARD_POLICY,
    newPolicy: VIP_POLICY,
    transferReason: 'Phòng cũ bị thấm nước',
    paidAmount: 2500000,
  });

  assertEqual(result.oldSegmentClosed.amount, 500000, '1 đêm cũ');
  assertEqual(result.newSegmentOpened.amount, 0, 'FREE new');
  assertEqual(result.newSegmentOpened.isCompensation, true, 'compensation flag');
  assertEqual(result.totals.newTotalAmount, 500000, 'total = 500k');
  assertEqual(result.totals.refundNeeded, 2000000, 'refund 2M');
}, 'PREVIEW FREE: lỗi KS → giữ tiền cũ, phòng mới 0đ');

runTest(() => {
  // CASE upgrade KÈM phí 100k
  const booking = {
    _id: 'bk4',
    checkOut: date(2026, 5, 20, 12),
    totalAmount: 2500000,
    servicesAmount: 0, discount: 0, discountPercent: 0, discountAmount: 0,
    isFreeRoom: false,
    segments: [
      {
        _id: 'segC',
        sequenceNumber: 1,
        startAt: date(2026, 5, 15, 14),
        endAt: null,
        roomNumber: '602',
        roomType: 'Standard',
        rateType: 'RATE_DAY',
        rateAmount: 500000,
        quantity: 5,
        amount: 2500000,
        transferFee: 0,
        status: 'active',
      },
    ],
  };

  const result = previewTransfer({
    booking,
    transferAt: date(2026, 5, 16, 10),
    transferMode: TRANSFER_MODES.USE_NEW_RATE,
    transferFee: 100000,
    newRoom: DELUXE_301,
    oldPolicy: STANDARD_POLICY,
    newPolicy: DELUXE_POLICY,
    paidAmount: 0,
  });

  // Tiền phòng = 500k + 3.2M = 3.7M, + fee 100k = 3.8M
  assertEqual(result.totals.allSegmentsAmount, 3700000, 'room only');
  assertEqual(result.totals.allTransferFees, 100000, 'fee 100k');
  assertEqual(result.totals.newTotalAmount, 3800000, 'total with fee');
}, 'PREVIEW + fee 100k: newTotal = 3.7M + 100k = 3.8M');

// ════════════════════════════════════════════════════════════════════════════
// SECTION 6: Multi-transfer (A → B → C)
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${CYAN}═══ SECTION 6: Multi-transfer ═══${RESET}`);

runTest(() => {
  // Booking 7 ngày, chuyển 2 lần (sau lần 1 đã có segment 1 closed + segment 2 active)
  // Test: chuyển lần thứ 2 từ Deluxe 301 sang VIP 502
  //
  // Booking state trước lần move thứ 2:
  //   segments[0]: 602 Standard, 15/05 14:00 → 16/05 10:00 (closed), 1 đêm × 500k = 500k
  //   segments[1]: 301 Deluxe, 16/05 10:00 → null (active), tạm tính 6 đêm × 800k = 4.8M
  //
  // Chuyển lần 2: 18/05 10:00, USE_NEW_RATE, sang VIP 502
  // → close segment[1]: 16/05 10:00 → 18/05 10:00 = 2 đêm × 800k = 1.6M
  // → open segment[2]: 18/05 10:00 → 22/05 12:00 = 4 đêm × 1.2M = 4.8M
  // → Tổng tất cả = 500k (closed seg1) + 1.6M (closed seg2) + 4.8M (new seg3) = 6.9M

  const booking = {
    _id: 'bk-multi',
    checkOut: date(2026, 5, 22, 12),
    totalAmount: 5300000,  // sau lần move 1
    servicesAmount: 0, discount: 0, discountPercent: 0, discountAmount: 0,
    isFreeRoom: false,
    segments: [
      {
        _id: 'seg1', sequenceNumber: 1, status: 'closed',
        startAt: date(2026, 5, 15, 14), endAt: date(2026, 5, 16, 10),
        roomNumber: '602', roomType: 'Standard',
        rateType: 'RATE_DAY', rateAmount: 500000, quantity: 1, amount: 500000,
        transferFee: 0,
      },
      {
        _id: 'seg2', sequenceNumber: 2, status: 'active',
        startAt: date(2026, 5, 16, 10), endAt: null,
        roomNumber: '301', roomType: 'Deluxe',
        rateType: 'RATE_DAY', rateAmount: 800000, quantity: 6, amount: 4800000,
        transferFee: 0,
      },
    ],
  };

  const result = previewTransfer({
    booking,
    transferAt: date(2026, 5, 18, 10),
    transferMode: TRANSFER_MODES.USE_NEW_RATE,
    transferFee: 0,
    newRoom: VIP_502,
    oldPolicy: DELUXE_POLICY,
    newPolicy: VIP_POLICY,
    paidAmount: 0,
  });

  // closed seg2: 16/05 10:00 → 18/05 10:00 = 2 đêm × 800k = 1.6M
  assertEqual(result.oldSegmentClosed.amount, 1600000, 'close seg2');
  assertEqual(result.oldSegmentClosed.quantity, 2, 'seg2 nights');

  // new seg3: 18/05 → 22/05 = 4 đêm × 1.2M = 4.8M
  assertEqual(result.newSegmentOpened.amount, 4800000, 'new seg3');
  assertEqual(result.newSegmentOpened.quantity, 4, 'seg3 nights');
  assertEqual(result.newSegmentOpened.sequenceNumber, 3, 'sequence 3');

  // Tổng: 500k (seg1) + 1.6M (seg2 closed) + 4.8M (seg3 new) = 6.9M
  assertEqual(result.totals.allSegmentsAmount, 6900000, 'total all segments');
}, 'MULTI-TRANSFER: 7 ngày, 2 lần move A→B→C = 6.9M');

// ════════════════════════════════════════════════════════════════════════════
// SECTION 7: Edge cases
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${CYAN}═══ SECTION 7: Edge cases ═══${RESET}`);

runTest(() => {
  // Case 5 spec user: 08:00 chuyển, 12:00 checkout → mode HOURLY
  // Nếu lễ tân vô tình chọn USE_NEW_RATE → 0 đêm, có warning
  const seg = openNewSegment({
    transferMode: TRANSFER_MODES.USE_NEW_RATE,
    transferAt: date(2026, 5, 17, 8),
    plannedCheckOut: date(2026, 5, 17, 12),
    newRoom: VIP_502,
    oldPolicy: STANDARD_POLICY,
    newPolicy: VIP_POLICY,
    sequenceNumber: 2,
  });
  assertEqual(seg.quantity, 0, '0 nights');
  assertEqual(seg.amount, 0, 'amount = 0');
  // Có warning trong breakdown
  const hasWarning = seg.breakdown.some(b => b.meta?.warning === 'zero-nights');
  assertEqual(hasWarning, true, 'has warning');
}, 'Edge: USE_NEW_RATE cùng ngày CO → 0 đêm + warning suggest HOURLY');

runTest(() => {
  // Invalid mode
  let thrown = false;
  try {
    openNewSegment({
      transferMode: 'INVALID',
      transferAt: date(2026, 5, 17, 10),
      plannedCheckOut: date(2026, 5, 20, 12),
      newRoom: VIP_502,
      oldPolicy: STANDARD_POLICY,
      newPolicy: VIP_POLICY,
      sequenceNumber: 2,
    });
  } catch (e) {
    thrown = true;
  }
  if (!thrown) throw new Error('Should throw for invalid mode');
}, 'Edge: invalid transferMode → throw');

runTest(() => {
  // Phòng mới không có hourSlots, mode HOURLY → fallback dayPrice
  const noHourlyPolicy = { _id: 'p', name: 'NoHourly', dayPrice: 1000000, hourSlots: [] };
  const seg = openNewSegment({
    transferMode: TRANSFER_MODES.HOURLY_NEW_ROOM,
    transferAt: date(2026, 5, 17, 8),
    plannedCheckOut: date(2026, 5, 17, 12),
    newRoom: VIP_502,
    oldPolicy: STANDARD_POLICY,
    newPolicy: noHourlyPolicy,
    sequenceNumber: 2,
  });
  assertEqual(seg.rateType, 'RATE_DAY', 'fallback rateType');
  assertEqual(seg.amount, 1000000, 'fallback dayPrice');
  const hasFallback = seg.breakdown.some(b => b.meta?.fallback);
  assertEqual(hasFallback, true, 'has fallback meta');
}, 'Edge: HOURLY mode + không có hourSlots → fallback dayPrice + warning');

// ════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${CYAN}═══ TEST SUMMARY ═══${RESET}`);
console.log(`${GREEN}Passed: ${passed}${RESET}`);
console.log(`${failed > 0 ? RED : GREEN}Failed: ${failed}${RESET}`);

if (failed > 0) {
  console.log(`\n${RED}FAILURES:${RESET}`);
  failures.forEach(f => {
    console.log(`  ${RED}✗ ${f.name}${RESET}`);
    console.log(`    ${f.error}`);
  });
  process.exit(1);
}