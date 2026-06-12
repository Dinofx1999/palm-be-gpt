'use strict'
/**
 * ════════════════════════════════════════════════════════════════════════════
 * pricingAdapter.js — CẦU NỐI giữa booking Mongo (Mongoose doc) và engine thuần.
 *
 * Engine trong /pricing là PURE (không đọc DB). File này (KHÔNG thuần — biết schema
 * của bạn) chuyển booking Mongo → "stay"/"booking" mà engine hiểu, rồi gọi engine.
 *
 * Đây là file DUY NHẤT controller cần require để tính tiền:
 *
 *   const { priceBookingDoc, priceBookingToNow } = require('../pricing/pricingAdapter')
 *
 *   const inv = priceBookingDoc(booking, { branch })       // hoá đơn đến khi trả
 *   const now = priceBookingToNow(booking, { branch })     // hoá đơn đến hiện tại
 *
 *   // inv.totalAmount, inv.roomAmount, inv.remainingAmount, inv.breakdown, inv.perRoom
 *
 * Controller KHÔNG tự cộng roomAmount, KHÔNG tự dựng breakdown nữa.
 * ════════════════════════════════════════════════════════════════════════════
 */

const { priceStay, priceBooking, DEFAULT_CTX } = require('./index')

/**
 * Tạo ctx từ branch config (giờ chuẩn, tolerance...). Mọi quy tắc nghiệp vụ ở đây.
 */
function ctxFromBranch(branch) {
  return {
    hotelUtcOffsetMinutes: (branch && branch.hotelUtcOffsetMinutes) != null
      ? branch.hotelUtcOffsetMinutes
      : 7 * 60,                                   // Asia/Ho_Chi_Minh (KHÔNG dùng giờ server)
    toleranceMinutes:      (branch && branch.toleranceMinutes)      ?? 15,
    dayEquivalentHours:    (branch && branch.dayEquivalentHours)    ?? 23,
    earlyCheckinUntilHour: (branch && branch.earlyCheckinUntil)     ?? 5,
  }
}

/** Lấy sức chứa từ policySnapshot. */
function capacityFromPolicy(pol) {
  const cap = pol && pol.capacity != null ? pol.capacity : 2
  return {
    maxAdults:    pol && pol.maxAdults    != null ? pol.maxAdults    : cap,
    maxChildren:  pol && pol.maxChildren  != null ? pol.maxChildren  : 0,
    maxOccupancy: pol && pol.maxOccupancy != null ? pol.maxOccupancy : cap,
  }
}

function asDate(v) {
  if (!v) return null
  return v instanceof Date ? v : new Date(v)
}

/**
 * Chuyển 1 phòng (booking lẻ hoặc 1 sub-room của đoàn) → "stay" cho engine.
 *
 * @param src  booking lẻ HOẶC sub-room object
 * @param base booking cha (để lấy field chung khi src là sub-room)
 * @param opts { resolvePolicy?: (policyId) => policySnapshot }  // để đổi-giá qua nhiều chặng
 */
function toStay(src, base, opts = {}) {
  base = base || src
  const policySnapshot = src.policySnapshot || base.policySnapshot
  const resolve = typeof opts.resolvePolicy === 'function' ? opts.resolvePolicy : null

  const transfers = (src.transferHistory || base.transferHistory || [])
    .filter(t => t && (t.transferAt))
    .map(t => {
      // policy của phòng đi/đến từng chặng:
      //  - ưu tiên snapshot lưu kèm transfer (nếu bạn đã lưu fromPolicySnapshot/toPolicySnapshot)
      //  - nếu chỉ có policyId → dùng resolvePolicy (nếu controller truyền vào)
      //  - fallback: policySnapshot hiện tại (đúng cho "giữ giá" và khi phòng cũ bị drop)
      const fromPolicy = t.fromPolicySnapshot
        || (resolve && t.oldPolicyId && resolve(t.oldPolicyId))
        || policySnapshot
      const toPolicy = t.toPolicySnapshot
        || (resolve && t.newPolicyId && resolve(t.newPolicyId))
        || policySnapshot
      return {
        fromRoomNumber: t.fromRoomNumber,
        toRoomNumber:   t.toRoomNumber,
        transferAt:     asDate(t.transferAt),
        fromPolicy, toPolicy,
      }
    })

  return {
    roomNumber: src.roomNumber,
    priceType:  src.priceType || base.priceType || 'day',
    policy:     policySnapshot,
    occupancy:  { adults: src.adults ?? base.adults ?? 2, children: src.children ?? base.children ?? 0 },
    capacity:   capacityFromPolicy(policySnapshot),
    isFreeRoom: !!(src.isFreeRoom ?? base.isFreeRoom),
    customRoomPrice: src.customRoomPrice ?? undefined,
    status:     src.status || base.status,
    plannedCheckIn:  asDate(src.checkIn  || base.checkIn),
    actualCheckIn:   asDate(src.actualCheckIn  || base.actualCheckIn),
    plannedCheckOut: asDate(src.checkOut || base.checkOut),
    actualCheckOut:  asDate(src.actualCheckOut || base.actualCheckOut),
    transfers,
  }
}

/** Booking lẻ hay đoàn? → trả mảng stays. */
function staysOf(booking, opts) {
  const subRooms = booking.rooms && booking.rooms.length > 0 ? booking.rooms : null
  if (booking.isGroup && subRooms) {
    return subRooms.map(r => toStay(r, booking, opts))
  }
  return [toStay(booking, booking, opts)]
}

/**
 * HÀM CHÍNH cho controller — hoá đơn "đến khi trả phòng".
 * Trả invoice đầy đủ (đã gồm dịch vụ/chiết khấu/phí/đã trả).
 */
function priceBookingDoc(booking, opts = {}) {
  const ctx = ctxFromBranch(opts.branch)
  const stays = staysOf(booking, opts)
  return priceBooking({
    isGroup: !!booking.isGroup,
    stays,
    servicesAmount:  booking.servicesAmount  || 0,
    discountPercent: booking.discountPercent || 0,
    discountAmount:  booking.discountAmount  || 0,
    transferFee:     booking.transferFee     || 0,
    paidAmount:      booking.paidAmount       || booking.depositAmount || 0,
    isFreeRoom:      !!booking.isFreeRoom,
  }, { viewMode: 'to-checkout', ctx })
}

/** Hoá đơn "đến hiện tại" (tab tính tạm). now mặc định = thời điểm gọi. */
function priceBookingToNow(booking, opts = {}) {
  const ctx = ctxFromBranch(opts.branch)
  const stays = staysOf(booking, opts)
  return priceBooking({
    isGroup: !!booking.isGroup,
    stays,
    servicesAmount:  booking.servicesAmount  || 0,
    discountPercent: booking.discountPercent || 0,
    discountAmount:  booking.discountAmount  || 0,
    transferFee:     booking.transferFee     || 0,
    paidAmount:      booking.paidAmount       || booking.depositAmount || 0,
    isFreeRoom:      !!booking.isFreeRoom,
  }, { viewMode: 'to-now', now: opts.now || new Date(), ctx })
}

/**
 * Tính riêng 1 phòng (lẻ) — trả { roomAmount, breakdown, nights }.
 * Dùng khi chỉ cần số tiền phòng (chưa gồm dịch vụ/chiết khấu).
 */
function priceRoomDoc(booking, opts = {}) {
  const ctx = ctxFromBranch(opts.branch)
  const stay = toStay(booking, booking, opts)
  return priceStay(stay, {
    viewMode: opts.viewMode || 'to-checkout',
    now: opts.now, ctx,
    customRoomPrice: booking.customRoomPrice,
  })
}

module.exports = {
  priceBookingDoc,     // hoá đơn đầy đủ, đến khi trả phòng
  priceBookingToNow,   // hoá đơn đầy đủ, đến hiện tại
  priceRoomDoc,        // tiền 1 phòng
  toStay, ctxFromBranch, // export phụ để test/độ phủ
}