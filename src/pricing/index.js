'use strict'
/**
 * ════════════════════════════════════════════════════════════════════════════
 * index.js — API CÔNG KHAI của pricing engine. THUẦN, DETERMINISTIC.
 *
 * Đây là CỬA DUY NHẤT controller được phép gọi để tính tiền. Controller KHÔNG
 * bao giờ tự cộng roomAmount hay tự dựng breakdown.
 *
 *   priceStay(stay, opts)      → tính tiền 1 phòng (booking lẻ / 1 sub-room)
 *   priceBooking(booking, opts)→ tính tiền cả booking (lẻ hoặc đoàn nhiều phòng)
 *
 * Pipeline:  Timeline → Segments → PricingEngine(mỗi segment) → Breakdown → Invoice
 *
 * opts = {
 *   viewMode: 'to-now' | 'to-checkout',
 *   now: Date,                      // BẮT BUỘC khi to-now (pure: không Date.now())
 *   ctx: { hotelUtcOffsetMinutes, toleranceMinutes, dayEquivalentHours,
 *          earlyCheckinUntilHour },
 *   customRoomPrice?: number,       // giá tự nhập (override) cho stay
 * }
 * ════════════════════════════════════════════════════════════════════════════
 */

const { buildTimeline } = require('./timelineBuilder')
const { buildSegments } = require('./segmentBuilder')
const { priceSegment } = require('./pricingEngine')
const { buildInvoice } = require('./invoiceBuilder')
const T = require('./lib/timeUtils')

const DEFAULT_CTX = {
  hotelUtcOffsetMinutes: 7 * 60,  // UTC+7 (Asia/Ho_Chi_Minh, không DST)
  toleranceMinutes: 15,
  dayEquivalentHours: 23,
  earlyCheckinUntilHour: 5,
}

function resolveCtx(ctx) {
  return { ...DEFAULT_CTX, ...(ctx || {}) }
}

/** Tính tiền 1 phòng (stay). Trả breakdown + roomAmount + segments + meta. */
function priceStay(stay, opts = {}) {
  const ctx = resolveCtx(opts.ctx)
  const segCtx = { ...ctx, customRoomPrice: opts.customRoomPrice }
  // ⭐ Tab "đến hiện tại": nhãn dòng cuối hiển thị GIỜ XEM THẬT (now) thay vì giờ trả
  //   chuẩn đã snap (tránh nhầm "tính tới tương lai"). Số tiền KHÔNG đổi (trọn đêm).
  if ((opts.viewMode === 'to-now') && opts.now) segCtx.displayEndAt = opts.now
  const timeline = buildTimeline(stay, { viewMode: opts.viewMode || 'to-checkout', now: opts.now, ctx })
  const segments = buildSegments(stay, timeline, ctx)

  const breakdown = []
  const errors = []
  let nights = 0
  for (const seg of segments) {
    const r = priceSegment(seg, segCtx)
    if (r.error) { errors.push({ roomNumber: seg.roomNumber, error: r.error }); continue }
    breakdown.push(...r.lines)
    nights += r.nights
  }

  const roomAmount = breakdown.reduce((s, l) => s + (Number(l.amount) || 0), 0)
  return {
    roomNumber: stay.roomNumber,
    breakdown,
    roomAmount: T.roundMoney(roomAmount),
    nights,
    notCheckedIn: timeline.notCheckedIn,
    anchorCheckIn: timeline.anchorCheckIn,
    anchorCheckOut: timeline.anchorCheckOut,
    errors,
  }
}

/**
 * Tính tiền cả booking.
 * booking = {
 *   isGroup, stays: [stay],   // lẻ: stays=[1 stay]; đoàn: nhiều stay
 *   servicesAmount, discountPercent, discountAmount, transferFee, paidAmount, isFreeRoom,
 * }
 */
function priceBooking(booking, opts = {}) {
  const stays = (booking.stays || []).filter(s => s && s.status !== 'cancelled')
  const allBreakdown = []
  const perRoom = []
  let nights = 0

  for (const stay of stays) {
    const r = priceStay(stay, { ...opts, customRoomPrice: stay.customRoomPrice })
    allBreakdown.push(...r.breakdown)
    perRoom.push({ roomNumber: r.roomNumber, roomAmount: r.roomAmount, breakdown: r.breakdown })
    nights = Math.max(nights, r.nights)
  }

  const invoice = buildInvoice({
    breakdown: allBreakdown,
    servicesAmount: booking.servicesAmount,
    discountPercent: booking.discountPercent,
    discountAmount: booking.discountAmount,
    transferFee: booking.transferFee,
    paidAmount: booking.paidAmount,
    isFreeRoom: booking.isFreeRoom,
  })

  return { ...invoice, perRoom, nights }
}

module.exports = {
  priceStay,
  priceBooking,
  DEFAULT_CTX,
  // re-export để test/độ phủ
  _internals: { buildTimeline, buildSegments, priceSegment, buildInvoice },
}