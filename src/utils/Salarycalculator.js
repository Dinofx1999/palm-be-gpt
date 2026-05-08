// backend/src/utils/salaryCalculator.js

function findApplicableTier(exceedPercent, tiers = []) {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  if (exceedPercent <= 0) return null;

  const sorted = [...tiers].sort((a, b) => a.upToPercent - b.upToPercent);

  for (const t of sorted) {
    if (exceedPercent <= t.upToPercent) return t;
  }
  return sorted[sorted.length - 1];
}

/**
 * Tính lương.
 *
 * @param {Object} input
 * @param {Array}  input.components
 * @param {number} input.target
 * @param {Object} input.roleKpi
 * @param {Array}  input.penalties - danh sách phạt [{amount, ...}]
 * @param {number} revenue
 */
function calculateSalary(
  { components = [], target = 0, roleKpi = {}, penalties = [] } = {},
  revenue = 0
) {
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

  // ⭐ Tính tổng phạt
  const penaltyTotal = (penalties || []).reduce(
    (sum, p) => sum + (Number(p.amount) || 0),
    0
  );

  // Tổng lương = Cố định + KPI - Phạt
  const total = fixedTotal + kpiBase + kpiExceed - penaltyTotal;
  const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

  return {
    fixedTotal: round(fixedTotal),
    kpiBase: round(kpiBase),
    kpiExceed: round(kpiExceed),
    penaltyTotal: round(penaltyTotal),
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
      penaltyCount: (penalties || []).length,
    },
  };
}

module.exports = { calculateSalary, findApplicableTier };