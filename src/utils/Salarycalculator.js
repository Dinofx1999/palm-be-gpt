// utils/salaryCalculator.js
// Hàm tính lương — pure function, không phụ thuộc UI.
// Dùng được ở cả backend (khi chốt lương) và frontend (preview real-time).

/**
 * Tính lương dựa trên cấu hình + doanh thu thực tế.
 *
 * @param {Object}   config
 * @param {Array}    config.components            - [{ name, amount }]
 * @param {Object}   config.kpi
 * @param {number}   config.kpi.target            - Mục tiêu doanh thu
 * @param {number}   config.kpi.basePercent       - % thưởng khi đạt target (vd 10)
 * @param {number}   config.kpi.exceedPercent     - % thưởng cho phần vượt (vd 0.1)
 * @param {string}   config.kpi.underTargetPolicy - 'none' | 'prorata'
 * @param {number}   revenue                      - Doanh thu thực tế của tháng
 * @returns {Object} { fixedTotal, kpiBase, kpiExceed, total, breakdown }
 */
export function calculateSalary(config = {}, revenue = 0) {
  const components = Array.isArray(config.components) ? config.components : [];
  const kpi = config.kpi || {};
  const target = Number(kpi.target) || 0;
  const basePercent = Number(kpi.basePercent) || 0;
  const exceedPercent = Number(kpi.exceedPercent) || 0;
  const underTargetPolicy = kpi.underTargetPolicy || 'none';

  // 1. Tổng lương cố định (cơ cấu lương)
  const fixedTotal = components.reduce(
    (sum, item) => sum + (Number(item.amount) || 0),
    0
  );

  // 2. Lương KPI
  let kpiBase = 0;
  let kpiExceed = 0;

  if (revenue >= target && target > 0) {
    kpiBase = (target * basePercent) / 100;
    kpiExceed = ((revenue - target) * exceedPercent) / 100;
  } else if (target > 0 && underTargetPolicy === 'prorata') {
    kpiBase = (revenue * basePercent) / 100;
  }
  // 'none' → kpiBase = 0

  const total = fixedTotal + kpiBase + kpiExceed;

  return {
    fixedTotal: round(fixedTotal),
    kpiBase: round(kpiBase),
    kpiExceed: round(kpiExceed),
    total: round(total),
    breakdown: {
      target,
      revenue,
      exceed: Math.max(0, revenue - target),
      basePercent,
      exceedPercent,
    },
  };
}

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function formatVND(n) {
  return new Intl.NumberFormat('vi-VN').format(Math.round(Number(n) || 0));
}