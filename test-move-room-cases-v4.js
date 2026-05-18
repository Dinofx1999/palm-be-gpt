/**
 * ════════════════════════════════════════════════════════════════════════════
 * MOVE-ROOM LOGIC v4 — Decision tree đúng spec
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Spec 9 case → rút gọn thành 4 mode tính giá:
 *
 *   MODE A: SINGLE_NIGHT_NEW_LABEL
 *     - 1 đêm duy nhất, label phòng mới, policy theo flag
 *     - Áp dụng cho: cùng loại (#1), khác loại không tick/có tick trong đêm CI (#2,#3),
 *                    rạng sáng (#5)
 *
 *   MODE B: TWO_SEGMENTS_OVERNIGHT
 *     - SEG1 phòng cũ (các đêm đã hoàn thành), SEG2 phòng mới (các đêm sau)
 *     - Áp dụng cho: chuyển sau qua đêm (#4)
 *
 *   MODE C: CHECKOUT_SAME_DAY_AFTER_TRANSFER
 *     - SEG1 phòng cũ (các đêm) + SEG2 giá giờ phòng mới
 *     - Áp dụng cho: chuyển rồi checkout luôn (#6)
 *
 *   MODE D: CHECKIN_DAY_TRANSFER_THEN_OVERNIGHT
 *     - SEG1 phòng cũ (đêm CI) + SEG2 phòng mới (đêm absorb) + SEG3 các đêm tiếp
 *     - Áp dụng cho: chuyển sáng/trưa ngày hôm sau, ở tiếp (#7)
 *
 *   FREE: isFreeRoom → chỉ phí chuyển (#9)
 *   TINY: ≤ 15p → SEG1 phòng cũ + phí
 *
 *   GROUP (#8): chỉ touch sub-room — wrap quanh logic trên
 * ════════════════════════════════════════════════════════════════════════════
 */

const CONFIG = {
  CI_HOUR: 14,
  CO_HOUR: 12,
  TRANSFER_TOLERANCE_MIN: 15,
  EARLY_MORNING_END_HOUR: 6,
}

const pad = (n) => String(n).padStart(2, '0')
const fmtDT = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
const fmtMoney = (n) => (n ?? 0).toLocaleString('vi-VN')

const minutesBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / 60000)

const isSameDay = (a, b) => a.getFullYear() === b.getFullYear()
  && a.getMonth() === b.getMonth()
  && a.getDate() === b.getDate()

const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }

const standardCheckoutOf = (d) => {
  const x = new Date(d); x.setHours(CONFIG.CO_HOUR, 0, 0, 0); return x
}
const standardCheckinOf = (d) => {
  const x = new Date(d); x.setHours(CONFIG.CI_HOUR, 0, 0, 0); return x
}

// ─── Đếm đêm cross-midnight giữa 2 mốc ───
function countNights(start, end) {
  const s = dayStart(start)
  const e = dayStart(end)
  return Math.max(1, Math.round((e - s) / 86400000))
}

// ─── Rạng sáng: transferAt ∈ [00:00, 06:00) và là ngày SAU check-in ───
function isEarlyMorning(transferAt, actualCheckIn) {
  if (transferAt.getHours() >= CONFIG.EARLY_MORNING_END_HOUR) return false
  const diffDays = Math.round((dayStart(transferAt) - dayStart(actualCheckIn)) / 86400000)
  return diffDays === 1
}

// ─── Đếm số đêm khách đã trải qua trước transferAt
//     Quy ước: đêm hoàn thành khi cross midnight (00:00)
//     Lưu ý: rạng sáng (00:00-06:00) sẽ được handle riêng bằng isEarlyMorning
function nightsCompleted(actualCheckIn, transferAt) {
  let n = 0
  const ci = new Date(actualCheckIn)
  let mark = dayStart(new Date(ci.getTime() + 86400000)) // midnight ngày kế
  while (mark <= transferAt) {
    n++
    mark = new Date(mark.getTime() + 86400000)
  }
  return n
}

// ─── Pick slot giá giờ phù hợp ───
function pickHourSlot(policy, durationMin) {
  // Stub: trả về slot 2h cho duration ≤ 120m, slot lớn hơn cho lâu hơn
  if (!policy.hourSlots || policy.hourSlots.length === 0) return 0
  const hours = Math.ceil(durationMin / 60)
  let bestSlot = policy.hourSlots[0]
  for (const slot of policy.hourSlots) {
    if (slot.durationHours >= hours && slot.durationHours <= bestSlot.durationHours) bestSlot = slot
    if (slot.durationHours >= hours && bestSlot.durationHours < hours) bestSlot = slot
  }
  // Fallback: nếu không có slot lớn hơn → lấy slot lớn nhất
  if (bestSlot.durationHours < hours) {
    bestSlot = policy.hourSlots.reduce((a, b) => a.durationHours > b.durationHours ? a : b)
  }
  return bestSlot.price
}

// ════════════════════════════════════════════════════════════════════════════
// CORE
// ════════════════════════════════════════════════════════════════════════════
function compute(input) {
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

  const items = []
  const addFee = () => {
    if (transferFee > 0) {
      items.push({
        label: `Phụ thu chuyển phòng ${oldRoom.number} → ${newRoom.number}`,
        amount: transferFee,
        type: 'surcharge',
      })
    }
  }

  // ─── ISFREEROOM ───
  if (isFreeRoom) {
    addFee()
    return items
  }

  // ─── Đánh giá ───
  const sameType        = oldRoom.type === newRoom.type
  const useNewPolicy    = !sameType && changeRate
  const policyCurrent   = useNewPolicy ? newRoom.policy : oldRoom.policy
  const typeLabelCurr   = useNewPolicy ? newRoom.type   : oldRoom.type
  const stayInNew       = minutesBetween(transferAt, plannedCheckOut)
  const isTiny          = stayInNew <= CONFIG.TRANSFER_TOLERANCE_MIN
  const earlyMorning    = isEarlyMorning(transferAt, actualCheckIn)
  const nightsBefore    = nightsCompleted(actualCheckIn, transferAt)
  const checkoutSameDay = isSameDay(transferAt, plannedCheckOut)

  // ─── TINY: phòng mới ≤ 15p ───
  if (isTiny) {
    // Coi như chỉ ở phòng cũ
    const totalNights = countNights(actualCheckIn, plannedCheckOut)
    items.push({
      label: `[${oldRoom.number}] Giá ngày (${fmtDT(actualCheckIn)} → ${fmtDT(plannedCheckOut)})`,
      amount: oldRoom.policy.dayPrice * totalNights,
      type: 'base',
    })
    addFee()
    return items
  }

  // ─── MODE A: 1 đêm duy nhất, label phòng MỚI ───
  //   Áp dụng khi: chuyển trong cùng "thời gian khách ở 1 đêm chuẩn"
  //   - Cùng loại (sameType): #1
  //   - Khác loại trong đêm CI (#2, #3)
  //   - Rạng sáng (#5)
  //
  //   Điều kiện kết hợp: earlyMorning OR (nightsBefore === 0 && countNights(CI,CO) === 1)
  //   → tức là tổng book này CHỈ 1 đêm, transfer xảy ra trong đêm đó
  const totalNightsBooking = countNights(actualCheckIn, plannedCheckOut)
  if (earlyMorning || (nightsBefore === 0 && totalNightsBooking === 1)) {
    const labelPrefix = sameType
      ? `[${newRoom.number}]`
      : `[${newRoom.number}] ${typeLabelCurr} -`
    items.push({
      label: `${labelPrefix} Giá ngày (${fmtDT(actualCheckIn)} → ${fmtDT(plannedCheckOut)})`,
      amount: policyCurrent.dayPrice,
      type: 'base',
    })
    addFee()
    return items
  }

  // ─── MODE C: Chuyển rồi checkout cùng ngày SAU khi qua đêm (#6) ───
  //   nightsBefore >= 1 và checkoutSameDay
  //   - SEG1: phòng cũ (các đêm đã qua) → label cũ + policy cũ, end = transferAt
  //   - SEG2: phòng mới → giá GIỜ
  if (nightsBefore >= 1 && checkoutSameDay) {
    // SEG1: từ check-in → transferAt (giờ thực tế chuyển phòng)
    items.push({
      label: `[${oldRoom.number}] Giá ngày (${fmtDT(actualCheckIn)} → ${fmtDT(transferAt)})`,
      amount: oldRoom.policy.dayPrice * nightsBefore,
      type: 'base',
    })
    addFee()
    // SEG2: giá giờ phòng mới
    const hourPrice = pickHourSlot(newRoom.policy, minutesBetween(transferAt, plannedCheckOut))
    items.push({
      label: `[${newRoom.number}] Giá nghỉ giờ (${fmtDT(transferAt)} → ${fmtDT(plannedCheckOut)})`,
      amount: hourPrice,
      type: 'base',
    })
    return items
  }

  // ─── MODE D: Chuyển trong ngày check-in HOẶC chuyển ngày kế trước std CO → ở tiếp qua đêm (#7) ───
  //   Điều kiện: transferAt < std CO của ngày transfer (12:00) → đoạn gap absorb
  //              ngày transfer là ngày kế check-in (nightsBefore===0 theo midnight nhưng nightsBefore===0 theo std CO)
  //   Spec #7: check-in 15/05 15:33, transferAt 16/05 11:56 → trước 12:00 → absorb
  //   Spec #4: check-in 15/05 15:00, transferAt 16/05 15:00 → sau 12:00 → Mode B
  const transferBeforeStdCO = transferAt < standardCheckoutOf(transferAt)
  const isFirstDayAfterCI = !isSameDay(actualCheckIn, transferAt)
                          && isSameDay(new Date(actualCheckIn.getTime() + 86400000), transferAt)

  if (transferBeforeStdCO && isFirstDayAfterCI && totalNightsBooking >= 2 && !earlyMorning) {
    // SEG1: phòng cũ — từ check-in → transferAt (đêm 1 full)
    items.push({
      label: `[${oldRoom.number}] Giá ngày (${fmtDT(actualCheckIn)} → ${fmtDT(transferAt)})`,
      amount: oldRoom.policy.dayPrice,
      type: 'base',
    })
    addFee()

    // SEG2: phòng mới — đêm absorb (transferAt → std CO ngày kế)
    const seg2End = standardCheckoutOf(new Date(transferAt.getTime() + 86400000))
    items.push({
      label: `[${newRoom.number}] Giá ngày (${fmtDT(transferAt)} → ${fmtDT(seg2End)})`,
      amount: newRoom.policy.dayPrice,
      type: 'base',
    })

    // SEG3: nếu còn ngày → các đêm tiếp (14:00 → checkout)
    if (seg2End < plannedCheckOut) {
      const seg3Start = standardCheckinOf(seg2End)
      if (seg3Start < plannedCheckOut) {
        const nights3 = countNights(seg3Start, plannedCheckOut)
        items.push({
          label: `[${newRoom.number}] Giá ngày (${fmtDT(seg3Start)} → ${fmtDT(plannedCheckOut)})`,
          amount: newRoom.policy.dayPrice * nights3,
          type: 'base',
        })
      }
    }
    return items
  }

  // ─── MODE B: Sau khi đã qua đêm — 2 segments (#4) ───
  if (nightsBefore >= 1 && !checkoutSameDay) {
    // SEG1: phòng cũ — các đêm đã qua, end = std checkout ngày transfer
    const seg1End = standardCheckoutOf(transferAt)
    items.push({
      label: `[${oldRoom.number}] ${oldRoom.type} - Giá ngày (${fmtDT(actualCheckIn)} → ${fmtDT(seg1End)})`,
      amount: oldRoom.policy.dayPrice * nightsBefore,
      type: 'base',
    })
    addFee()

    // SEG2: phòng mới — từ transferAt → plannedCheckOut
    // Tính số đêm dựa trên cross-midnight
    const seg2Nights = countNights(transferAt, plannedCheckOut)
    items.push({
      label: `[${newRoom.number}] ${typeLabelCurr} - Giá ngày (${fmtDT(transferAt)} → ${fmtDT(plannedCheckOut)})`,
      amount: policyCurrent.dayPrice * seg2Nights,
      type: 'base',
    })
    return items
  }

  // FALLBACK
  console.warn('⚠ Không match branch nào! Input:', input)
  return items
}

// ════════════════════════════════════════════════════════════════════════════
// TEST
// ════════════════════════════════════════════════════════════════════════════
function runTest(t) {
  console.log('═'.repeat(82))
  console.log(`📋 ${t.name}`)
  console.log('─'.repeat(82))
  const result = compute(t.input)
  let total = 0
  console.log('OUTPUT:')
  for (let i = 0; i < result.length; i++) {
    const r = result[i]
    console.log(`  ${(i + 1).toString().padStart(2)}. ${r.label.padEnd(58)} ${fmtMoney(r.amount).padStart(12)}`)
    total += r.amount
  }
  console.log('  ' + '─'.repeat(74))
  console.log(`  ${'Tổng:'.padEnd(62)} ${fmtMoney(total).padStart(12)}`)
  console.log(`  ${'Expected:'.padEnd(62)} ${fmtMoney(t.expectedTotal).padStart(12)}`)
  const ok = total === t.expectedTotal
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}`)
  console.log()
  return ok
}

const D = (s) => {
  const [date, time] = s.split(' ')
  const [dd, mm] = date.split('/').map(Number)
  const [HH, MM] = time.split(':').map(Number)
  return new Date(2026, mm - 1, dd, HH, MM, 0, 0)
}

const DELUXE    = { dayPrice: 550000, hourSlots: [{ durationHours: 2, price: 100000 }] }
const STANDARD  = { dayPrice: 450000, hourSlots: [{ durationHours: 2, price: 80000 }] }
const PHONG_602 = { dayPrice: 500000, hourSlots: [{ durationHours: 2, price: 90000 }] }
const PHONG_502 = { dayPrice: 550000, hourSlots: [{ durationHours: 2, price: 100000 }] }

const tests = [
  { name: '#1A — Cùng loại + phí 50K',
    input: { actualCheckIn: D('15/05 15:00'), plannedCheckOut: D('16/05 12:00'), transferAt: D('15/05 18:00'),
      oldRoom: { number: '604', type: 'Deluxe', policy: DELUXE },
      newRoom: { number: '605', type: 'Deluxe', policy: DELUXE },
      transferFee: 50000, changeRate: false, isFreeRoom: false },
    expectedTotal: 600000 },

  { name: '#1B — Cùng loại không phí',
    input: { actualCheckIn: D('15/05 15:00'), plannedCheckOut: D('16/05 12:00'), transferAt: D('15/05 18:00'),
      oldRoom: { number: '604', type: 'Deluxe', policy: DELUXE },
      newRoom: { number: '605', type: 'Deluxe', policy: DELUXE },
      transferFee: 0, changeRate: false, isFreeRoom: false },
    expectedTotal: 550000 },

  { name: '#2 — Khác loại KHÔNG tick',
    input: { actualCheckIn: D('15/05 15:00'), plannedCheckOut: D('16/05 12:00'), transferAt: D('15/05 18:00'),
      oldRoom: { number: '604', type: 'Deluxe',   policy: DELUXE },
      newRoom: { number: '504', type: 'Standard', policy: STANDARD },
      transferFee: 0, changeRate: false, isFreeRoom: false },
    expectedTotal: 550000 },

  { name: '#2+ — Khác loại KHÔNG tick + phí 50K',
    input: { actualCheckIn: D('15/05 15:00'), plannedCheckOut: D('16/05 12:00'), transferAt: D('15/05 18:00'),
      oldRoom: { number: '604', type: 'Deluxe',   policy: DELUXE },
      newRoom: { number: '504', type: 'Standard', policy: STANDARD },
      transferFee: 50000, changeRate: false, isFreeRoom: false },
    expectedTotal: 600000 },

  { name: '#3 — Khác loại CÓ tick (switch policy)',
    input: { actualCheckIn: D('15/05 15:00'), plannedCheckOut: D('16/05 12:00'), transferAt: D('15/05 18:00'),
      oldRoom: { number: '604', type: 'Deluxe',   policy: DELUXE },
      newRoom: { number: '504', type: 'Standard', policy: STANDARD },
      transferFee: 0, changeRate: true, isFreeRoom: false },
    expectedTotal: 450000 },

  { name: '#4a — Sau qua đêm CÓ tick',
    input: { actualCheckIn: D('15/05 15:00'), plannedCheckOut: D('17/05 12:00'), transferAt: D('16/05 15:00'),
      oldRoom: { number: '604', type: 'Deluxe',   policy: DELUXE },
      newRoom: { number: '504', type: 'Standard', policy: STANDARD },
      transferFee: 0, changeRate: true, isFreeRoom: false },
    expectedTotal: 1000000 },

  { name: '#4b — Sau qua đêm KHÔNG tick',
    input: { actualCheckIn: D('15/05 15:00'), plannedCheckOut: D('17/05 12:00'), transferAt: D('16/05 15:00'),
      oldRoom: { number: '604', type: 'Deluxe',   policy: DELUXE },
      newRoom: { number: '504', type: 'Standard', policy: STANDARD },
      transferFee: 0, changeRate: false, isFreeRoom: false },
    expectedTotal: 1100000 },

  { name: '#5a — Rạng sáng 02:00 KHÔNG tick',
    input: { actualCheckIn: D('15/05 20:00'), plannedCheckOut: D('16/05 12:00'), transferAt: D('16/05 02:00'),
      oldRoom: { number: '604', type: 'Deluxe',   policy: DELUXE },
      newRoom: { number: '504', type: 'Standard', policy: STANDARD },
      transferFee: 0, changeRate: false, isFreeRoom: false },
    expectedTotal: 550000 },

  { name: '#5b — Rạng sáng 02:00 CÓ tick',
    input: { actualCheckIn: D('15/05 20:00'), plannedCheckOut: D('16/05 12:00'), transferAt: D('16/05 02:00'),
      oldRoom: { number: '604', type: 'Deluxe',   policy: DELUXE },
      newRoom: { number: '504', type: 'Standard', policy: STANDARD },
      transferFee: 0, changeRate: true, isFreeRoom: false },
    expectedTotal: 450000 },

  { name: '#6 — Chuyển 602→502, checkout 14:00 cùng ngày',
    input: { actualCheckIn: D('15/05 15:33'), plannedCheckOut: D('16/05 14:00'), transferAt: D('16/05 11:56'),
      oldRoom: { number: '602', type: 'TypeA', policy: PHONG_602 },
      newRoom: { number: '502', type: 'TypeB', policy: PHONG_502 },
      transferFee: 50000, changeRate: false, isFreeRoom: false },
    expectedTotal: 650000 },

  { name: '#7 — Chuyển 602→502, ở tiếp 18/05 12:00',
    input: { actualCheckIn: D('15/05 15:33'), plannedCheckOut: D('18/05 12:00'), transferAt: D('16/05 11:56'),
      oldRoom: { number: '602', type: 'TypeA', policy: PHONG_602 },
      newRoom: { number: '502', type: 'TypeB', policy: PHONG_502 },
      transferFee: 50000, changeRate: false, isFreeRoom: false },
    expectedTotal: 1650000 },

  { name: '#9 — isFreeRoom + phí chuyển 50K',
    input: { actualCheckIn: D('15/05 15:00'), plannedCheckOut: D('17/05 12:00'), transferAt: D('16/05 11:00'),
      oldRoom: { number: '604', type: 'Deluxe',   policy: DELUXE },
      newRoom: { number: '504', type: 'Standard', policy: STANDARD },
      transferFee: 50000, changeRate: false, isFreeRoom: true },
    expectedTotal: 50000 },
]

let passed = 0, failed = 0
for (const t of tests) {
  if (runTest(t)) passed++; else failed++
}
console.log('═'.repeat(82))
console.log(`📊 KẾT QUẢ: ${passed}/${tests.length} PASS, ${failed} FAIL`)
console.log('═'.repeat(82))