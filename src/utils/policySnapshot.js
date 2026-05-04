/**
 * Helper: tạo snapshot từ PricePolicy document.
 * Snapshot có cùng "shape" với fields của PricePolicy, đảm bảo có thể
 * truyền trực tiếp vào calculatePrice() như 1 policy thật.
 */
function buildPolicySnapshot(policy, capacity = null) {
  if (!policy) return null
  const p = policy.toObject ? policy.toObject() : policy
  return {
    name:               p.name,
    roomTypeId:         p.roomTypeId,
    roomTypeName:       p.roomTypeName,
    capacity:           capacity ?? null,

    hourEnabled:        !!p.hourEnabled,
    hourSlots:          (p.hourSlots ?? []).map(s => ({ time: s.time, price: s.price })),

    dayEnabled:         !!p.dayEnabled,
    dayPrice:           p.dayPrice ?? 0,
    dayCheckInTime:     p.dayCheckInTime ?? '12:00',
    dayCheckOutTime:    p.dayCheckOutTime ?? '12:00',
    dayEarlyCheckIn:    (p.dayEarlyCheckIn ?? []).map(s => ({ time: s.time, price: s.price })),
    dayLateCheckOut:    (p.dayLateCheckOut ?? []).map(s => ({ time: s.time, price: s.price })),
    dayAdultSurcharge:  p.dayAdultSurcharge ?? 0,
    dayChildSurcharge:  p.dayChildSurcharge ?? 0,

    nightEnabled:       !!p.nightEnabled,
    nightPrice:         p.nightPrice ?? 0,
    nightCheckInTime:   p.nightCheckInTime ?? '22:00',
    nightCheckOutTime:  p.nightCheckOutTime ?? '11:00',

    weekEnabled:        !!p.weekEnabled,
    weekPrice:          p.weekPrice ?? 0,

    monthEnabled:       !!p.monthEnabled,
    monthPrice:         p.monthPrice ?? 0,
  }
}

module.exports = { buildPolicySnapshot };