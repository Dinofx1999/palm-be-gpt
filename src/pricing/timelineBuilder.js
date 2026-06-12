'use strict'
/**
 * ════════════════════════════════════════════════════════════════════════════
 * timelineBuilder.js — Dựng TIMELINE (dòng sự kiện) từ booking. THUẦN.
 *
 * Timeline = single source of truth về "chuyện gì đã/đang xảy ra" với booking:
 *
 *   check-in ──(transfer)── transfer ──(transfer)── … ── check-out
 *
 * Mọi nghiệp vụ (đặt phòng, đổi phòng, đổi ngày, đoàn, checkout sớm/muộn) đều
 * được biểu diễn bằng timeline. Engine KHÔNG cần biết nghiệp vụ — chỉ cần timeline.
 *
 * ĐẦU VÀO: một "stay" đã chuẩn hoá (1 phòng của booking lẻ, hoặc 1 sub-room đoàn):
 *   {
 *     roomNumber, policy, priceType, occupancy, capacity, isFreeRoom,
 *     plannedCheckIn: Date,         // giờ đặt
 *     actualCheckIn: Date | null,   // giờ nhận thực tế (null nếu chưa nhận)
 *     plannedCheckOut: Date,
 *     actualCheckOut: Date | null,
 *     status: 'reserved'|'confirmed'|'checked_in'|'checked_out'|'cancelled',
 *     transfers: [ { fromRoomNumber, toRoomNumber, transferAt: Date,
 *                    fromPolicy, toPolicy } ],   // đã sort tăng dần
 *   }
 *   viewMode: 'to-now' | 'to-checkout'
 *   now: Date            // mốc hiện tại (truyền vào — KHÔNG dùng Date.now() bên trong)
 *
 * ĐẦU RA: {
 *   events: [ { type:'check-in'|'transfer'|'check-out', at, roomNumber, ... } ],
 *   anchorCheckIn: Date,   // mốc bắt đầu tính (actualCheckIn ?? plannedCheckIn)
 *   anchorCheckOut: Date,  // mốc kết thúc tính (tuỳ viewMode)
 *   notCheckedIn: boolean,
 * }
 * ════════════════════════════════════════════════════════════════════════════
 */

function buildTimeline(stay, { viewMode = 'to-checkout', now, ctx } = {}) {
  const notCheckedIn = !stay.actualCheckIn &&
    (stay.status === 'reserved' || stay.status === 'confirmed' || stay.status == null)

  const anchorCheckIn = stay.actualCheckIn || stay.plannedCheckIn

  let anchorCheckOut
  if (stay.actualCheckOut) {
    anchorCheckOut = stay.actualCheckOut
  } else if (notCheckedIn) {
    anchorCheckOut = stay.plannedCheckOut
  } else if (viewMode === 'to-now') {
    const ref = now || stay.plannedCheckOut
    let co = ref < anchorCheckIn ? new Date(anchorCheckIn.getTime() + 60000) : ref
    // ⭐ GIÁ NGÀY + to-now:
    //   - Trong vòng tolerance kể từ khi nhận phòng → GIỮ đoạn ngắn (checkIn→now) để
    //     engine trả grace "Mới X phút — Miễn phí" (0đ). Áp dụng grace cho MỌI loại giá.
    //   - Quá tolerance → snap mốc kết thúc LÊN giờ trả chuẩn của đêm đang diễn ra
    //     (đã ở qua tolerance = đã bắt đầu đêm 1 → tính trọn đêm). Không vượt plannedCheckOut.
    if ((stay.priceType || 'day') === 'day' && ctx) {
      const tol = ctx.toleranceMinutes ?? 15
      const elapsedMin = (co.getTime() - anchorCheckIn.getTime()) / 60000
      if (elapsedMin > tol) {
        co = snapUpToNightCheckout(anchorCheckIn, co, stay, ctx)
        if (co.getTime() > stay.plannedCheckOut.getTime()) co = stay.plannedCheckOut
      }
      // else: giữ co = now (đoạn ≤ tolerance) → engine trả grace 0đ
    }
    anchorCheckOut = co
  } else {
    anchorCheckOut = stay.plannedCheckOut
  }

  const events = []
  events.push({ type: 'check-in', at: anchorCheckIn, roomNumber: firstRoomOf(stay) })

  const transfers = [...(stay.transfers || [])]
    .filter(t => t && t.transferAt)
    .sort((a, b) => a.transferAt.getTime() - b.transferAt.getTime())

  for (const t of transfers) {
    if (t.transferAt.getTime() <= anchorCheckOut.getTime()) {
      events.push({
        type: 'transfer', at: t.transferAt,
        fromRoomNumber: t.fromRoomNumber, toRoomNumber: t.toRoomNumber,
        fromPolicy: t.fromPolicy, toPolicy: t.toPolicy,
      })
    }
  }

  events.push({ type: 'check-out', at: anchorCheckOut })

  return { events, anchorCheckIn, anchorCheckOut, notCheckedIn }
}

const TT = require('./lib/timeUtils')
/**
 * Snap mốc "đến hiện tại" LÊN giờ trả chuẩn của đêm đang diễn ra (giá ngày).
 * Đã nhận phòng = đêm 1 đã bắt đầu → ít nhất tính tới giờ trả chuẩn hôm sau ngày nhận.
 */
function snapUpToNightCheckout(checkIn, now, stay, ctx) {
  const off = ctx.hotelUtcOffsetMinutes
  const coStdMin = TT.parseHHmm(stay.policy.dayCheckOutTime) ?? 720
  const dayEquivH = ctx.dayEquivalentHours ?? 23
  const ciDay = TT.dayIndex(checkIn, off)
  const ciMin = TT.minutesOfDay(checkIn, off)
  // ⭐ FIX (bug check-in rạng sáng tính 2 ngày ở "đến hiện tại"):
  //   Số "ngày tính giá" tới hiện tại đếm theo MỐC dayEquivalentHours (vd 23h) KỂ TỪ GIỜ
  //   NHẬN — KHÔNG theo mốc 12:00. Lý do: nhận rạng sáng (vd 00:17) mà đếm theo mốc 12:00
  //   thì chỉ cần qua 12:00 vài phút là bị đẩy mốc lên 12:00 NGÀY KẾ TIẾP, rồi
  //   computeDayNights cộng +1 đêm oan (mới ở vài giờ đã ra 2 ngày + đẻ segment tương lai).
  //   Đếm theo dayEquiv: chỉ +1 NGÀY khi khách thực sự ở đủ 1 "ngày" (23h) — khớp mọi loại
  //   giờ nhận (chiều / rạng sáng) và không tạo đêm tương lai.
  const elapsedHours = (now.getTime() - checkIn.getTime()) / 3600000
  const days = Math.max(1, Math.ceil(elapsedHours / dayEquivH))
  // Đêm 1 kết thúc tại giờ trả chuẩn NGAY SAU giờ nhận:
  //   - nhận TRƯỚC giờ trả (rạng sáng) → 12:00 CÙNG ngày nhận
  //   - nhận TỪ giờ trả trở đi (chiều)  → 12:00 ngày KẾ TIẾP
  const firstNightEndDay = (ciMin < coStdMin) ? ciDay : ciDay + 1
  const endDay = firstNightEndDay + (days - 1)
  return TT.atTimeOfDay(TT.addDays(checkIn, endDay - ciDay), coStdMin, off)
}

function firstRoomOf(stay) {
  const transfers = (stay.transfers || []).filter(t => t && t.transferAt)
    .sort((a, b) => a.transferAt.getTime() - b.transferAt.getTime())
  if (transfers.length > 0) return transfers[0].fromRoomNumber
  return stay.roomNumber
}

module.exports = { buildTimeline, firstRoomOf }