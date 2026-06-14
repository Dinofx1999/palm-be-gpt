'use strict'
/**
 * ════════════════════════════════════════════════════════════════════════════
 * pricingEngine.js — ENGINE TÍNH TIỀN DUY NHẤT (Single Source of Truth)
 *
 * Trách nhiệm: tính tiền cho ĐÚNG MỘT "segment" = một lần ở liền mạch trong MỘT
 * phòng với MỘT chính sách giá. Mọi nghiệp vụ (đặt phòng, đổi phòng, đổi ngày,
 * đoàn, checkout sớm/muộn) đều được quy về danh sách segment rồi gọi hàm này.
 *
 * KHÔNG có bất kỳ logic tính tiền nào nằm ngoài file này.
 *
 * ĐẦU VÀO (pure — không DB, không Date.now()):
 *   priceSegment(segment, ctx) trong đó:
 *     segment = {
 *       roomNumber, priceType: 'day'|'night'|'hour',
 *       policy: { dayPrice, dayCheckInTime, dayCheckOutTime, dayEarlyCheckIn[],
 *                 dayLateCheckOut[], dayAdultSurcharge, dayChildSurcharge,
 *                 hourSlots[], nightPrice, nightCheckInTime, nightCheckOutTime },
 *       occupancy: { adults, children },
 *       capacity:  { maxAdults, maxChildren, maxOccupancy },
 *       startAt: Date, endAt: Date,
 *       isFreeRoom?: boolean,
 *       // Ngữ cảnh segment để áp quy tắc NHẤT QUÁN (đây là điểm sửa lỗi gốc):
 *       suppressEarlyCheckIn?: boolean,  // chặng giữa do đổi phòng → không phụ thu nhận sớm
 *       suppressLateCheckOut?: boolean,  // chặng không phải cuối → không phụ thu trả muộn
 *       isTransferLeg?: boolean,         // segment sinh ra do đổi phòng
 *     }
 *     ctx = { hotelUtcOffsetMinutes, toleranceMinutes, dayEquivalentHours,
 *             earlyCheckinUntilHour, customRoomPrice? }
 *
 * ĐẦU RA:
 *   {
 *     lines: [ { kind, roomNumber, label, amount, startAt, endAt, meta } ],
 *     roomAmount,   // === Σ lines.amount  (BẤT BIẾN — không bao giờ lệch)
 *     nights,
 *     error?: { code, message },
 *   }
 *
 * BẤT BIẾN THEN CHỐT (kills cả lớp bug "roomAmount ≠ Σbreakdown"):
 *   roomAmount LUÔN = tổng amount của lines. Không có đường nào tính riêng.
 * ════════════════════════════════════════════════════════════════════════════
 */

const T = require('./lib/timeUtils')

const KIND = {
  ROOM: 'room',
  SURCHARGE_EARLY: 'surcharge-early',
  SURCHARGE_LATE: 'surcharge-late',
  SURCHARGE_ADULT: 'surcharge-adult',
  SURCHARGE_CHILD: 'surcharge-child',
  GRACE: 'grace-free',
}

/** Chọn mốc giá bậc thang (early/late) theo số giờ — lấy bậc cao nhất ≤ hours. */
function pickTierPrice(tiers, hours) {
  if (!Array.isArray(tiers) || tiers.length === 0 || hours <= 0) return 0
  const parsed = tiers
    .map(t => ({ h: T.parseHHmm(t.time) != null ? T.parseHHmm(t.time) / 60 : Number(String(t.time).match(/\d+/)?.[0] || 0), price: Number(t.price) || 0 }))
    .filter(t => t.h > 0)
    .sort((a, b) => a.h - b.h)
  if (parsed.length === 0) return 0
  if (hours <= parsed[0].h) return parsed[0].price
  let chosen = parsed[0].price
  for (const t of parsed) {
    if (hours >= t.h) chosen = t.price
  }
  // Nếu vượt bậc cao nhất → dùng bậc cao nhất (caller có thể cộng thêm ngày).
  return chosen
}

/** Chọn slot giá GIỜ theo số giờ cần. */
function pickHourSlot(slots, hours) {
  if (!Array.isArray(slots) || slots.length === 0) return null
  const parsed = slots
    .map(s => {
      const dur = s.durationHours != null
        ? Number(s.durationHours)
        : (T.parseHHmm(s.time) != null ? T.parseHHmm(s.time) / 60 : Number(String(s.time).match(/\d+/)?.[0] || 0))
      return { dur, price: Number(s.price) || 0 }
    })
    .filter(s => s.dur > 0)
    .sort((a, b) => a.dur - b.dur)
  if (parsed.length === 0) return null
  for (const s of parsed) {
    if (hours <= s.dur) return s
  }
  return parsed[parsed.length - 1] // vượt slot lớn nhất → slot lớn nhất
}

/** Tính số người vượt sức chứa. */
function computeExtra(adults, children, maxAdults, maxChildren) {
  const extraAdults = Math.max(0, adults - maxAdults)
  const unusedAdultSlots = Math.max(0, maxAdults - adults)
  const childFreeSlots = maxChildren + unusedAdultSlots
  const extraChildren = Math.max(0, children - childFreeSlots)
  return { extraAdults, extraChildren }
}

/**
 * Đếm số "đêm lịch" giữa startAt và endAt theo giờ khách sạn, có xét:
 *   - tolerance: trả trễ ≤ tolerance không cộng đêm
 *   - giờ nhận rạng sáng (≤ earlyCheckinUntil) → +1 đêm (đêm hôm trước)
 *   - trả muộn vượt dayEquivalentHours → +1 đêm
 */
function computeDayNights(startAt, endAt, ctx, policy) {
  const off = ctx.hotelUtcOffsetMinutes
  const tol = ctx.toleranceMinutes
  const coStdMin = T.parseHHmm(policy.dayCheckOutTime) ?? 720 // 12:00
  const earlyUntilMin = (ctx.earlyCheckinUntilHour ?? 5) * 60
  const dayEquivMin = (ctx.dayEquivalentHours ?? 23) * 60

  const startDay = T.dayIndex(startAt, off)
  const endDay = T.dayIndex(endAt, off)
  const endMin = T.minutesOfDay(endAt, off)
  const startMin = T.minutesOfDay(startAt, off)
  const sameDay = startDay === endDay

  // Số đêm lịch cơ bản: chênh lệch ngày, trừ phần trả trễ ≤ tolerance.
  let nights = endDay - startDay
  if (!sameDay && endMin > coStdMin) {
    // trả sau giờ chuẩn cùng "ranh giới ngày" — chỉ cộng đêm nếu vượt tolerance đáng kể
    const lateMin = endMin - coStdMin
    if (lateMin > 0) {
      // KHÔNG cộng đêm ở đây — phần trễ xử lý bằng surcharge/late-night riêng.
    }
  }
  if (sameDay) nights = 0

  // Nhận rạng sáng → +1 đêm (đêm hôm trước).
  const isEarlyMorning = startMin <= earlyUntilMin
  let effectiveNights = nights
  if (!sameDay && isEarlyMorning) effectiveNights += 1
  if (sameDay && isEarlyMorning && endMin >= dayEquivMin) effectiveNights += 1

  // Trả muộn vượt dayEquiv (qua đêm) → +1 đêm.
  if (!sameDay && endMin >= dayEquivMin) effectiveNights += 1

  // Tối thiểu 1 đêm nếu đã ở qua mốc (không phải grace).
  if (effectiveNights < 1) effectiveNights = sameDay ? 1 : Math.max(1, nights)

  return { effectiveNights, isEarlyMorning, sameDay, coStdMin, startMin, endMin }
}

/**
 * Tính giá NGÀY cho segment.
 */
function priceDaySegment(seg, ctx) {
  const off = ctx.hotelUtcOffsetMinutes
  const policy = seg.policy
  const dayPrice = ctx.customRoomPrice != null ? ctx.customRoomPrice : (Number(policy.dayPrice) || 0)
  const lines = []

  const computed = computeDayNights(seg.startAt, seg.endAt, ctx, policy)
  const isEarlyMorning = computed.isEarlyMorning
  const coStdMin = computed.coStdMin
  const startMin = computed.startMin
  // Nếu segmentBuilder đã phân bổ số đêm (đổi phòng) → tôn trọng, KHÔNG tự tính lại.
  const effectiveNights = seg.forcedNights != null ? seg.forcedNights : computed.effectiveNights

  // Phụ thu sức chứa / đêm
  const { extraAdults, extraChildren } = computeExtra(
    seg.occupancy.adults, seg.occupancy.children,
    seg.capacity.maxAdults, seg.capacity.maxChildren
  )
  const adultSurPerNight = extraAdults > 0 ? (Number(policy.dayAdultSurcharge) || 0) * extraAdults : 0
  const childSurPerNight = extraChildren > 0 ? (Number(policy.dayChildSurcharge) || 0) * extraChildren : 0

  // Mỗi đêm 1 dòng giá ngày + phụ thu sức chứa (xen kẽ), dùng giờ chuẩn cho đêm giữa.
  const ciStdMin = T.parseHHmm(policy.dayCheckInTime) ?? 840 // 14:00
  const startDayIdx = T.dayIndex(seg.startAt, off)
  const endDayIdx = T.dayIndex(seg.endAt, off)
  // ⭐ Rule 3: phòng ĐẦU của "đổi xong trả trong ngày" chỉ tính phụ thu nhận sớm,
  //   KHÔNG có dòng base ngày nào (đêm đó đã thuộc phòng cuối, tính giá giờ).
  const baseNights = seg.forceEarlyOnly ? 0 : effectiveNights
  for (let i = 0; i < baseNights; i++) {
    let segStart, segEnd
    if (effectiveNights === 1) {
      segStart = seg.startAt
      segEnd = seg.endAt
    } else if (i === 0) {
      segStart = seg.startAt
      // đêm đầu kết thúc ở giờ trả chuẩn của ngày kế tiếp ngày nhận (trừ nhận rạng sáng)
      segEnd = T.atTimeOfDay(T.addDays(seg.startAt, isEarlyMorning ? 0 : 1), coStdMin, off)
    } else if (i === effectiveNights - 1) {
      // đêm cuối bắt đầu ở giờ nhận chuẩn của ngày NGAY TRƯỚC ngày trả; kết thúc = endAt thực
      const lastNightCheckInDay = T.addDays(seg.endAt, -1)
      segStart = T.atTimeOfDay(lastNightCheckInDay, ciStdMin, off)
      segEnd = seg.endAt
    } else {
      // đêm giữa thứ i: từ giờ nhận chuẩn ngày (startDay - earlyShift + i) → giờ trả chuẩn hôm sau
      const earlyShift = isEarlyMorning ? 1 : 0
      const dayN = startDayIdx + i - earlyShift
      const dayDate = T.atTimeOfDay(seg.startAt, ciStdMin, off) // mốc để cộng ngày
      const base = T.addDays(dayDate, (dayN - startDayIdx))
      segStart = T.atTimeOfDay(base, ciStdMin, off)
      segEnd = T.atTimeOfDay(T.addDays(base, 1), coStdMin, off)
    }
    // ⭐ Tab "đến hiện tại": nếu đêm này là đêm CUỐI và mốc kết thúc tự nhiên VƯỢT giờ xem
    //   thật (displayEndAt = now) → NHÃN hiển thị tới now (khỏi nhầm "tính tới tương lai").
    //   Số tiền KHÔNG đổi (vẫn trọn đêm theo giá ngày).
    let segEndLabel = segEnd
    if (i === effectiveNights - 1 && ctx.displayEndAt instanceof Date
        && ctx.displayEndAt.getTime() < segEnd.getTime()
        && ctx.displayEndAt.getTime() >= segStart.getTime()) {
      segEndLabel = ctx.displayEndAt
    }
    lines.push({
      kind: KIND.ROOM, roomNumber: seg.roomNumber,
      label: `[${seg.roomNumber}] Giá ngày (${T.fmtDMHM(segStart, off)} - ${T.fmtDMHM(segEndLabel, off)})`,
      amount: T.roundMoney(dayPrice),
      startAt: segStart, endAt: segEndLabel,
      meta: { roomNumber: seg.roomNumber, nightIndex: i },
    })
    if (adultSurPerNight > 0) {
      lines.push({
        kind: KIND.SURCHARGE_ADULT, roomNumber: seg.roomNumber,
        label: `[${seg.roomNumber}] Phụ thu ${extraAdults} người lớn`,
        amount: T.roundMoney(adultSurPerNight), startAt: segStart, endAt: segEnd,
        meta: { roomNumber: seg.roomNumber, extraAdults },
      })
    }
    if (childSurPerNight > 0) {
      lines.push({
        kind: KIND.SURCHARGE_CHILD, roomNumber: seg.roomNumber,
        label: `[${seg.roomNumber}] Phụ thu ${extraChildren} trẻ em`,
        amount: T.roundMoney(childSurPerNight), startAt: segStart, endAt: segEnd,
        meta: { roomNumber: seg.roomNumber, extraChildren },
      })
    }
  }

  // ── Phụ thu NHẬN SỚM (early check-in) ──
  // Áp dụng khi: KHÔNG bị suppress (chặng đầu thật), KHÔNG phải nhận rạng sáng (đã +đêm),
  // và giờ nhận sớm hơn giờ chuẩn vượt tolerance.
  if (!seg.suppressEarlyCheckIn && !isEarlyMorning) {
    const earlyMin = ciStdMin - startMin
    if (earlyMin > ctx.toleranceMinutes) {
      const hours = T.roundHoursWithTolerance(earlyMin, ctx.toleranceMinutes)
      const price = pickTierPrice(policy.dayEarlyCheckIn, hours)
      if (price > 0) {
        lines.push({
          kind: KIND.SURCHARGE_EARLY, roomNumber: seg.roomNumber,
          label: `[${seg.roomNumber}] Nhận phòng sớm (${fmtHourMin(earlyMin)})`,
          amount: T.roundMoney(price), startAt: seg.startAt, endAt: seg.startAt,
          meta: { roomNumber: seg.roomNumber, earlyMinutes: earlyMin },
        })
      }
    }
  }

  // ── Phụ thu TRẢ MUỘN (late check-out) ──
  // Áp dụng khi: KHÔNG bị suppress (chặng cuối thật), trả muộn hơn giờ chuẩn vượt tolerance,
  // và CHƯA bị quy thành +1 đêm (nếu đã +đêm do dayEquiv thì không cộng surcharge nữa).
  if (!seg.suppressLateCheckOut) {
    const endMin = T.minutesOfDay(seg.endAt, off)
    const dayEquivMin = (ctx.dayEquivalentHours ?? 23) * 60
    const lateMin = endMin - coStdMin
    const alreadyCountedAsNight = endMin >= dayEquivMin
    // ⭐ Chỉ tính trả muộn khi checkout SAU giờ chuẩn của 1 ngày-lịch KHÁC ngày nhận
    //   (đã qua ≥1 đêm). Trả lúc 20:00 CÙNG ngày nhận = trả SỚM (đêm đầu), KHÔNG phụ thu.
    const sameDayAsStart = T.dayIndex(seg.startAt, off) === T.dayIndex(seg.endAt, off)
    if (lateMin > ctx.toleranceMinutes && !alreadyCountedAsNight && !sameDayAsStart) {
      const hours = T.roundHoursWithTolerance(lateMin, ctx.toleranceMinutes)
      const price = pickTierPrice(policy.dayLateCheckOut, hours)
      if (price > 0) {
        lines.push({
          kind: KIND.SURCHARGE_LATE, roomNumber: seg.roomNumber,
          label: `[${seg.roomNumber}] Trả phòng muộn (${fmtHourMin(lateMin)})`,
          amount: T.roundMoney(price), startAt: seg.endAt, endAt: seg.endAt,
          meta: { roomNumber: seg.roomNumber, lateMinutes: lateMin },
        })
      }
    }
  }

  return { lines, nights: effectiveNights }
}

/** Tính giá GIỜ cho segment. */
function priceHourSegment(seg, ctx) {
  const off = ctx.hotelUtcOffsetMinutes
  const policy = seg.policy
  const durMin = T.diffMinutes(seg.startAt, seg.endAt)
  const hours = T.roundHoursWithTolerance(durMin, ctx.toleranceMinutes)
  const lines = []
  if (hours <= 0) {
    return { lines: [], nights: 0, grace: true }
  }
  const slot = pickHourSlot(policy.hourSlots, hours)
  const price = slot ? slot.price : 0
  lines.push({
    kind: KIND.ROOM, roomNumber: seg.roomNumber,
    label: `[${seg.roomNumber}] Giá giờ (${fmtHourMin(durMin)})`,
    amount: T.roundMoney(price), startAt: seg.startAt, endAt: seg.endAt,
    meta: { roomNumber: seg.roomNumber, hours },
  })
  return { lines, nights: 0 }
}

/** Tính giá ĐÊM cho segment. */
function priceNightSegment(seg, ctx) {
  const off = ctx.hotelUtcOffsetMinutes
  const policy = seg.policy
  const startDay = T.dayIndex(seg.startAt, off)
  const endDay = T.dayIndex(seg.endAt, off)
  const nights = Math.max(1, endDay - startDay)
  const price = (Number(policy.nightPrice) || 0) * nights
  const lines = [{
    kind: KIND.ROOM, roomNumber: seg.roomNumber,
    label: `[${seg.roomNumber}] Giá đêm × ${nights}`,
    amount: T.roundMoney(price), startAt: seg.startAt, endAt: seg.endAt,
    meta: { roomNumber: seg.roomNumber, nights },
  }]
  return { lines, nights }
}

function fmtHourMin(totalMin) {
  const m = Math.max(0, Math.round(totalMin))
  const h = Math.floor(m / 60), mm = m % 60
  if (h > 0 && mm > 0) return `${h}h${mm}m`
  if (h > 0) return `${h}h`
  return `${mm}m`
}

/**
 * HÀM CHÍNH — tính tiền 1 segment.
 */
function priceSegment(seg, ctx) {
  // Validate
  if (!(seg.startAt instanceof Date) || !(seg.endAt instanceof Date)) {
    return { lines: [], roomAmount: 0, nights: 0, error: { code: 'BAD_INPUT', message: 'startAt/endAt phải là Date' } }
  }
  const durMin = T.diffMinutes(seg.startAt, seg.endAt)
  if (durMin < 0) {
    return { lines: [], roomAmount: 0, nights: 0, error: { code: 'NEGATIVE_DURATION', message: 'endAt < startAt' } }
  }

  // Miễn phí phòng
  if (seg.isFreeRoom) {
    const line = {
      kind: KIND.ROOM, roomNumber: seg.roomNumber,
      label: `[${seg.roomNumber}] Miễn phí`,
      amount: 0, startAt: seg.startAt, endAt: seg.endAt,
      meta: { roomNumber: seg.roomNumber, freeRoom: true },
    }
    return { lines: [line], roomAmount: 0, nights: 0 }
  }

  // Grace period: ở ≤ tolerance → miễn phí (CHỈ khi KHÔNG phải chặng đã hoàn tất do đổi phòng;
  //   chặng phòng cũ ≤ tolerance được xử lý ở segmentBuilder = drop hẳn, không vào đây).
  const tol = ctx.toleranceMinutes
  if (durMin <= tol && !seg.isTransferLeg && !seg.forceEarlyOnly) {
    const line = {
      kind: KIND.GRACE, roomNumber: seg.roomNumber,
      label: `[${seg.roomNumber}] Mới ${Math.max(0, Math.floor(durMin))} phút (Linh hoạt ${tol} phút — Miễn phí)`,
      amount: 0, startAt: seg.startAt, endAt: seg.endAt,
      meta: { roomNumber: seg.roomNumber, freeGracePeriod: true, tolerance: tol, diffMinutes: durMin },
    }
    return { lines: [line], roomAmount: 0, nights: 0 }
  }

  let result
  if (seg.priceType === 'hour') result = priceHourSegment(seg, ctx)
  else if (seg.priceType === 'night') result = priceNightSegment(seg, ctx)
  else result = priceDaySegment(seg, ctx)

  const lines = result.lines
  // BẤT BIẾN: roomAmount === Σ lines.amount
  const roomAmount = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0)
  return { lines, roomAmount: T.roundMoney(roomAmount), nights: result.nights || 0 }
}

module.exports = { priceSegment, KIND, pickTierPrice, pickHourSlot, computeExtra }