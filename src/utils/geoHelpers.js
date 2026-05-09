// backend/src/utils/geoHelpers.js

/**
 * Tính khoảng cách giữa 2 điểm GPS bằng công thức Haversine.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} khoảng cách (mét)
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371000; // bán kính trái đất (m)

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Parse "HH:mm" → minutes from 00:00
 * "07:30" → 450
 */
function parseHHMM(str) {
  if (!str || typeof str !== 'string') return 0;
  const [h, m] = str.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Lấy minutes từ Date (theo giờ địa phương server)
 */
function getMinutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Tính số phút trễ khi checkin.
 * @param {Date}    checkInAt - thời điểm checkin
 * @param {string}  shiftStartTime - "HH:mm" giờ ca bắt đầu
 * @param {boolean} crossesMidnight - ca qua đêm
 * @param {number}  graceMinutes - số phút ân hạn
 * @returns {number} số phút trễ (0 nếu không trễ)
 */
function calculateLateMinutes(checkInAt, shiftStartTime, crossesMidnight = false, graceMinutes = 0) {
  if (!shiftStartTime) return 0;

  const checkInMinutes = getMinutesOfDay(checkInAt);
  const shiftStartMinutes = parseHHMM(shiftStartTime);

  let lateMinutes = checkInMinutes - shiftStartMinutes;

  // Ca qua đêm: vd ca 23:00, NV checkin 23:30 → trễ 30p
  // Nếu NV checkin trước nửa đêm thì xử lý bình thường.
  // Nếu ca qua đêm và NV checkin sáng hôm sau (vd 01:00) → checkInMinutes nhỏ hơn shiftStart rất nhiều
  if (lateMinutes < -12 * 60 && crossesMidnight) {
    lateMinutes = lateMinutes + 24 * 60;
  }

  // Trừ ân hạn
  lateMinutes -= graceMinutes;

  return Math.max(0, lateMinutes);
}

/**
 * Tính số tiền phạt từ Penalty + input.
 * @param {Object} penalty
 * @param {Object} input - { minutes, occurrence }
 * @returns {{amount: number, appliedTier: Object|null}}
 */
function computePenaltyAmount(penalty, { minutes, occurrence } = {}) {
  if (!penalty) return { amount: 0, appliedTier: null };

  if (penalty.type === 'fixed') {
    return { amount: Number(penalty.fixedAmount) || 0, appliedTier: null };
  }

  if (penalty.type === 'time_window') {
    const m = Math.max(0, Number(minutes) || 0);
    if (m <= 0) return { amount: 0, appliedTier: null };

    const tiers = [...(penalty.timeWindowTiers || [])].sort(
      (a, b) => a.upToMinutes - b.upToMinutes
    );
    if (tiers.length === 0) return { amount: 0, appliedTier: null };

    // Tìm bậc đầu tiên có upToMinutes >= m
    for (const t of tiers) {
      if (m <= t.upToMinutes) {
        return {
          amount: Number(t.amount) || 0,
          appliedTier: { upToMinutes: t.upToMinutes, amount: t.amount },
        };
      }
    }
    // Vượt mọi bậc → dùng bậc cuối
    const last = tiers[tiers.length - 1];
    return {
      amount: Number(last.amount) || 0,
      appliedTier: { upToMinutes: last.upToMinutes, amount: last.amount },
    };
  }

  if (penalty.type === 'repeat_count') {
    const occ = Math.max(1, Number(occurrence) || 1);
    const tiers = [...(penalty.repeatCountTiers || [])].sort(
      (a, b) => a.occurrence - b.occurrence
    );
    if (tiers.length === 0) return { amount: 0, appliedTier: null };

    // Tìm bậc đúng số lần (hoặc bậc cuối nếu vượt)
    let applied = null;
    for (const t of tiers) {
      if (t.occurrence <= occ) applied = t;
    }
    if (!applied) applied = tiers[0];
    return {
      amount: Number(applied.amount) || 0,
      appliedTier: { occurrence: applied.occurrence, amount: applied.amount },
    };
  }

  return { amount: 0, appliedTier: null };
}

module.exports = {
  calculateDistance,
  parseHHMM,
  getMinutesOfDay,
  calculateLateMinutes,
  computePenaltyAmount,
};