// ─────────────────────────────────────────────────────────
// utils/priceCalculator.js
// Logic tính giá tập trung — đảm bảo BE trả ra số tiền giống FE
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
 * Làm tròn số giờ với tolerance.
 * tolerance = 15 →
 *   - 0h00 - 0h15: chưa tính tiền (0h, "miễn phí giờ ân huệ")
 *   - 0h16 - 1h15: tính 1h
 *   - 1h16 - 2h15: tính 2h
 *   - 3h15: vẫn là 3h, 3h16 mới lên 4h
 */
const roundHoursWithTolerance = (totalMinutes, toleranceMin) => {
  const fullHours = Math.floor(totalMinutes / 60)
  const remainder = totalMinutes - fullHours * 60
  if (remainder <= toleranceMin) return fullHours   // ← KHÔNG ép min = 1
  return fullHours + 1
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
 *
 * slots: [{ time: '1', price: 50000 }, { time: '3', price: 100000 }]
 */
const getSlotHours = (s) => {
  // Hỗ trợ multiple field names
  const v = s?.time ?? s?.hours ?? s?.duration ?? s?.h ?? null
  if (v === null || v === undefined) return null
  const n = parseInt(v, 10)
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
  return sorted
    .filter(s => s.time <= hours)
    .sort((a, b) => b.time - a.time)[0] ?? null
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
 * @param {number} input.capacity         - Sức chứa loại phòng
 *
 * @returns {Object} {
 *   roomAmount,        // Tổng tiền phòng (đã gồm phụ thu)
 *   nights,            // Số đêm thực
 *   finalPriceType,    // Loại giá thực sự áp dụng (sau auto-convert)
 *   originalPriceType, // Loại giá user chọn ban đầu
 *   converted,         // boolean — có auto-convert không
 *   notice,            // string — thông báo cho user (nếu converted)
 *   breakdown: [{ label, amount, type: 'base'|'surcharge' }]
 * }
 */
function calculatePrice(input) {
  const {
    checkIn, checkOut, priceType: requestedType = 'day',
    policy, branch, adults = 2, children = 0, capacity = 2,
  } = input

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
  const ciStandard       = branch?.checkInTime           ?? '14:00'
  const coStandard       = branch?.checkOutTime          ?? '12:00'

  // ⭐ Số giờ thực tế đã làm tròn theo tolerance
  const hoursRounded = roundHoursWithTolerance(diffMin, tolerance)
  const sameDay      = isSameDay(ci, co)

  // ──────────────────────────────────────────────────
  // ⭐ AUTO-CONVERT priceType
  // ──────────────────────────────────────────────────
  let finalType = requestedType
  let converted = false
  let notice    = ''

  if (autoConvert && policy) {
    // Case 1: User chọn 'day' nhưng ở ngắn (cùng ngày + < threshold giờ)
    //   → chuyển sang 'hour'
    if (requestedType === 'day' && sameDay && hoursRounded < hourToDayThresh && policy.hourEnabled) {
      finalType = 'hour'
      converted = true
      notice = `Tự chuyển sang Giá Giờ vì khách ở ${hoursRounded}h (ngắn hơn ${hourToDayThresh} tiếng).`
    }

    // Case 2: User chọn 'hour' nhưng checkout VƯỢT mốc dayEquivalentHours (vd 23:00) trong cùng ngày
    //   → auto chuyển 'day'
    //   Vd: dayEquivalentHours = 23 → nghỉ giờ vượt 23:00 cùng ngày → tính giá ngày
    else if (requestedType === 'hour' && sameDay && policy.dayEnabled) {
      const coHourMin = co.getHours() * 60 + co.getMinutes()
      const dayEquivThresholdMin = dayEquivHours * 60   // 23:00 = 23 × 60 = 1380 phút
      if (coHourMin >= dayEquivThresholdMin) {
        finalType = 'day'
        converted = true
        const coHourStr = `${String(co.getHours()).padStart(2,'0')}:${String(co.getMinutes()).padStart(2,'0')}`
        const equivHourStr = `${String(dayEquivHours).padStart(2,'0')}:00`
        notice = `Tự chuyển sang Giá Ngày vì khách trả phòng lúc ${coHourStr} (vượt mốc ${equivHourStr}).`
      }
    }

    // Case 3: User chọn 'hour' nhưng qua đêm — auto chuyển 'day'
    else if (requestedType === 'hour' && !sameDay && policy.dayEnabled) {
      finalType = 'day'
      converted = true
      notice = `Tự chuyển sang Giá Ngày vì khách ở qua đêm.`
    }
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

  // ⭐ EARLY RETURN: nếu khoảng thời gian ≤ tolerance → MIỄN PHÍ (chưa tính tiền)
  // Áp dụng cho mọi loại giá (Giờ, Ngày, Đêm...)
  if (diffMin <= tolerance) {
    breakdown.push({
      label: `Mới ${Math.max(0, Math.floor(diffMin))} Phút (Linh hoạt ${tolerance}p — miễn phí)`,
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

    // Số đêm thực tế tính giá (sau khi áp early/late convert)
    let effectiveNights = nights
    if (shouldAddNightForLate || shouldAddNightForLateSameDay) {
      effectiveNights = nights + 1
    }

    // ⭐ Tách thành từng "ngày ở" với khoảng thời gian cụ thể
    // Mỗi đêm = từ check-in time → check-out time của ngày hôm sau
    // Đêm đầu: ci thực tế → coStandard ngày hôm sau (hoặc co thực tế nếu sameDay)
    // Đêm giữa: ciStandard hôm i → coStandard hôm i+1
    // Đêm cuối: ciStandard → co thực tế
    //
    // Để đơn giản & match UI ezCloud: hiển thị 'Giá ngày (DD/MM HH:mm - DD/MM HH:mm)'
    // mỗi đêm 1 dòng, dùng giờ chuẩn cho các đêm giữa
    for (let i = 0; i < effectiveNights; i++) {
      let segStart, segEnd
      if (effectiveNights === 1) {
        // 1 đêm duy nhất: dùng giờ thực tế cả 2 đầu
        segStart = ci
        segEnd   = co
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
          const tmp = new Date(ci); tmp.setDate(tmp.getDate() + i)
          const [h, m] = ciStandard.split(':').map(Number)
          tmp.setHours(h, m, 0, 0)
          segStart = tmp
        }
        segEnd   = co
      } else {
        // Đêm giữa
        const a = new Date(ci); a.setDate(a.getDate() + i)
        const [ah, am] = ciStandard.split(':').map(Number)
        a.setHours(ah, am, 0, 0)
        const b = new Date(ci); b.setDate(b.getDate() + i + 1)
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
    }

    // ⭐ Override nights để return — đếm đúng số đêm tính giá
    if (effectiveNights !== nights) {
      // Cập nhật biến nights local để các phần dưới (ví dụ giá đêm) cũng nhất quán
      // (Không reassign biến `nights` const ở trên — dùng biến mới qua return)
    }

    // Phụ thu vượt capacity
    const extraAdults = Math.max(0, adults - capacity)
    if (extraAdults > 0) {
      const amt = (policy.dayAdultSurcharge ?? 0) * extraAdults
      breakdown.push({ label: `Phụ thu ${extraAdults} người lớn (vượt ${capacity} người)`, amount: amt, type: 'surcharge' })
      roomAmount += amt
    }
    if (children > 0) {
      const amt = (policy.dayChildSurcharge ?? 0) * children
      breakdown.push({ label: `Phụ thu ${children} trẻ em`, amount: amt, type: 'surcharge' })
      roomAmount += amt
    }

    // ⭐ Lưu effectiveNights để return + cho late-checkout block bên dưới biết
    // (truyền qua closure - sẽ đọc lại bằng cách check breakdown)
    // Trick: gắn flag tạm vào breakdown
    breakdown._effectiveNights = effectiveNights
    breakdown._isEarlyCheckinNight = isEarlyCheckinNight
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
  const wasConvertedToNight  = effectiveNightsTotal > nights
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
}