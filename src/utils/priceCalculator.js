// ─────────────────────────────────────────────────────────
// utils/priceCalculator.js
// Logic tính giá tập trung — đảm bảo BE trả ra số tiền giống FE
// v2.0 — 18/05/2026: Surcharge logic v2 (maxOccupancy roomType) + OVER_CAPACITY block
// ─────────────────────────────────────────────────────────

/**
 * Parse "HH:mm" → minutes
 */
const toMinutes = (timeStr) => {
  const [h, m] = String(timeStr ?? '').split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

const pad = (n) => String(n).padStart(2, '0')

/**
 * Cùng 1 ngày calendar?
 */
const isSameDay = (a, b) => {
  const da = new Date(a), db = new Date(b)
  return da.getFullYear() === db.getFullYear()
      && da.getMonth()    === db.getMonth()
      && da.getDate()     === db.getDate()
}

/**
 * Làm tròn số giờ với tolerance (Cách B: trừ tolerance rồi làm tròn LÊN).
 * tolerance = 15 →
 *   - 0 - 15 phút: 0h (miễn phí, trong dung sai)
 *   - 16 - 75 phút (đến 1h15): 1h   (ceil((16..75 − 15)/60) = 1)
 *   - 76 - 135 phút (1h16 - 2h15): 2h
 * Công thức: phút ≤ tolerance → 0; ngược lại ceil((phút − tolerance) / 60).
 * Ví dụ 91 phút (13:31 so với 12:00): ceil((91 − 15)/60) = ceil(1.27) = 2h.
 */
const roundHoursWithTolerance = (totalMinutes, toleranceMin) => {
  if (totalMinutes <= toleranceMin) return 0
  return Math.ceil((totalMinutes - toleranceMin) / 60)
}

/**
 * Tính số đêm theo ngày calendar — bỏ qua giờ trễ ≤ tolerance
 * Ví dụ: 01/05 14:00 → 02/05 12:15 (trễ 15p, trong tolerance) = 1 đêm
 *        01/05 14:00 → 02/05 13:00 (trễ 1h, vượt tolerance) = 1 đêm (vẫn không cộng đêm)
 *        01/05 14:00 → 03/05 12:00 = 2 đêm
 */
const calcNights = (checkIn, checkOut) => {
  const a = new Date(checkIn);  a.setHours(0, 0, 0, 0)
  const b = new Date(checkOut); b.setHours(0, 0, 0, 0)
  return Math.max(1, Math.round((b - a) / 86400000) || 1)
}

/**
 * Chọn slot phụ thu phù hợp.
 * - Hỗ trợ nhiều tên field: time, hours, duration (defensive)
 * - Nếu hours khớp slot (slot.time <= hours): chọn slot LỚN NHẤT vẫn ≤ hours
 * - Nếu hours nhỏ hơn slot nhỏ nhất: chọn slot NHỎ NHẤT (minimum charge)
 * - Nếu hours vượt slot lớn nhất: vẫn chọn slot LỚN NHẤT (capped)
 *   Vd: hours=25, slots=[1,3,5] → chọn slot 5h (không cộng dồn)
 *
 * slots: [{ time: '1', price: 50000 }, { time: '3', price: 100000 }]
 */
const getSlotHours = (s) => {
  // Hỗ trợ multiple field names
  const v = s?.time ?? s?.hours ?? s?.duration ?? s?.h ?? null
  if (v === null || v === undefined) return null
  // ⭐ Hỗ trợ cả 2 format:
  //   - Số (vd: 2, "2", "2.5") → giờ
  //   - "HH:mm" (vd: "02:00", "02:30") → giờ.phút (lấy hours, ignore minutes)
  //     Lưu ý: "02:30" được làm tròn xuống 2h vì slot không tính lẻ phút
  const str = String(v).trim()
  if (str.includes(':')) {
    const [h] = str.split(':').map(Number)
    return Number.isFinite(h) ? h : null
  }
  const n = parseInt(str, 10)
  return Number.isFinite(n) ? n : null
}

const getSlotPrice = (s) => {
  const v = s?.price ?? s?.amount ?? s?.value ?? 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const pickSlot = (slots, hours) => {
  if (!Array.isArray(slots) || slots.length === 0) return null

  // ⭐ Normalize: filter ra slot HỢP LỆ (có time + price)
  const valid = slots
    .map(s => {
      const h = getSlotHours(s)
      const p = getSlotPrice(s)
      if (h === null || h <= 0) return null
      return { time: h, price: p, _raw: s }
    })
    .filter(Boolean)

  if (valid.length === 0) return null

  const sorted = [...valid].sort((a, b) => a.time - b.time)

  // ⭐ Hours nhỏ hơn slot nhỏ nhất → áp slot nhỏ nhất (minimum charge)
  if (hours < sorted[0].time) {
    return { ...sorted[0], _isMinimum: true }
  }

  // Bình thường: lấy slot LỚN NHẤT vẫn ≤ hours
  // ⭐ Khi hours vượt slot lớn nhất (vd 25h, slots [1,3,5]) → vẫn lấy slot 5h
  return sorted
    .filter(s => s.time <= hours)
    .sort((a, b) => b.time - a.time)[0] ?? null
}

/**
 * ⭐ NEW v2 (18/05/2026): Tính phụ thu theo spec mới (maxOccupancy roomType)
 *
 *   - extraAdults      = max(0, adults - maxAdults)
 *   - unusedAdultSlots = max(0, maxAdults - adults)
 *   - childFreeSlots   = maxChildren + unusedAdultSlots
 *     (TE có thể "thế chỗ" NL chuẩn còn dư mà không phụ thu)
 *   - extraChildren    = max(0, children - childFreeSlots)
 *
 * Examples (maxA=2, maxC=1):
 *   2NL+1TE = 0+0  (chuẩn)
 *   3NL+0TE = 1+0  (NL > maxA → 1NL phụ thu)
 *   1NL+1TE = 0+0
 *
 * Examples (maxA=4, maxC=0):
 *   4NL     = 0+0
 *   3NL+1TE = 0+0  (1TE thế chỗ NL chuẩn dư)
 *   0NL+4TE = 0+0
 *   5NL     = 1+0
 *   4NL+1TE = 0+1
 *   5NL+1TE = 1+1
 */
const computeExtra = (adults, children, maxAdults, maxChildren) => {
  const extraAdults      = Math.max(0, adults - maxAdults)
  const unusedAdultSlots = Math.max(0, maxAdults - adults)
  const childFreeSlots   = maxChildren + unusedAdultSlots
  const extraChildren    = Math.max(0, children - childFreeSlots)
  return { extraAdults, extraChildren }
}

/**
 * Tính giá đầy đủ cho 1 booking.
 *
 * @param {Object} input
 * @param {Date} input.checkIn
 * @param {Date} input.checkOut
 * @param {string} input.priceType        - 'hour' | 'day' | 'night' | 'week' | 'month'
 * @param {Object} input.policy           - PricePolicy doc
 * @param {Object} input.branch           - Branch doc (lấy giờ chuẩn + tolerance)
 * @param {number} input.adults
 * @param {number} input.children
 * @param {number} [input.maxAdults]      - Số NL chuẩn loại phòng (default: capacity hoặc 2)
 * @param {number} [input.maxChildren]    - Số TE chuẩn loại phòng (default: 0)
 * @param {number} [input.maxOccupancy]   - ⭐ NEW v2: Hard limit. Vượt → OVER_CAPACITY error
 * @param {number} [input.capacity]       - DEPRECATED: dùng maxAdults+maxChildren (backward compat)
 *
 * @returns {Object} {
 *   roomAmount,        // Tổng tiền phòng (đã gồm phụ thu)
 *   nights,            // Số đêm thực
 *   finalPriceType,    // Loại giá thực sự áp dụng (sau auto-convert)
 *   originalPriceType, // Loại giá user chọn ban đầu
 *   converted,         // boolean — có auto-convert không
 *   notice,            // string — thông báo cho user (nếu converted)
 *   breakdown: [{ label, amount, type: 'base'|'surcharge' }],
 *   error?: { code: 'OVER_CAPACITY' | 'PRICE_TYPE_NOT_ENABLED' | 'HOUR_BOOKING_CUTOFF', ... }
 * }
 */
function calculatePrice(input) {
  const {
    checkIn, checkOut, priceType: requestedType = 'day',
    policy, branch, adults = 2, children = 0,
    capacity,        // ⭐ DEPRECATED — fallback cho code cũ
    maxAdults,       // ⭐ NEW
    maxChildren,     // ⭐ NEW
    maxOccupancy,    // ⭐ NEW v2 (18/05/2026)
  } = input

  // ⭐ Resolve maxAdults / maxChildren từ input
  //   Ưu tiên: maxAdults/maxChildren > capacity (legacy) > default (2 NL, 0 TE)
  //   Nếu chỉ có capacity → coi tất cả là NL (maxAdults=capacity, maxChildren=0)
  const resolvedMaxAdults   = maxAdults   ?? capacity ?? 2
  const resolvedMaxChildren = maxChildren ?? 0
  // ⭐ NEW v2: Default maxOccupancy = maxA + maxC (chuẩn, không cho extra) nếu không truyền
  const resolvedMaxOccupancy = maxOccupancy ?? (resolvedMaxAdults + resolvedMaxChildren)

  const ci = new Date(checkIn)
  const co = new Date(checkOut)
  const diffMs = co - ci
  const diffMin = diffMs / 60000
  const diffH   = diffMs / 3600000

  // ── Lấy config từ branch ──
  const tolerance        = branch?.toleranceMinutes      ?? 15
  const hourToDayThresh  = branch?.hourToDayThreshold    ?? 3
  const dayEquivHours    = branch?.dayEquivalentHours    ?? 23
  const autoConvert      = branch?.autoConvertPriceType  ?? true
  // ⭐ FIX 22/05/2026: Mốc giờ CHUẨN ưu tiên dayCheckInTime/dayCheckOutTime của POLICY,
  //   chỉ fallback về giờ branch khi policy không khai báo. Vd policy "Giá Ngày" có
  //   dayCheckInTime=12:00 → đêm sau phải bắt đầu 12:00, không phải 14:00 (giờ branch).
  const ciStandard       = policy?.dayCheckInTime  ?? branch?.checkInTime  ?? '14:00'
  const coStandard       = policy?.dayCheckOutTime ?? branch?.checkOutTime ?? '12:00'

  // ⭐ Số giờ thực tế đã làm tròn theo tolerance
  const hoursRounded = roundHoursWithTolerance(diffMin, tolerance)
  const sameDay      = isSameDay(ci, co)

  // ──────────────────────────────────────────────────
  // ⭐ AUTO-CONVERT priceType
  //   - Case 1: day → hour (ở ngắn) — VẪN GIỮ
  //   - Case 2 (hour → day vượt 23:00): ĐÃ TẮT theo yêu cầu
  //   - Case 3 (hour → day qua đêm):    ĐÃ TẮT theo yêu cầu
  //   Lý do tắt: khách chọn Giờ thì tính theo slot Giờ thoải mái,
  //   ở bao nhiêu giờ tính bấy nhiêu giờ. pickSlot() sẽ lấy slot
  //   lớn nhất ≤ hours (vd ở 25h, slots [1,3,5] → lấy slot 5h).
  // ──────────────────────────────────────────────────
  let finalType = requestedType
  let converted = false
  let notice    = ''

  if (autoConvert && policy) {
    // ⭐ ĐÃ TẮT TOÀN BỘ AUTO-CONVERT theo yêu cầu:
    //   - Case 1 (day → hour khi ở ngắn): TẮT
    //   - Case 2 (hour → day khi vượt 23:00): TẮT
    //   - Case 3 (hour → day khi qua đêm): TẮT
    //
    //   Lý do: User đã chọn loại giá rõ ràng (Giờ/Ngày), BE không nên tự chuyển.
    //   Nếu chọn loại không hợp lệ → trả 400 PRICE_TYPE_NOT_ENABLED (xem block validation bên dưới).
    //
    //   Block này giữ lại như placeholder cho future cases (vd: chỉ convert khi user
    //   set flag confirmConvert=true).
  }

  // ──────────────────────────────────────────────────
  // Tính giá theo finalType
  // ──────────────────────────────────────────────────
  const breakdown = []
  let roomAmount = 0
  const nights = calcNights(ci, co)

  if (!policy) {
    return { roomAmount: 0, nights, finalPriceType: finalType, originalPriceType: requestedType, converted, notice, breakdown }
  }

  // ──────────────────────────────────────────────────
  // ⭐ NEW v2 (18/05/2026): BLOCK OVER_CAPACITY — phòng không đủ chỗ
  //   Nếu tổng người (adults + children) > maxOccupancy → từ chối ngay
  //   Áp dụng cho mọi loại giá (Giờ, Ngày, Đêm...).
  //
  //   Spec roomType:
  //     - maxAdults    = NL chuẩn (không phụ thu)
  //     - maxChildren  = TE chuẩn (không phụ thu)
  //     - maxOccupancy = Tổng người tối đa (hard limit, vượt = REJECT)
  //
  //   Examples (maxA=2, maxC=1, maxOcc=3):
  //     2NL+1TE → OK (chuẩn)
  //     3NL+0TE → OK (1NL phụ thu)
  //     2NL+2TE → REJECT (4 > 3)
  //     4NL+0TE → REJECT
  // ──────────────────────────────────────────────────
  if ((adults + children) > resolvedMaxOccupancy) {
    return {
      roomAmount: 0,
      nights,
      finalPriceType: finalType,
      originalPriceType: requestedType,
      converted, notice,
      breakdown: [],
      error: {
        code:    'OVER_CAPACITY',
        message: `Phòng chỉ hỗ trợ tối đa ${resolvedMaxOccupancy} người.`,
        maxOccupancy: resolvedMaxOccupancy,
        requested:    adults + children,
        adults, children,
        maxAdults:    resolvedMaxAdults,
        maxChildren:  resolvedMaxChildren,
      },
    }
  }

  // ⭐ EARLY RETURN: nếu khoảng thời gian ≤ tolerance → MIỄN PHÍ (chưa tính tiền)
  // Áp dụng cho mọi loại giá (Giờ, Ngày, Đêm...)
  if (diffMin <= tolerance) {
    breakdown.push({
      label: `Mới ${Math.max(0, Math.floor(diffMin))} Phút (Linh hoạt ${tolerance} Phút — Miễn Phí)`,
      amount: 0,
      type:   'base',
      meta:   { freeGracePeriod: true, tolerance, diffMinutes: diffMin },
    })
    return {
      roomAmount: 0,
      nights:     0,
      finalPriceType: finalType,
      originalPriceType: requestedType,
      converted, notice, breakdown,
    }
  }

  // ⭐ VALIDATION: Đảm bảo policy có enable đúng loại finalType
  //   Nếu user chọn priceType mà policy KHÔNG enable loại đó (vd: priceType='day'
  //   nhưng dayEnabled=false) → trả về error để controller chuyển 400 BAD_REQUEST.
  //   Tránh trường hợp im lặng trả 0đ làm user khó hiểu.
  const enableMap = {
    hour:  policy.hourEnabled,
    day:   policy.dayEnabled,
    night: policy.nightEnabled,
    week:  policy.weekEnabled,
    month: policy.monthEnabled,
  }
  const typeLabelMap = {
    hour: 'Giá Giờ', day: 'Giá Ngày', night: 'Giá Đêm', week: 'Giá Tuần', month: 'Giá Tháng',
  }
  if (enableMap[finalType] !== true) {
    // Liệt kê các loại giá mà policy CÓ enable để gợi ý cho FE/user
    const enabledTypes = Object.entries(enableMap)
      .filter(([_, v]) => v === true)
      .map(([k]) => k)
    return {
      roomAmount: 0,
      nights,
      finalPriceType: finalType,
      originalPriceType: requestedType,
      converted, notice,
      breakdown: [],
      error: {
        code:    'PRICE_TYPE_NOT_ENABLED',
        message: `Chính sách giá "${policy.name ?? ''}" không có cấu hình ${typeLabelMap[finalType] ?? finalType}. Vui lòng chọn loại giá khác.`,
        finalPriceType:   finalType,
        availableTypes:   enabledTypes,           // ['hour', 'night', ...]
        availableLabels:  enabledTypes.map(t => typeLabelMap[t]),
      },
    }
  }

  // ⭐ NEW: VALIDATION CUTOFF GIÁ GIỜ (RANGE)
  //   Khi branch.hourBookingCutoffEnabled = true, không cho đặt phòng giá giờ
  //   nếu CI nằm trong khoảng [hourBookingCutoffStart, hourBookingCutoffEnd).
  //   Hỗ trợ cross-midnight: vd start=20:00, end=06:00 → cấm từ 20:00 hôm nay đến 05:59 hôm sau.
  //   - Chỉ áp dụng cho finalType === 'hour'
  //   - Logic check theo CI (giờ trong ngày) — không quan tâm ngày calendar
  if (
    finalType === 'hour' &&
    branch?.hourBookingCutoffEnabled === true
  ) {
    const startStr = branch.hourBookingCutoffStart ?? '20:00'
    const endStr   = branch.hourBookingCutoffEnd   ?? '06:00'
    const startMin = toMinutes(startStr)
    const endMin   = toMinutes(endStr)
    const ciMin    = ci.getHours() * 60 + ci.getMinutes()

    // Edge case: start === end → coi như cutoff cả ngày (block toàn bộ)
    // start > end → cross-midnight (vd 20:00 → 06:00): block khi ciMin >= start HOẶC ciMin < end
    // start < end → cùng ngày (vd 12:00 → 14:00): block khi ciMin >= start VÀ ciMin < end
    let isInBlock = false
    if (startMin === endMin) {
      isInBlock = true   // cấm toàn bộ — admin cố ý cấu hình kì lạ
    } else if (startMin > endMin) {
      isInBlock = ciMin >= startMin || ciMin < endMin
    } else {
      isInBlock = ciMin >= startMin && ciMin < endMin
    }

    if (isInBlock) {
      return {
        roomAmount: 0,
        nights,
        finalPriceType: finalType,
        originalPriceType: requestedType,
        converted, notice,
        breakdown: [],
        error: {
          code:    'HOUR_BOOKING_CUTOFF',
          message: `Không thể đặt phòng giá giờ trong khoảng ${startStr} - ${endStr}. Vui lòng chọn loại giá khác (Giá Ngày/Đêm).`,
          finalPriceType: finalType,
          cutoffStart:    startStr,
          cutoffEnd:      endStr,
          checkInTime:    `${pad(ci.getHours())}:${pad(ci.getMinutes())}`,
          // Gợi ý các loại giá còn lại (không phải hour)
          availableTypes:  Object.entries(enableMap)
            .filter(([k, v]) => v === true && k !== 'hour')
            .map(([k]) => k),
          availableLabels: Object.entries(enableMap)
            .filter(([k, v]) => v === true && k !== 'hour')
            .map(([k]) => typeLabelMap[k]),
        },
      }
    }
  }

  // ─── Giá Giờ ───
  if (finalType === 'hour' && policy.hourEnabled) {
    if (hoursRounded === 0) {
      // ⭐ Trong khoảng tolerance — chưa tính tiền giờ đầu tiên
      breakdown.push({
        label: `Giá giờ (mới ${Math.floor((co - ci) / 60000)} phút, trong ${tolerance}p miễn phí)`,
        amount: 0,
        type:   'base',
        meta:   { freeGracePeriod: true, tolerance },
      })
      // roomAmount += 0
    } else {
      const slot = pickSlot(policy.hourSlots, hoursRounded)
      if (slot) {
        const label = slot._isMinimum
          ? `Giá giờ tối thiểu (Khung ${slot.time}h, mới ở ${hoursRounded}h)`
          : `Giá giờ (Khung ${slot.time}h, ở ${hoursRounded}h)`
        breakdown.push({ label, amount: slot.price, type: 'base' })
        roomAmount += slot.price
      } else {
        // ⭐ Defensive: hourSlots rỗng → không có giá
        breakdown.push({
          label: `Giá giờ (chưa cấu hình slot trong policy)`,
          amount: 0,
          type:   'base',
          meta:   { warning: 'no-hour-slots-configured' },
        })
      }
    }
  }

  // ─── Giá Ngày ───
  else if (finalType === 'day' && policy.dayEnabled) {
    const dayPrice = policy.dayPrice ?? 0
    const ciStandardMin = toMinutes(ciStandard)   // vd 14:00 → 840
    const coStandardMin = toMinutes(coStandard)   // vd 12:00 → 720

    // ⭐ NEW: "Early-checkin night" — nếu CI nằm trong khoảng [00:00, earlyCheckinUntil]
    //   thì coi như CI thuộc đêm hiện tại (KHÔNG phụ thu CI sớm).
    //   Ví dụ: CI 02:00 → CO 12:00 cùng ngày → 1 đêm trọn (không phụ thu).
    const earlyCheckinUntilHour = branch?.earlyCheckinUntil ?? 5
    const earlyCheckinUntilMin  = earlyCheckinUntilHour * 60
    const ciHourMin = ci.getHours() * 60 + ci.getMinutes()
    const isEarlyCheckinNight = ciHourMin <= earlyCheckinUntilMin

    // ⭐ NEW: "Late-checkout convert to night" — nếu CO vượt mốc dayEquivHours (vd 23:00)
    //   của NGÀY CUỐI mà policy có cho late-checkout, thì cộng thêm 1 đêm thay vì phụ thu giờ.
    //   Logic: lấy giờ trong ngày của CO, nếu >= dayEquivHours → thêm 1 đêm.
    //   Lưu ý: chỉ áp dụng khi !sameDay (đã qua đêm). sameDay+1 sẽ vào nhánh khác.
    const coHourMin = co.getHours() * 60 + co.getMinutes()
    const dayEquivThresholdMin = dayEquivHours * 60
    const shouldAddNightForLate = !sameDay && coHourMin >= dayEquivThresholdMin
    // ⭐ Trường hợp đặc biệt sameDay (vd CI 02:00 + CO 23:30 cùng ngày):
    //   Nếu là early-checkin night + CO vượt 23:00 → cũng thành 2 đêm (vì đã ở 1 đêm trọn rồi)
    const shouldAddNightForLateSameDay = sameDay && isEarlyCheckinNight && coHourMin >= dayEquivThresholdMin

    // ⭐ FIX 22/05/2026: "Early-checkin night" = CI ≤ earlyCheckinUntil (vd ≤ 05:00).
    //   Theo chính sách: nhận phòng rạng sáng được tính TRỌN đêm HÔM TRƯỚC → +1 đêm.
    //   Vd: CI 22/05 01:18 → CO 23/05 12:00. calcNights=1 (chênh 1 ngày lịch),
    //       nhưng thực tế khách ở đêm 21→22 VÀ 22→23 = 2 đêm.
    //   Chỉ áp dụng khi !sameDay (đã qua đêm) để không đụng case sameDay+late ở trên.
    const shouldAddNightForEarlyCI = !sameDay && isEarlyCheckinNight

    // Số đêm thực tế tính giá (sau khi áp early/late convert)
    let effectiveNights = nights
    if (shouldAddNightForLate || shouldAddNightForLateSameDay) {
      effectiveNights = nights + 1
    }
    if (shouldAddNightForEarlyCI) {
      effectiveNights += 1   // cộng thêm đêm HÔM TRƯỚC
    }

    // ⭐ Tính phụ thu MỖI ĐÊM trước (vì sẽ push xen kẽ với từng giá ngày)
    //
    // ⭐ LOGIC v2 (18/05/2026) — Spec roomType có maxOccupancy:
    //   - extraAdults      = max(0, adults - maxAdults)        ← NL vượt riêng
    //   - childFreeSlots   = maxChildren + max(0, maxAdults - adults)
    //                        (TE có thể "thế chỗ" NL chuẩn còn dư)
    //   - extraChildren    = max(0, children - childFreeSlots)
    //
    // Test cases (maxA=2, maxC=1):
    //   2NL+1TE: extraA=0, unusedA=0, childFree=1, extraC=0  → chuẩn
    //   3NL+0TE: extraA=1, unusedA=0, childFree=1, extraC=0  → 1NL phụ thu
    //   1NL+1TE: extraA=0, unusedA=1, childFree=2, extraC=0  → chuẩn
    //
    // Test cases (maxA=4, maxC=0):
    //   4NL    : extraA=0, unusedA=0, childFree=0, extraC=0  → chuẩn
    //   3NL+1TE: extraA=0, unusedA=1, childFree=1, extraC=0  → 1TE thế chỗ NL chuẩn dư
    //   0NL+4TE: extraA=0, unusedA=4, childFree=4, extraC=0  → 4TE thế chỗ NL chuẩn dư
    //   5NL    : extraA=1, unusedA=0, childFree=0, extraC=0  → 1NL phụ thu
    //   4NL+1TE: extraA=0, unusedA=0, childFree=0, extraC=1  → 1TE phụ thu
    //   5NL+1TE: extraA=1, unusedA=0, childFree=0, extraC=1  → 1NL + 1TE phụ thu
    //
    // LƯU Ý: Validation `OVER_CAPACITY` (vượt maxOccupancy → TỪ CHỐI) đã được check
    // ở block trên TRƯỚC khi xuống đây. Tới đây chắc chắn total <= maxOccupancy.
    const { extraAdults, extraChildren } = computeExtra(
      adults, children, resolvedMaxAdults, resolvedMaxChildren
    )

    const adultSurchargePerNight = extraAdults > 0
      ? (policy.dayAdultSurcharge ?? 0) * extraAdults
      : 0
    const childSurchargePerNight = extraChildren > 0
      ? (policy.dayChildSurcharge ?? 0) * extraChildren
      : 0

    // ⭐ Tách thành từng "ngày ở" với khoảng thời gian cụ thể
    // Mỗi đêm = từ check-in time → check-out time của ngày hôm sau
    // Đêm đầu: ci thực tế → coStandard ngày hôm sau (hoặc co thực tế nếu sameDay)
    // Đêm giữa: ciStandard hôm i → coStandard hôm i+1
    // Đêm cuối: ciStandard → co thực tế
    //
    // Để đơn giản & match UI ezCloud: hiển thị 'Giá ngày (DD/MM HH:mm - DD/MM HH:mm)'
    // mỗi đêm 1 dòng, dùng giờ chuẩn cho các đêm giữa
    // ⭐ Phụ thu của từng đêm cũng được push ngay sau giá ngày của đêm đó (xen kẽ)
    for (let i = 0; i < effectiveNights; i++) {
      let segStart, segEnd
      if (effectiveNights === 1) {
        // 1 đêm duy nhất: dùng giờ thực tế cả 2 đầu
        segStart = ci
        // ⭐ FIX 16/05/2026 v19.2: Nếu co > coStandard (overstay) → đêm này dừng ở coStandard,
        //   phần overstay tách ra surcharge "Trả phòng muộn" — tránh double counting.
        //   THÊM guard isCheckInAfterCoStd: nếu CI đã sau coStandard cùng ngày
        //   (vd check-in muộn 18:14 > coStandard 12:00) → KHÔNG phải overstay,
        //   mà là đêm 1 thực sự bắt đầu chiều/tối → segEnd = co bình thường.
        const [coStdH1, coStdM1] = coStandard.split(':').map(Number)
        const coStdMin1 = coStdH1 * 60 + coStdM1
        const coMin1    = co.getHours() * 60 + co.getMinutes()
        const ciMin1    = ci.getHours() * 60 + ci.getMinutes()
        const isCheckInAfterCoStd = ciMin1 >= coStdMin1   // ⭐ NEW guard
        // Chỉ apply nếu co và coStandard ở cùng ngày (đêm 1 duy nhất kéo dài qua nhiều ngày = không apply)
        const sameDayCo = co.getFullYear() === ci.getFullYear()
                       && co.getMonth() === ci.getMonth()
                       && co.getDate()  === ci.getDate() + (sameDay ? 0 : 1)
        if (sameDayCo && coMin1 > coStdMin1 && !isCheckInAfterCoStd && (finalType === 'day' || finalType === 'night')) {
          const tmpEnd = new Date(co)
          tmpEnd.setHours(coStdH1, coStdM1, 0, 0)
          segEnd = tmpEnd
        } else {
          segEnd = co
        }
      } else if (i === 0) {
        // Đêm đầu: ci thực → coStandard ngày hôm sau (HOẶC sameDay early CI → coStandard cùng ngày)
        segStart = ci
        if (sameDay && shouldAddNightForLateSameDay) {
          // Edge case: early-checkin night + late vượt 23h → 2 đêm trong cùng ngày calendar
          // Đêm 1 = ci → coStandard CÙNG NGÀY (vd 02:00 → 12:00)
          const tmp = new Date(ci)
          const [h, m] = coStandard.split(':').map(Number)
          tmp.setHours(h, m, 0, 0)
          segEnd = tmp
        } else if (shouldAddNightForEarlyCI) {
          // ⭐ Early-checkin night (CI ≤ 5h): đêm 1 = ĐÊM HÔM TRƯỚC (tính trọn 1 đêm).
          //   ⭐ FIX hiển thị 22/05: segStart = GIỜ NHẬN THỰC TẾ (vd 22/05 01:18),
          //      KHÔNG phải 12:00 hôm trước — để label trung thực với actualCheckIn.
          //      Tiền KHÔNG đổi (giá ngày tính theo đêm, không theo độ dài đoạn).
          //   segEnd = coStandard NGÀY CI (vd 22/05 12:00).
          const [coH, coM] = coStandard.split(':').map(Number)
          const e = new Date(ci); e.setHours(coH, coM, 0, 0)
          segStart = ci          // giờ nhận thực tế
          segEnd   = e
        } else {
          // Bình thường: đêm 1 = ci → coStandard ngày HÔM SAU
          const tmp = new Date(ci); tmp.setDate(tmp.getDate() + 1)
          const [h, m] = coStandard.split(':').map(Number)
          tmp.setHours(h, m, 0, 0)
          segEnd = tmp
        }
      } else if (i === effectiveNights - 1) {
        // Đêm cuối: ciStandard → co thực
        if (sameDay && shouldAddNightForLateSameDay) {
          // Edge case: đêm 2 = ciStandard CÙNG NGÀY → co (vd 14:00 → 23:30)
          const tmp = new Date(ci)
          const [h, m] = ciStandard.split(':').map(Number)
          tmp.setHours(h, m, 0, 0)
          segStart = tmp
        } else {
          // ⭐ Early-CI: đã chèn 1 đêm hôm trước ở i=0 nên offset ngày giảm 1
          //   (đêm cuối vẫn bắt đầu = ciStandard của ngày CI + (i-1)).
          const dayOffset = shouldAddNightForEarlyCI ? i - 1 : i
          const tmp = new Date(ci); tmp.setDate(tmp.getDate() + dayOffset)
          const [h, m] = ciStandard.split(':').map(Number)
          tmp.setHours(h, m, 0, 0)
          segStart = tmp
        }
        // ⭐ FIX 16/05/2026 v19.2: Nếu co thực > coStandard (overstay) → label đêm cuối
        //   DỪNG ở coStandard thay vì kéo đến co. Phần [coStandard → co] tách
        //   thành surcharge "Trả phòng muộn" — tránh double counting.
        //   Guard isLastNightStartAfterCoStd: nếu segStart đã sau coStandard
        //   (vd đêm cuối bắt đầu 14:00 hoặc 18:00) → không phải overstay,
        //   đêm này chạy bình thường → segEnd = co.
        const [coStdH, coStdM] = coStandard.split(':').map(Number)
        const coStdMin = coStdH * 60 + coStdM
        const coMin    = co.getHours() * 60 + co.getMinutes()
        const segStartMin = segStart.getHours() * 60 + segStart.getMinutes()
        const sameDayLast = co.getFullYear() === segStart.getFullYear()
                         && co.getMonth() === segStart.getMonth()
                         && co.getDate()  === segStart.getDate()
        const isLastNightStartAfterCoStd = sameDayLast && segStartMin >= coStdMin
        if (coMin > coStdMin && !isLastNightStartAfterCoStd && (finalType === 'day' || finalType === 'night')) {
          // Đêm cuối tới giờ trả chuẩn — phần overstay sẽ vào surcharge "Trả phòng muộn"
          const tmpEnd = new Date(co)
          tmpEnd.setHours(coStdH, coStdM, 0, 0)
          segEnd = tmpEnd
        } else {
          segEnd = co
        }
      } else {
        // Đêm giữa
        // ⭐ Early-CI: đã chèn 1 đêm hôm trước ở i=0 → offset ngày giảm 1.
        const midOffset = shouldAddNightForEarlyCI ? i - 1 : i
        const a = new Date(ci); a.setDate(a.getDate() + midOffset)
        const [ah, am] = ciStandard.split(':').map(Number)
        a.setHours(ah, am, 0, 0)
        const b = new Date(ci); b.setDate(b.getDate() + midOffset + 1)
        const [bh, bm] = coStandard.split(':').map(Number)
        b.setHours(bh, bm, 0, 0)
        segStart = a; segEnd = b
      }
      const fmtDM   = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
      const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`
      const label = `Giá ngày (${fmtDM(segStart)} ${fmtTime(segStart)} - ${fmtDM(segEnd)} ${fmtTime(segEnd)})`
      // ⭐ Lưu startTime/endTime vào meta để calculateBill mode "now" biết đêm nào đã trôi qua
      breakdown.push({
        label, amount: dayPrice, type: 'base',
        meta: {
          startTime: segStart.toISOString(),
          endTime:   segEnd.toISOString(),
          // ⭐ Đánh dấu đêm này được "tự cộng" do convert late→night (để FE hiểu)
          ...(i === effectiveNights - 1 && (shouldAddNightForLate || shouldAddNightForLateSameDay)
              ? { autoConvertedNight: true }
              : {}),
        },
      })
      roomAmount += dayPrice

      // ⭐ Phụ thu NL của đêm này — push ngay sau giá ngày
      if (adultSurchargePerNight > 0) {
        breakdown.push({
          label: `Phụ thu ${extraAdults} người lớn (vượt ${resolvedMaxAdults} NL)`,
          amount: adultSurchargePerNight,
          type: 'surcharge',
          meta: { nightIndex: i },
        })
        roomAmount += adultSurchargePerNight
      }
      // ⭐ Phụ thu TE của đêm này — push ngay sau phụ thu NL
      //   ⭐ v2 (18/05/2026): TE phụ thu khi children > childFreeSlots
      //   (childFreeSlots = maxChildren + maxAdults dư). Label "vượt sức chứa chuẩn"
      //   thay vì "vượt N TE" vì TE phụ thu phụ thuộc tổng (NL+TE) chứ không chỉ TE riêng.
      if (childSurchargePerNight > 0) {
        breakdown.push({
          label: `Phụ thu ${extraChildren} trẻ em (vượt sức chứa chuẩn)`,
          amount: childSurchargePerNight,
          type: 'surcharge',
          meta: { nightIndex: i },
        })
        roomAmount += childSurchargePerNight
      }
    }

    // ⭐ Override nights để return — đếm đúng số đêm tính giá
    if (effectiveNights !== nights) {
      // Cập nhật biến nights local để các phần dưới (ví dụ giá đêm) cũng nhất quán
      // (Không reassign biến `nights` const ở trên — dùng biến mới qua return)
    }

    // (Phụ thu đã được tính xen kẽ trong loop trên, không cần block tổng nữa)

    // ⭐ Lưu effectiveNights để return + cho late-checkout block bên dưới biết
    // (truyền qua closure - sẽ đọc lại bằng cách check breakdown)
    // Trick: gắn flag tạm vào breakdown
    breakdown._effectiveNights = effectiveNights
    breakdown._isEarlyCheckinNight = isEarlyCheckinNight
    // ⭐ FIX 23/05/2026: Đánh dấu RIÊNG việc cộng đêm DO CHECKOUT MUỘN (late→night convert).
    //   KHÔNG gộp với early-CI. Late-checkout block bên dưới chỉ bị chặn khi đêm cuối
    //   thực sự cộng do CO vượt dayEquiv — không phải do early check-in cộng đêm hôm trước.
    breakdown._lateConvertedNight = (shouldAddNightForLate || shouldAddNightForLateSameDay) === true
  }

  // ─── Giá Đêm ───
  else if (finalType === 'night' && policy.nightEnabled) {
    const nightPrice = policy.nightPrice ?? 0
    breakdown.push({ label: `Giá đêm × ${nights} đêm`, amount: nightPrice * nights, type: 'base' })
    roomAmount += nightPrice * nights
  }

  // ─── Giá Tuần ───
  else if (finalType === 'week' && policy.weekEnabled) {
    const w = Math.max(1, Math.ceil(nights / 7))
    breakdown.push({ label: `Giá tuần × ${w} tuần`, amount: (policy.weekPrice ?? 0) * w, type: 'base' })
    roomAmount += (policy.weekPrice ?? 0) * w
  }

  // ─── Giá Tháng ───
  else if (finalType === 'month' && policy.monthEnabled) {
    const m = Math.max(1, Math.ceil(nights / 30))
    breakdown.push({ label: `Giá tháng × ${m} tháng`, amount: (policy.monthPrice ?? 0) * m, type: 'base' })
    roomAmount += (policy.monthPrice ?? 0) * m
  }

  // Helper format "X giờ Y phút" cho label
  const fmtHourMin = (totalMin) => {
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    if (h === 0) return `${m} phút`
    if (m === 0) return `${h} giờ`
    return `${h} giờ, ${m} phút`
  }

  // ──────────────────────────────────────────────────
  // ⭐ PHỤ THU EARLY CHECK-IN — chỉ áp dụng khi vượt tolerance
  //    + KHÔNG áp dụng khi finalType = 'hour' (giá giờ tự nó tính)
  //    + KHÔNG áp dụng khi cùng ngày (theo yêu cầu)
  //    + KHÔNG áp dụng nếu CI nằm trong ngưỡng "early-checkin night" (vd 00:00–05:00)
  //      vì đã tính 1 đêm trọn rồi
  //    + Làm tròn theo tolerance: 1h15p vẫn là 1h, 1h16p mới là 2h
  // ──────────────────────────────────────────────────
  const isEarlyCheckinNight = breakdown._isEarlyCheckinNight === true
  if (finalType === 'day' && !sameDay && !isEarlyCheckinNight && policy.dayEarlyCheckIn?.length > 0) {
    const allowMin = toMinutes(policy.dayCheckInTime ?? ciStandard)
    const ciMin    = ci.getHours() * 60 + ci.getMinutes()
    const earlyMin = allowMin - ciMin
    if (earlyMin > tolerance) {
      const earlyH = roundHoursWithTolerance(earlyMin, tolerance)
      if (earlyH > 0) {
        const sur = pickSlot(policy.dayEarlyCheckIn, earlyH)
        if (sur) {
          breakdown.push({
            label: `Nhận phòng sớm (${fmtHourMin(earlyMin)})`,
            amount: sur.price, type: 'surcharge',
          })
          roomAmount += sur.price
        }
      }
    }
  }

  // ──────────────────────────────────────────────────
  // ⭐ PHỤ THU LATE CHECK-OUT — chỉ áp dụng khi vượt tolerance
  //    + KHÔNG áp dụng khi finalType = 'hour'
  //    + KHÔNG áp dụng khi cùng ngày (trừ early-checkin night → có thể có CO trễ trong cùng ngày)
  //    + KHÔNG áp dụng nếu đã convert late→night (vì đã thêm 1 đêm thay phụ thu)
  //    + Làm tròn theo tolerance: 1h15p vẫn là 1h, 1h16p mới là 2h
  // ──────────────────────────────────────────────────
  const effectiveNightsTotal = breakdown._effectiveNights ?? nights
  // ⭐ FIX 23/05/2026: Chỉ chặn late-checkout khi đêm cuối cộng DO CHECKOUT MUỘN (late→night).
  //   Trước đây dùng (effectiveNights > nights) → SAI khi early-checkin cộng đêm hôm trước
  //   (effectiveNights > nights nhưng KHÔNG do checkout muộn) → late-checkout bị skip oan,
  //   mất phụ thu trả muộn. Đó là lỗi BK_5SR2X7 (CI rạng sáng, quá 12:00 không tính phụ thu).
  const wasConvertedToNight  = breakdown._lateConvertedNight === true
  // Cho phép tính late checkout TRONG cùng ngày NẾU là early-checkin night (CI 02:00 → CO 14:00)
  const allowLateCheckout = !sameDay || isEarlyCheckinNight
  if ((finalType === 'day' || finalType === 'night')
      && allowLateCheckout
      && !wasConvertedToNight
      && policy.dayLateCheckOut?.length > 0) {
    const allowMin = toMinutes(policy.dayCheckOutTime ?? coStandard)
    const coMin    = co.getHours() * 60 + co.getMinutes()
    const lateMin  = coMin - allowMin
    if (lateMin > tolerance) {
      const lateH = roundHoursWithTolerance(lateMin, tolerance)
      if (lateH > 0) {
        const sur = pickSlot(policy.dayLateCheckOut, lateH)
        if (sur) {
          breakdown.push({
            label: `Trả phòng muộn (${fmtHourMin(lateMin)})`,
            amount: sur.price, type: 'surcharge',
          })
          roomAmount += sur.price
        }
      }
    }
  }

  // ⭐ Cleanup: xoá flag tạm trên breakdown trước khi return
  delete breakdown._effectiveNights
  delete breakdown._isEarlyCheckinNight
  delete breakdown._lateConvertedNight

  return {
    roomAmount,
    nights: effectiveNightsTotal,
    finalPriceType: finalType,
    originalPriceType: requestedType,
    converted, notice,
    breakdown,
  }
}

module.exports = {
  calculatePrice,
  // Export helpers để FE có thể tham chiếu nếu cần
  toMinutes, isSameDay, roundHoursWithTolerance, calcNights, pickSlot,
  computeExtra,   // ⭐ NEW v2 (18/05/2026) — export for testing
}