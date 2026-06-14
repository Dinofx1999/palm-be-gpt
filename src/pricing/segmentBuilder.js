'use strict'
/**
 * ════════════════════════════════════════════════════════════════════════════
 * segmentBuilder.js — Biến TIMELINE → các SEGMENT để tính tiền. THUẦN.
 *
 * Nơi DUY NHẤT áp quy tắc ranh giới chặng ở (đổi phòng) → cả hệ thống NHẤT QUÁN.
 *
 * MÔ HÌNH "PHÂN BỔ ĐÊM" cho GIÁ NGÀY (sửa gốc rễ đếm dư đêm khi đổi giữa chừng):
 *   - Cả kỳ ở có N "đêm tính giá", mỗi đêm = [giờ nhận chuẩn → giờ trả chuẩn hôm sau].
 *   - Mỗi đêm thuộc về phòng mà khách ĐANG Ở khi đêm đó diễn ra.
 *   - Phòng cũ ở ≤ tolerance (đổi gần như ngay) → KHÔNG nhận đêm nào (drop).
 *
 * QUY TẮC:
 *   R1. Chặng phòng cũ ≤ tolerance → drop.
 *   R2. Chặng không phải đầu → suppress nhận sớm.
 *   R3. Chặng không phải cuối → suppress trả muộn.
 *   R4. Chưa nhận phòng + transfer → chỉ phòng đích cuối.
 * ════════════════════════════════════════════════════════════════════════════
 */

const T = require('./lib/timeUtils')

function buildSegments(stay, timeline, ctx) {
  const { events, anchorCheckIn, anchorCheckOut, notCheckedIn } = timeline
  const transfers = events.filter(e => e.type === 'transfer')

  if (notCheckedIn && transfers.length > 0) {
    const last = transfers[transfers.length - 1]
    return [makeSegment({
      stay, ctx, roomNumber: last.toRoomNumber, policy: last.toPolicy || stay.policy,
      startAt: anchorCheckIn, endAt: anchorCheckOut,
      isFirst: true, isLast: true, isTransferLeg: false,
    })]
  }

  if (transfers.length === 0) {
    return [makeSegment({
      stay, ctx, roomNumber: stay.roomNumber, policy: stay.policy,
      startAt: anchorCheckIn, endAt: anchorCheckOut,
      isFirst: true, isLast: true, isTransferLeg: false,
    })]
  }

  if ((stay.priceType || 'day') !== 'day') {
    return buildSimpleTransferSegments(stay, timeline, ctx, transfers)
  }
  return buildDayTransferSegments(stay, timeline, ctx, transfers)
}

function buildDayTransferSegments(stay, timeline, ctx, transfers) {
  const { anchorCheckIn, anchorCheckOut } = timeline
  const off = ctx.hotelUtcOffsetMinutes
  const tol = ctx.toleranceMinutes
  const policy0 = stay.policy

  // ⭐ "Nuốt" các transfer xảy ra trong vòng tolerance kể từ giờ nhận: khách chưa thực
  //   sự ở phòng cũ → coi như bắt đầu kỳ ở ngay tại phòng ĐÍCH của transfer cuối-trong-tolerance.
  let effTransfers = transfers
  let effCheckIn = anchorCheckIn
  {
    let cutIdx = -1
    for (let i = 0; i < transfers.length; i++) {
      const since = T.diffMinutes(anchorCheckIn, transfers[i].at)
      if (since <= tol) cutIdx = i
      else break
    }
    if (cutIdx >= 0) {
      // phòng bắt đầu = phòng đích của transfer[cutIdx]; bỏ các transfer ≤ tolerance
      const settle = transfers[cutIdx]
      effTransfers = transfers.slice(cutIdx + 1)
      // tạo "transfer ảo" để roomAt biết phòng khởi điểm là settle.toRoomNumber
      effTransfers = [{ at: anchorCheckIn, fromRoomNumber: settle.toRoomNumber, toRoomNumber: settle.toRoomNumber, fromPolicy: settle.toPolicy, toPolicy: settle.toPolicy }, ...effTransfers]
    }
  }
  // Nếu sau khi nuốt chỉ còn 1 phòng (không transfer thật) → trả 1 segment phòng đó.
  const realTransfers = effTransfers.filter(t => t.fromRoomNumber !== t.toRoomNumber)
  if (realTransfers.length === 0) {
    const only = effTransfers[0]
    return [makeSegment({
      stay, ctx, roomNumber: only.toRoomNumber, policy: only.toPolicy || policy0,
      startAt: effCheckIn, endAt: anchorCheckOut,
      isFirst: true, isLast: true, isTransferLeg: false,
    })]
  }
  transfers = effTransfers

  // ⭐ Rule 3 (14/06/2026): ĐỔI PHÒNG XONG TRẢ LUÔN TRONG NGÀY (mục XIII).
  //   Nếu cả kỳ ở (sau khi nuốt tolerance) nằm GỌN trong 1 ngày-lịch KS và có transfer
  //   thật → phòng đầu chỉ tính phụ thu nhận sớm (không base), phòng CUỐI tính GIÁ GIỜ:
  //     - transferAt < giờ trả chuẩn (12:00) → giờ từ transferAt → checkout
  //     - transferAt ≥ 12:00                 → giờ từ 12:00      → checkout
  //   KHÔNG tính nguyên giá ngày cho phòng mới.
  {
    const ciDay = T.dayIndex(effCheckIn, off)
    const coDay = T.dayIndex(anchorCheckOut, off)
    if (ciDay === coDay) {
      const coStd = T.parseHHmm(policy0.dayCheckOutTime) ?? 720
      const lastT = transfers[transfers.length - 1]
      const transferMin = T.minutesOfDay(lastT.at, off)
      const hourStart = transferMin < coStd
        ? lastT.at
        : T.atTimeOfDay(anchorCheckOut, coStd, off)
      const out = []
      // Phòng ĐẦU: chỉ giữ để tính phụ thu nhận sớm (segment độ dài 0 → engine bỏ base,
      //   vẫn chạy nhánh early). isLast=false để suppress trả muộn phòng đầu.
      const firstRoom = transfers[0].fromRoomNumber
      const firstPol = transfers[0].fromPolicy || policy0
      out.push(makeSegment({
        stay, ctx, roomNumber: firstRoom, policy: firstPol,
        startAt: effCheckIn, endAt: effCheckIn,           // độ dài 0 → không base ngày
        isFirst: true, isLast: false, isTransferLeg: true,
        forceEarlyOnly: true,
      }))
      // Phòng CUỐI: giá GIỜ từ hourStart → checkout.
      const lastRoom = lastT.toRoomNumber
      const lastPol = lastT.toPolicy || policy0
      out.push(makeSegment({
        stay, ctx, roomNumber: lastRoom, policy: lastPol,
        startAt: hourStart, endAt: anchorCheckOut,
        isFirst: false, isLast: true, isTransferLeg: false,
        forcePriceType: 'hour',
      }))
      return out
    }
  }

  const ciStdMin = T.parseHHmm(policy0.dayCheckInTime) ?? 840
  const coStdMin = T.parseHHmm(policy0.dayCheckOutTime) ?? 720
  const earlyUntilMin = (ctx.earlyCheckinUntilHour ?? 5) * 60
  const dayEquivMin = (ctx.dayEquivalentHours ?? 23) * 60

  const startMin = T.minutesOfDay(anchorCheckIn, off)
  const endMin = T.minutesOfDay(anchorCheckOut, off)
  const startDay = T.dayIndex(anchorCheckIn, off)
  const endDay = T.dayIndex(anchorCheckOut, off)
  const sameDay = startDay === endDay
  const isEarlyMorning = startMin <= earlyUntilMin

  let nights = sameDay ? 0 : (endDay - startDay)
  let effectiveNights = nights
  if (!sameDay && isEarlyMorning) effectiveNights += 1
  if (sameDay && isEarlyMorning && endMin >= dayEquivMin) effectiveNights += 1
  if (!sameDay && endMin >= dayEquivMin) effectiveNights += 1
  if (effectiveNights < 1) effectiveNights = 1

  const earlyShift = (!sameDay && isEarlyMorning) ? 1 : 0
  const nightStartAt = (i) => {
    if (i === 0) return anchorCheckIn
    const dayBase = T.atTimeOfDay(anchorCheckIn, ciStdMin, off)
    return T.atTimeOfDay(T.addDays(dayBase, i - earlyShift), ciStdMin, off)
  }

  const firstRoom = transfers[0].fromRoomNumber
  const roomAt = (instant) => {
    let room = firstRoom, pol = transfers[0].fromPolicy || policy0
    for (const t of transfers) {
      if (t.at.getTime() <= instant.getTime()) { room = t.toRoomNumber; pol = t.toPolicy || policy0 }
    }
    return { room, policy: pol }
  }

  // ⭐ Gán đêm cho phòng khách NGỦ qua đêm = phòng đang ở lúc NỬA ĐÊM (00:00) của đêm đó.
  //   - Đổi buổi tối (trước 00:00) → khách ngủ phòng MỚI → đêm tính phòng mới.
  //   - Đổi rạng sáng (sau 00:00, vd 03:00) → khách đã ngủ phòng CŨ → đêm tính phòng cũ.
  //   "Đêm i" kết thúc vào giờ trả chuẩn của ngày (ciDay + i + 1 − earlyShift); nửa đêm
  //   trong đêm đó = 00:00 của chính ngày kết thúc.
  const sleepInstantOf = (i) =>
    T.atTimeOfDay(T.addDays(anchorCheckIn, i + 1 - earlyShift), 0, off)

  const segs = []
  for (let i = 0; i < effectiveNights; i++) {
    const inst = sleepInstantOf(i)
    const { room, policy } = roomAt(inst)
    const last = segs[segs.length - 1]
    if (last && last.roomNumber === room) {
      last.nights += 1
    } else {
      segs.push({ roomNumber: room, policy, firstNightIndex: i, nights: 1 })
    }
  }

  const built = segs.map((sg, idx) => {
    const isFirst = idx === 0
    const isLast = idx === segs.length - 1
    const segStart = isFirst ? anchorCheckIn : nightStartAt(sg.firstNightIndex)
    let segEnd
    if (isLast) {
      segEnd = anchorCheckOut
    } else {
      const lastNightIdx = sg.firstNightIndex + sg.nights - 1
      const nextNightStart = nightStartAt(lastNightIdx + 1)
      segEnd = T.atTimeOfDay(nextNightStart, coStdMin, off)
    }
    return makeSegment({
      stay, ctx, roomNumber: sg.roomNumber, policy: sg.policy,
      startAt: segStart, endAt: segEnd,
      isFirst, isLast, isTransferLeg: !isLast,
      forcedNights: sg.nights,
    })
  })

  return built.filter((s, idx) => {
    if (idx === built.length - 1) return true
    const dur = T.diffMinutes(s.startAt, s.endAt)
    return dur > tol
  })
}

function buildSimpleTransferSegments(stay, timeline, ctx, transfers) {
  const { anchorCheckIn, anchorCheckOut } = timeline
  const tol = ctx.toleranceMinutes
  const raw = []
  let start = anchorCheckIn
  for (const t of transfers) {
    raw.push({ roomNumber: t.fromRoomNumber, policy: t.fromPolicy || stay.policy, startAt: start, endAt: t.at, leg: true })
    start = t.at
  }
  raw.push({ roomNumber: transfers[transfers.length - 1].toRoomNumber, policy: transfers[transfers.length - 1].toPolicy || stay.policy, startAt: start, endAt: anchorCheckOut, leg: false })
  const kept = raw.filter((s, idx) => idx === raw.length - 1 || T.diffMinutes(s.startAt, s.endAt) > tol)
  return kept.map((s, idx) => makeSegment({
    stay, ctx, roomNumber: s.roomNumber, policy: s.policy, startAt: s.startAt, endAt: s.endAt,
    isFirst: idx === 0, isLast: idx === kept.length - 1, isTransferLeg: s.leg,
  }))
}

function makeSegment({ stay, ctx, roomNumber, policy, startAt, endAt, isFirst, isLast, isTransferLeg, forcedNights, forcePriceType, forceEarlyOnly }) {
  return {
    roomNumber,
    priceType: forcePriceType || stay.priceType || 'day',
    policy,
    occupancy: stay.occupancy || { adults: 2, children: 0 },
    capacity: stay.capacity || { maxAdults: 2, maxChildren: 0, maxOccupancy: 2 },
    isFreeRoom: !!stay.isFreeRoom,
    startAt, endAt,
    suppressEarlyCheckIn: !isFirst,
    suppressLateCheckOut: !isLast,
    isTransferLeg,
    forcedNights,
    forceEarlyOnly: !!forceEarlyOnly,
  }
}

module.exports = { buildSegments }