// backend/src/utils/salaryCalculator.js

/**
 * Tìm bậc % vượt cao nhất user đạt được.
 *
 * @param {number} exceedPercent - % vượt thực tế (vd 25 = vượt 25% so với target)
 * @param {Array<{upToPercent, percent}>} tiers - đã sort tăng dần theo upToPercent
 * @returns {Object|null} - tier áp dụng hoặc null nếu chưa đủ bậc nào
 *
 * Logic: tìm tier có upToPercent >= exceedPercent, lấy tier đầu tiên thỏa.
 * Nếu vượt cao hơn tất cả → dùng tier cuối (cao nhất).
 *
 * Ví dụ tiers: [{upTo:20, p:0.1}, {upTo:30, p:0.15}]
 *  - exceed 15% → match tier upTo:20 → 0.1%
 *  - exceed 25% → match tier upTo:30 → 0.15%
 *  - exceed 50% → vượt cả 2 → dùng tier cuối (0.15%)
 *  - exceed 0%  → null (chưa vượt)
 */
function findApplicableTier(exceedPercent, tiers = []) {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  if (exceedPercent <= 0) return null;

  const sorted = [...tiers].sort((a, b) => a.upToPercent - b.upToPercent);

  // Tìm bậc đầu tiên có upToPercent >= exceedPercent
  for (const t of sorted) {
    if (exceedPercent <= t.upToPercent) return t;
  }

  // Vượt cao hơn tất cả → dùng bậc cao nhất
  return sorted[sorted.length - 1];
}

/**
 * Tính lương.
 *
 * @param {Object} input
 * @param {Array}  input.components - cơ cấu lương cố định
 * @param {number} input.target     - mục tiêu doanh thu của branch
 * @param {Object} input.roleKpi    - { basePercent, tiers, underTargetPolicy }
 * @param {number} revenue          - doanh thu phân bổ thực tế
 */
function calculateSalary({ components = [], target = 0, roleKpi = {} } = {}, revenue = 0) {
  const fixedTotal = components.reduce(
    (sum, item) => sum + (Number(item.amount) || 0),
    0
  );

  const basePercent = Number(roleKpi.basePercent) || 0;
  const tiers = Array.isArray(roleKpi.tiers) ? roleKpi.tiers : [];
  const underTargetPolicy = roleKpi.underTargetPolicy || 'none';
  const t = Number(target) || 0;
  const r = Number(revenue) || 0;

  let kpiBase = 0;
  let kpiExceed = 0;
  let appliedTier = null;
  let exceedPercent = 0;

  if (t > 0) {
    if (r >= t) {
      kpiBase = (t * basePercent) / 100;

      const exceedAmount = r - t;
      exceedPercent = (exceedAmount / t) * 100;

      appliedTier = findApplicableTier(exceedPercent, tiers);
      if (appliedTier) {
        kpiExceed = (exceedAmount * appliedTier.percent) / 100;
      }
    } else if (underTargetPolicy === 'prorata') {
      kpiBase = (r * basePercent) / 100;
    }
  }

  const total = fixedTotal + kpiBase + kpiExceed;
  const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

  return {
    fixedTotal: round(fixedTotal),
    kpiBase: round(kpiBase),
    kpiExceed: round(kpiExceed),
    total: round(total),
    breakdown: {
      target: t,
      revenue: r,
      exceed: Math.max(0, r - t),
      exceedPercent: round(exceedPercent),
      basePercent,
      appliedTier: appliedTier
        ? { upToPercent: appliedTier.upToPercent, percent: appliedTier.percent }
        : null,
    },
  };
}

module.exports = { calculateSalary, findApplicableTier };