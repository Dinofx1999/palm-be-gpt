/**
 * ════════════════════════════════════════════════════════════════════════════
 * moveRoomBreakdown.js — Logic tính priceBreakdown sau khi đổi phòng
 * Spec v20.0 — 17/05/2026 (final)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * INPUT:
 *   {
 *     actualCheckIn:   Date,
 *     plannedCheckOut: Date,
 *     transferAt:      Date,
 *     oldRoom: { number, type, policy: {dayPrice, hourSlots:[{durationHours, price}]} },
 *     newRoom: { number, type, policy },
 *     transferFee:     number,
 *     changeRate:      boolean,
 *     isFreeRoom:      boolean,
 *   }
 *
 * OUTPUT: array of { label, amount, type, meta }
 *
 * 12 test case PASS (xem moveRoomBreakdown.test.js)
 * ════════════════════════════════════════════════════════════════════════════
 */

const CONFIG = Object.freeze({
  CI_HOUR: 14,
  CO_HOUR: 12,
  TRANSFER_TOLERANCE_MIN: 15,
  EARLY_MORNING_END_HOUR: 6,
})

const pad2 = (n) => String(n).padStart(2, '0')
const fmtDT = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`

const minutesBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / 60000)

const isSameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

const dayStart = (d) => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

const standardCheckoutOf = (d) => {
  const x = new Date(d)
  x.setHours(CONFIG.CO_HOUR, 0, 0, 0)
  return x
}

const standardCheckinOf = (d) => {
  const x = new Date(d)
  x.setHours(CONFIG.CI_HOUR, 0, 0, 0)
  return x
}

function countNights(start, end) {
  const s = dayStart(start)
  const e = dayStart(end)
  return Math.max(1, Math.round((e - s) / 86400000))
}

function isEarlyMorning(transferAt, actualCheckIn) {
  if (transferAt.getHours() >= CONFIG.EARLY_MORNING_END_HOUR) return false
  const diffDays = Math.round((dayStart(transferAt) - dayStart(actualCheckIn)) / 86400000)
  return diffDays === 1
}

function nightsCompleted(actualCheckIn, transferAt) {
  let n = 0
  const ci = new Date(actualCheckIn)
  let mark = dayStart(new Date(ci.getTime() + 86400000))
  while (mark <= transferAt) {
    n++
    mark = new Date(mark.getTime() + 86400000)
  }
  return n
}

function pickHourSlot(policy, durationMin) {
  if (!policy || !policy.hourSlots || policy.hourSlots.length === 0) return 0
  const hours = Math.ceil(durationMin / 60)
  const candidates = policy.hourSlots
    .filter(s => s.durationHours >= hours)
    .sort((a, b) => a.durationHours - b.durationHours)
  if (candidates.length > 0) return candidates[0].price
  return policy.hourSlots.reduce((max, s) => s.durationHours > max.durationHours ? s : max).price
}

// ════════════════════════════════════════════════════════════════════════════
function computeMoveRoomBreakdown(input) {
  const {
    actualCheckIn,
    plannedCheckOut,
    transferAt,
    oldRoom,
    newRoom,
    transferFee = 0,
    changeRate = false,
    isFreeRoom = false,
  } = input

  if (!actualCheckIn || !plannedCheckOut || !transferAt) {
    throw new Error('Missing required date inputs')
  }
  if (!oldRoom || !oldRoom.policy || !newRoom || !newRoom.policy) {
    throw new Error('Missing room policies')
  }

  const items = []

  const addFeeItem = () => {
    if (transferFee > 0) {
      items.push({
        label: `Phụ thu chuyển phòng ${oldRoom.number} → ${newRoom.number}`,
        amount: transferFee,
        type: 'surcharge',
        meta: {
          transferFee: true,
          fromRoom: oldRoom.number,
          toRoom: newRoom.number,
        },
      })
    }
  }

  // RULE: isFreeRoom → chỉ phí chuyển
  if (isFreeRoom) {
    addFeeItem()
    return items
  }

  const sameType        = oldRoom.type === newRoom.type
  const useNewPolicy    = !sameType && changeRate
  const policyCurrent   = useNewPolicy ? newRoom.policy : oldRoom.policy
  const typeLabelCurr   = useNewPolicy ? newRoom.type   : oldRoom.type
  const stayInNew       = minutesBetween(transferAt, plannedCheckOut)
  const isTiny          = stayInNew <= CONFIG.TRANSFER_TOLERANCE_MIN
  const earlyMorning    = isEarlyMorning(transferAt, actualCheckIn)
  const nightsBefore    = nightsCompleted(actualCheckIn, transferAt)
  const checkoutSameDay = isSameDay(transferAt, plannedCheckOut)
  const totalNights     = countNights(actualCheckIn, plannedCheckOut)

  // TINY: phòng mới ≤ 15p → coi như chỉ ở phòng cũ đến transferAt
  if (isTiny) {
    items.push({
      label: `[${oldRoom.number}] Giá ngày (${fmtDT(actualCheckIn)} → ${fmtDT(transferAt)})`,
      amount: oldRoom.policy.dayPrice * Math.max(1, nightsCompleted(actualCheckIn, transferAt)) || oldRoom.policy.dayPrice,
      type: 'base',
      meta: { segment: 'tiny', roomNumber: oldRoom.number },
    })
    addFeeItem()
    return items
  }

  // MODE A: 1 đêm duy nhất, label phòng MỚI
  if (earlyMorning || (nightsBefore === 0 && totalNights === 1)) {
    const labelPrefix = sameType
      ? `[${newRoom.number}]`
      : `[${newRoom.number}] ${typeLabelCurr} -`
    items.push({
      label: `${labelPrefix} Giá ngày (${fmtDT(actualCheckIn)} → ${fmtDT(plannedCheckOut)})`,
      amount: policyCurrent.dayPrice,
      type: 'base',
      meta: {
        segment: 'A',
        roomNumber: newRoom.number,
        policy: useNewPolicy ? 'new' : 'old',
      },
    })
    addFeeItem()
    return items
  }

  // MODE D: Chuyển ngày kế CI trước 12:00 → ở tiếp qua đêm
  const transferBeforeStdCO = transferAt < standardCheckoutOf(transferAt)
  const isFirstDayAfterCI =
    !isSameDay(actualCheckIn, transferAt) &&
    isSameDay(new Date(actualCheckIn.getTime() + 86400000), transferAt)

  if (transferBeforeStdCO && isFirstDayAfterCI && totalNights >= 2 && !earlyMorning) {
    items.push({
      label: `[${oldRoom.number}] Giá ngày (${fmtDT(actualCheckIn)} → ${fmtDT(transferAt)})`,
      amount: oldRoom.policy.dayPrice,
      type: 'base',
      meta: { segment: 'D1', roomNumber: oldRoom.number, policy: 'old' },
    })
    addFeeItem()

    const seg2End = standardCheckoutOf(new Date(transferAt.getTime() + 86400000))
    items.push({
      label: `[${newRoom.number}] Giá ngày (${fmtDT(transferAt)} → ${fmtDT(seg2End)})`,
      amount: newRoom.policy.dayPrice,
      type: 'base',
      meta: { segment: 'D2', roomNumber: newRoom.number, policy: 'new' },
    })

    if (seg2End < plannedCheckOut) {
      const seg3Start = standardCheckinOf(seg2End)
      if (seg3Start < plannedCheckOut) {
        const nights3 = countNights(seg3Start, plannedCheckOut)
        items.push({
          label: `[${newRoom.number}] Giá ngày (${fmtDT(seg3Start)} → ${fmtDT(plannedCheckOut)})`,
          amount: newRoom.policy.dayPrice * nights3,
          type: 'base',
          meta: { segment: 'D3', roomNumber: newRoom.number, policy: 'new', nights: nights3 },
        })
      }
    }
    return items
  }

  // MODE C: Sau qua đêm + checkout cùng ngày
  if (nightsBefore >= 1 && checkoutSameDay) {
    items.push({
      label: `[${oldRoom.number}] Giá ngày (${fmtDT(actualCheckIn)} → ${fmtDT(transferAt)})`,
      amount: oldRoom.policy.dayPrice * nightsBefore,
      type: 'base',
      meta: { segment: 'C1', roomNumber: oldRoom.number, nights: nightsBefore },
    })
    addFeeItem()

    const hourPrice = pickHourSlot(newRoom.policy, minutesBetween(transferAt, plannedCheckOut))
    items.push({
      label: `[${newRoom.number}] Giá nghỉ giờ (${fmtDT(transferAt)} → ${fmtDT(plannedCheckOut)})`,
      amount: hourPrice,
      type: 'base',
      meta: { segment: 'C2', roomNumber: newRoom.number, hourly: true },
    })
    return items
  }

  // MODE B: Sau qua đêm + ở tiếp
  if (nightsBefore >= 1 && !checkoutSameDay) {
    const seg1End = standardCheckoutOf(transferAt)
    items.push({
      label: `[${oldRoom.number}] ${oldRoom.type} - Giá ngày (${fmtDT(actualCheckIn)} → ${fmtDT(seg1End)})`,
      amount: oldRoom.policy.dayPrice * nightsBefore,
      type: 'base',
      meta: { segment: 'B1', roomNumber: oldRoom.number, nights: nightsBefore },
    })
    addFeeItem()

    const seg2Nights = countNights(transferAt, plannedCheckOut)
    items.push({
      label: `[${newRoom.number}] ${typeLabelCurr} - Giá ngày (${fmtDT(transferAt)} → ${fmtDT(plannedCheckOut)})`,
      amount: policyCurrent.dayPrice * seg2Nights,
      type: 'base',
      meta: {
        segment: 'B2',
        roomNumber: newRoom.number,
        nights: seg2Nights,
        policy: useNewPolicy ? 'new' : 'old',
      },
    })
    return items
  }

  console.warn('[moveRoomBreakdown] No branch matched. Input:', {
    actualCheckIn, plannedCheckOut, transferAt,
    nightsBefore, totalNights, earlyMorning, checkoutSameDay,
  })
  return items
}

module.exports = {
  computeMoveRoomBreakdown,
  CONFIG,
  _internals: {
    isEarlyMorning,
    nightsCompleted,
    countNights,
    pickHourSlot,
    standardCheckoutOf,
    standardCheckinOf,
  },
}