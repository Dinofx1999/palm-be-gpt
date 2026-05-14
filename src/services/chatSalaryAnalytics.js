// backend/src/services/chatSalaryAnalytics.js
//
// ⭐ NEW 14/05/2026: Module xử lý lương + KPI cho AI Chat
//
// Logic 100% nhất quán với /api/salary/* (cùng dùng computeSnapshot pattern).
// Trả về data đã format sẵn cho AI hiển thị trực tiếp.
//
// Export 6 hàm:
//   - getMySalary       → Lương tháng hiện tại (đầy đủ components + advances + penalties)
//   - getMyKPI          → KPI realtime: % target, tier, số ngày còn lại
//   - getSalaryHistory  → Lịch sử N tháng
//   - getKpiImprovementSuggestions → Đề xuất hành động
//   - getMyAdvances     → Chi tiết các lần ứng lương trong tháng
//   - getMyPenalties    → Chi tiết các khoản phạt trong tháng

const mongoose = require('mongoose');
const User = require('../models/User');
const { SalaryConfig, KpiConfig, SalaryRecord } = require('../models/Salary');
const { PenaltyRecord } = require('../models/Penalty');
const SalaryAdvance = require('../models/SalaryAdvance');
const { calculateSalary } = require('../utils/Salarycalculator');
const { getEmployeeRevenue } = require('../services/revenueService');

const KPI_ROLES = ['Manager', 'Receptionist', 'Staff'];

// ─── Helpers ─────────────────────────────────────────────────────────────
const fmtVND = (n) => {
  if (!Number.isFinite(+n)) return '0đ';
  return Math.round(+n).toLocaleString('vi-VN') + 'đ';
};

const fmtDate = (d) => {
  if (!d) return null;
  return new Date(d).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
};

const fmtDateShort = (d) => {
  if (!d) return null;
  return new Date(d).toLocaleDateString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
};

// Lấy KPI config + role KPI của 1 user
async function resolveKpiForUser(user) {
  if (!user || user.role === 'Admin') return null;
  if (!KPI_ROLES.includes(user.role)) return null;
  if (!user.branchId) return null;

  const cfg = await KpiConfig.findOne({ branchId: user.branchId }).lean();
  if (!cfg) return null;

  const roleKpi = cfg.roles?.[user.role];
  if (!roleKpi) return null;

  return { target: cfg.target || 0, roleKpi };
}

// Lấy phạt trong tháng
async function getPenaltiesForPeriod(userId, year, month) {
  const records = await PenaltyRecord.find({ user: userId, year, month })
    .sort({ occurredOn: -1, createdAt: -1 })
    .lean();

  return records.map((r) => ({
    _id: r._id,
    penaltyId: r.penaltyId,
    name: r.penaltyName,
    type: r.penaltyType,
    severity: r.severity || 'medium',
    minutes: r.minutes,
    occurrence: r.occurrence,
    amount: r.amount,
    reason: r.reason,
    note: r.note,
    occurredOn: r.occurredOn,
    autoCreated: r.autoCreated || false,
  }));
}

// Lấy lương ứng trong tháng
async function getAdvancesForPeriod(userId, year, month) {
  const records = await SalaryAdvance.find({ user: userId, year, month })
    .sort({ advancedAt: -1, createdAt: -1 })
    .lean();
  return records.map((r) => ({
    _id: r._id,
    amount: r.amount,
    reason: r.reason,
    paymentMethod: r.paymentMethod,
    note: r.note,
    advancedAt: r.advancedAt,
  }));
}

// ─── Core: Compute snapshot ─────────────────────────────────────────────
async function computeSnapshot(userId, year, month) {
  const [cfg, user] = await Promise.all([
    SalaryConfig.findOne({ user: userId }).lean(),
    User.findById(userId).select('branchId role fullName username').lean(),
  ]);
  if (!user) throw new Error('Không tìm thấy nhân viên trong hệ thống');

  const kpi = await resolveKpiForUser(user);
  const revenue = kpi ? await getEmployeeRevenue(user, year, month) : 0;
  const penalties = await getPenaltiesForPeriod(userId, year, month);

  const result = calculateSalary(
    {
      components: cfg?.components || [],
      target: kpi?.target || 0,
      roleKpi: kpi?.roleKpi || {},
      penalties,
    },
    revenue
  );

  const advances = await getAdvancesForPeriod(userId, year, month);
  const advanceTotal = advances.reduce((s, a) => s + (Number(a.amount) || 0), 0);
  const remainingToPay = Math.max(0, (result.total || 0) - advanceTotal);

  return {
    user, cfg, kpi, revenue, result, penalties,
    advances, advanceTotal, remainingToPay,
  };
}

// ─── Resolve userId từ ctx ──────────────────────────────────────────────
function resolveUserId(ctx) {
  if (!ctx?.userId) return null;
  if (!mongoose.Types.ObjectId.isValid(ctx.userId)) return null;
  return ctx.userId;
}

// ⭐ NEW 14/05/2026: Resolve targetUserId từ params + check permission
//   Admin: xem được tất cả
//   Manager: chỉ xem được nhân viên cùng branch
//   Receptionist/Staff: chỉ xem được bản thân
//   Trả về: { ok, userId, user, error }
async function resolveTargetUser({ ctx, targetUserId, employeeName }) {
  const selfId = resolveUserId(ctx);
  if (!selfId) {
    return { ok: false, error: 'Vui lòng đăng nhập' };
  }

  // Trường hợp 1: Có targetUserId cụ thể
  if (targetUserId && mongoose.Types.ObjectId.isValid(targetUserId)) {
    const tUser = await User.findById(targetUserId).select('_id fullName username role branchId').lean();
    if (!tUser) return { ok: false, error: 'Không tìm thấy nhân viên' };

    // Check permission
    if (String(tUser._id) === selfId) return { ok: true, userId: selfId, user: tUser };
    if (ctx.role === 'Admin') return { ok: true, userId: String(tUser._id), user: tUser };
    if (ctx.role === 'Manager') {
      if (String(tUser.branchId) === String(ctx.userBranchId)) {
        return { ok: true, userId: String(tUser._id), user: tUser };
      }
      return { ok: false, error: 'Manager chỉ xem được nhân viên cùng chi nhánh' };
    }
    return { ok: false, error: 'Bạn chỉ xem được lương của chính mình' };
  }

  // Trường hợp 2: Tìm theo tên nhân viên
  if (employeeName && typeof employeeName === 'string' && employeeName.trim().length >= 2) {
    if (ctx.role !== 'Admin' && ctx.role !== 'Manager') {
      return { ok: false, error: 'Chỉ Admin/Manager mới được xem lương người khác' };
    }
    const filter = {
      $or: [
        { fullName: { $regex: employeeName, $options: 'i' } },
        { username: { $regex: employeeName, $options: 'i' } },
      ],
      isActive: true,
    };
    if (ctx.role === 'Manager') filter.branchId = ctx.userBranchId;
    const candidates = await User.find(filter)
      .select('_id fullName username role branchId').limit(5).lean();
    if (candidates.length === 0) {
      return { ok: false, error: `Không tìm thấy nhân viên tên "${employeeName}"` };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        error: 'Tìm thấy nhiều nhân viên — vui lòng nói rõ hơn',
        candidates: candidates.map(c => ({
          userId: String(c._id),
          fullName: c.fullName,
          role: c.role,
        })),
      };
    }
    return { ok: true, userId: String(candidates[0]._id), user: candidates[0] };
  }

  // Trường hợp 3: Mặc định lấy bản thân
  const self = await User.findById(selfId).select('_id fullName username role branchId').lean();
  return { ok: true, userId: selfId, user: self };
}

// Format response chung
function formatSalaryResponse(data) {
  const {
    userRole, userName, year, month, isFinalized,
    components, target, revenue, basePercent, appliedTier,
    fixedTotal, kpiBase, kpiExceed,
    penaltyTotal, penalties,
    total, advanceTotal, remainingToPay, advances,
    paidStatus, paidAt, paymentMethod, paidNote,
  } = data;

  const exceed = Math.max(0, (revenue || 0) - (target || 0));
  const exceedPercent = target > 0
    ? Math.round(((revenue - target) / target) * 100 * 100) / 100
    : 0;
  const achievedPercent = target > 0
    ? Math.round((revenue / target) * 100 * 100) / 100
    : 0;

  return {
    year, month,
    userRole,
    userName: userName || undefined,
    isFinalized,

    components: (components || []).map(c => ({
      name: c.name,
      amount: c.amount,
      amountFormatted: fmtVND(c.amount),
      note: c.note || undefined,
    })),
    componentCount: (components || []).length,
    fixedTotal,
    fixedTotalFormatted: fmtVND(fixedTotal),

    target,
    targetFormatted: fmtVND(target),
    revenue,
    revenueFormatted: fmtVND(revenue),
    achievedPercent,
    achievedPercentFormatted: `${achievedPercent}%`,
    exceed,
    exceedFormatted: fmtVND(exceed),
    exceedPercent,
    basePercent,
    appliedTier: appliedTier || null,
    kpiBase,
    kpiBaseFormatted: fmtVND(kpiBase),
    kpiExceed,
    kpiExceedFormatted: fmtVND(kpiExceed),
    hasKpi: !!(target && basePercent),

    penaltyTotal,
    penaltyTotalFormatted: fmtVND(penaltyTotal),
    penaltyCount: (penalties || []).length,
    penalties: (penalties || []).map(p => ({
      name: p.name,
      amount: p.amount,
      amountFormatted: fmtVND(p.amount),
      type: p.type,
      severity: p.severity,
      minutes: p.minutes,
      reason: p.reason,
      occurredOn: p.occurredOn,
      occurredOnFormatted: fmtDateShort(p.occurredOn),
    })),

    total,
    totalFormatted: fmtVND(total),

    advanceTotal,
    advanceTotalFormatted: fmtVND(advanceTotal),
    advanceCount: (advances || []).length,
    advances: (advances || []).map(a => ({
      amount: a.amount,
      amountFormatted: fmtVND(a.amount),
      reason: a.reason,
      paymentMethod: a.paymentMethod,
      advancedAt: a.advancedAt,
      advancedAtFormatted: fmtDateShort(a.advancedAt),
    })),

    remainingToPay,
    remainingToPayFormatted: fmtVND(remainingToPay),

    paidStatus: paidStatus || 'unpaid',
    isPaid: paidStatus === 'paid',
    paidAt: paidAt || null,
    paidAtFormatted: paidAt ? fmtDate(paidAt) : null,
    paymentMethod: paymentMethod || null,
    paymentMethodLabel: paymentMethod === 'cash' ? 'Tiền mặt'
                       : paymentMethod === 'transfer' ? 'Chuyển khoản'
                       : null,
    paidNote: paidNote || null,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 1. getMySalary
// ═════════════════════════════════════════════════════════════════════════
async function getMySalary({ ctx, year, month, targetUserId, employeeName } = {}) {
  const resolved = await resolveTargetUser({ ctx, targetUserId, employeeName });
  if (!resolved.ok) {
    return { error: resolved.error, candidates: resolved.candidates };
  }
  const userId = resolved.userId;
  const targetUser = resolved.user;
  const isSelf = String(userId) === resolveUserId(ctx);

  const now = new Date();
  const y = parseInt(year, 10) || now.getFullYear();
  const m = parseInt(month, 10) || (now.getMonth() + 1);

  try {
    const existing = await SalaryRecord.findOne({ user: userId, year: y, month: m }).lean();

    if (existing) {
      const advanceTotal   = existing.advanceTotal   || 0;
      const remainingToPay = existing.remainingToPay ?? Math.max(0, existing.total - advanceTotal);

      return formatSalaryResponse({
        userRole: existing.role,
        userName: targetUser.fullName,
        isSelf,
        year: y, month: m,
        isFinalized: true,
        components:   existing.components || [],
        target:       existing.target,
        revenue:      existing.revenue,
        basePercent:  existing.basePercent,
        appliedTier:  existing.appliedTier,
        fixedTotal:   existing.fixedTotal,
        kpiBase:      existing.kpiBase,
        kpiExceed:    existing.kpiExceed,
        penaltyTotal: existing.penaltyTotal || 0,
        penalties:    existing.penalties || [],
        total:        existing.total,
        advanceTotal,
        remainingToPay,
        advances:     existing.advances || [],
        paidStatus:   existing.paidStatus,
        paidAt:       existing.paidAt,
        paymentMethod: existing.paymentMethod,
        paidNote:     existing.paidNote,
      });
    }

    const {
      user, cfg, kpi, revenue, result, penalties,
      advances, advanceTotal, remainingToPay,
    } = await computeSnapshot(userId, y, m);

    return formatSalaryResponse({
      userRole: user.role,
      userName: user.fullName,
      isSelf,
      year: y, month: m,
      isFinalized: false,
      components:   cfg?.components || [],
      target:       kpi?.target || 0,
      revenue,
      basePercent:  kpi?.roleKpi?.basePercent || 0,
      appliedTier:  result.breakdown?.appliedTier || null,
      fixedTotal:   result.fixedTotal,
      kpiBase:      result.kpiBase,
      kpiExceed:    result.kpiExceed,
      penaltyTotal: result.penaltyTotal || 0,
      penalties,
      total:        result.total,
      advanceTotal,
      remainingToPay,
      advances,
      paidStatus: 'unpaid',
    });
  } catch (err) {
    console.error('[getMySalary]', err);
    return { error: err.message || 'Không tính được lương' };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 2. getMyKPI
// ═════════════════════════════════════════════════════════════════════════
async function getMyKPI({ ctx, targetUserId, employeeName } = {}) {
  const resolved = await resolveTargetUser({ ctx, targetUserId, employeeName });
  if (!resolved.ok) {
    return { error: resolved.error, candidates: resolved.candidates };
  }
  const userId = resolved.userId;
  const targetUser = resolved.user;
  const isSelf = String(userId) === resolveUserId(ctx);

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;

  try {
    const { user, kpi, revenue, result } = await computeSnapshot(userId, y, m);

    if (!kpi) {
      return {
        userRole: user.role,
        userName: targetUser.fullName,
        isSelf,
        hasKpi: false,
        message: user.role === 'Admin'
          ? `${isSelf ? 'Anh' : targetUser.fullName} là Admin nên không tham gia KPI cá nhân ạ.`
          : `${isSelf ? 'Em' : targetUser.fullName} chưa được set KPI ở chi nhánh ạ.`,
      };
    }

    const target = kpi.target;
    const basePercent = kpi.roleKpi.basePercent;
    const tiers = kpi.roleKpi.tiers || [];

    const achievedPercent = target > 0
      ? Math.round((revenue / target) * 100 * 100) / 100
      : 0;
    const exceed = Math.max(0, revenue - target);
    const exceedPercent = target > 0
      ? Math.round(((revenue - target) / target) * 100 * 100) / 100
      : 0;
    const gap = Math.max(0, target - revenue);

    const lastDay = new Date(y, m, 0).getDate();
    const today = now.getDate();
    const daysRemaining = Math.max(0, lastDay - today);
    const daysPassed = today;
    const dailyAverageNeeded = daysRemaining > 0 ? Math.ceil(gap / daysRemaining) : 0;
    const dailyAverageSoFar = daysPassed > 0 ? Math.round(revenue / daysPassed) : 0;

    return {
      year: y, month: m,
      userRole: user.role,
      userName: targetUser.fullName,
      isSelf,
      hasKpi: true,

      target,
      targetFormatted: fmtVND(target),
      revenue,
      revenueFormatted: fmtVND(revenue),
      achievedPercent,
      achievedPercentFormatted: `${achievedPercent}%`,
      exceed,
      exceedFormatted: fmtVND(exceed),
      exceedPercent,
      gap,
      gapFormatted: fmtVND(gap),

      basePercent,
      kpiBase: result.kpiBase,
      kpiBaseFormatted: fmtVND(result.kpiBase),
      kpiExceed: result.kpiExceed,
      kpiExceedFormatted: fmtVND(result.kpiExceed),
      appliedTier: result.breakdown?.appliedTier || null,
      tiers: tiers.map(t => ({
        upToPercent: t.upToPercent,
        percent: t.percent,
        label: `Đến ${t.upToPercent}% → thưởng ${t.percent}% phần vượt`,
      })),

      daysPassed,
      daysRemaining,
      lastDay,
      dailyAverageSoFar,
      dailyAverageSoFarFormatted: fmtVND(dailyAverageSoFar),
      dailyAverageNeeded,
      dailyAverageNeededFormatted: fmtVND(dailyAverageNeeded),

      status: achievedPercent >= 100 ? 'achieved'
            : achievedPercent >= 80  ? 'near'
            : achievedPercent >= 50  ? 'progressing'
            : 'behind',
      statusLabel: achievedPercent >= 100 ? '🎉 Đã đạt KPI'
                 : achievedPercent >= 80  ? '✨ Gần đạt KPI'
                 : achievedPercent >= 50  ? '📈 Đang trên đà'
                 : '⚠️ Còn xa target',
    };
  } catch (err) {
    console.error('[getMyKPI]', err);
    return { error: err.message || 'Không tính được KPI' };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 3. getSalaryHistory
// ═════════════════════════════════════════════════════════════════════════
async function getSalaryHistory({ ctx, months = 6, targetUserId, employeeName } = {}) {
  const resolved = await resolveTargetUser({ ctx, targetUserId, employeeName });
  if (!resolved.ok) {
    return { error: resolved.error, candidates: resolved.candidates };
  }
  const userId = resolved.userId;
  const targetUser = resolved.user;
  const isSelf = String(userId) === resolveUserId(ctx);

  const lim = Math.min(Math.max(parseInt(months, 10) || 6, 1), 12);
  const now = new Date();
  const currentY = now.getFullYear();
  const currentM = now.getMonth() + 1;

  const periods = [];
  for (let i = 0; i < lim; i++) {
    const d = new Date(currentY, currentM - 1 - i, 1);
    periods.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  try {
    const records = await SalaryRecord.find({
      user: userId,
      $or: periods.map(p => ({ year: p.year, month: p.month })),
    }).lean();

    const recordMap = new Map();
    for (const r of records) recordMap.set(`${r.year}-${r.month}`, r);

    const history = [];
    for (const p of periods) {
      const key = `${p.year}-${p.month}`;
      const r = recordMap.get(key);
      const isCurrent = p.year === currentY && p.month === currentM;

      if (r) {
        const advanceTotal = r.advanceTotal || 0;
        const remainingToPay = r.remainingToPay ?? Math.max(0, r.total - advanceTotal);
        const target = r.target || 0;
        const achievedPercent = target > 0
          ? Math.round((r.revenue / target) * 100 * 100) / 100
          : 0;

        history.push({
          year: p.year, month: p.month,
          label: `Tháng ${p.month}/${p.year}`,
          isFinalized: true,
          isCurrent,
          revenue: r.revenue,
          revenueFormatted: fmtVND(r.revenue),
          target,
          targetFormatted: fmtVND(target),
          achievedPercent,
          achievedPercentFormatted: `${achievedPercent}%`,
          fixedTotal: r.fixedTotal,
          fixedTotalFormatted: fmtVND(r.fixedTotal),
          kpiBase: r.kpiBase,
          kpiBaseFormatted: fmtVND(r.kpiBase),
          kpiExceed: r.kpiExceed,
          kpiExceedFormatted: fmtVND(r.kpiExceed),
          penaltyTotal: r.penaltyTotal || 0,
          penaltyTotalFormatted: fmtVND(r.penaltyTotal || 0),
          total: r.total,
          totalFormatted: fmtVND(r.total),
          advanceTotal,
          advanceTotalFormatted: fmtVND(advanceTotal),
          remainingToPay,
          remainingToPayFormatted: fmtVND(remainingToPay),
          paidStatus: r.paidStatus,
          isPaid: r.paidStatus === 'paid',
          paidAt: r.paidAt,
          paidAtFormatted: r.paidAt ? fmtDate(r.paidAt) : null,
        });
      } else if (isCurrent) {
        try {
          const { result, revenue, kpi, advanceTotal, remainingToPay } =
            await computeSnapshot(userId, p.year, p.month);
          const target = kpi?.target || 0;
          const achievedPercent = target > 0
            ? Math.round((revenue / target) * 100 * 100) / 100
            : 0;

          history.push({
            year: p.year, month: p.month,
            label: `Tháng ${p.month}/${p.year}`,
            isFinalized: false,
            isCurrent: true,
            revenue,
            revenueFormatted: fmtVND(revenue),
            target,
            targetFormatted: fmtVND(target),
            achievedPercent,
            achievedPercentFormatted: `${achievedPercent}%`,
            fixedTotal: result.fixedTotal,
            fixedTotalFormatted: fmtVND(result.fixedTotal),
            kpiBase: result.kpiBase,
            kpiBaseFormatted: fmtVND(result.kpiBase),
            kpiExceed: result.kpiExceed,
            kpiExceedFormatted: fmtVND(result.kpiExceed),
            penaltyTotal: result.penaltyTotal || 0,
            penaltyTotalFormatted: fmtVND(result.penaltyTotal || 0),
            total: result.total,
            totalFormatted: fmtVND(result.total),
            advanceTotal,
            advanceTotalFormatted: fmtVND(advanceTotal),
            remainingToPay,
            remainingToPayFormatted: fmtVND(remainingToPay),
            paidStatus: 'unpaid',
            isPaid: false,
          });
        } catch {
          history.push({
            year: p.year, month: p.month,
            label: `Tháng ${p.month}/${p.year}`,
            isFinalized: false,
            isCurrent: true,
            isEmpty: true,
            total: 0,
            totalFormatted: '0đ',
          });
        }
      } else {
        history.push({
          year: p.year, month: p.month,
          label: `Tháng ${p.month}/${p.year}`,
          isFinalized: false,
          isCurrent: false,
          isEmpty: true,
          total: 0,
          totalFormatted: '0đ',
          paidStatus: 'unpaid',
          isPaid: false,
        });
      }
    }

    const finalized = history.filter(h => h.isFinalized);
    const avgTotal = finalized.length > 0
      ? Math.round(finalized.reduce((s, h) => s + (h.total || 0), 0) / finalized.length)
      : 0;
    const totalKpiAchieved = finalized.filter(h => (h.achievedPercent || 0) >= 100).length;

    return {
      months: lim,
      userName: targetUser.fullName,
      isSelf,
      count: history.length,
      finalizedCount: finalized.length,
      history,
      summary: {
        averageMonth: avgTotal,
        averageMonthFormatted: fmtVND(avgTotal),
        totalKpiAchieved,
        kpiAchievementRate: finalized.length > 0
          ? `${Math.round((totalKpiAchieved / finalized.length) * 100)}%`
          : '0%',
      },
    };
  } catch (err) {
    console.error('[getSalaryHistory]', err);
    return { error: err.message || 'Không tính được lịch sử lương' };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 4. getKpiImprovementSuggestions
// ═════════════════════════════════════════════════════════════════════════
async function getKpiImprovementSuggestions({ ctx, targetUserId, employeeName } = {}) {
  const kpiData = await getMyKPI({ ctx, targetUserId, employeeName });
  if (kpiData.error || !kpiData.hasKpi) return kpiData;

  const {
    achievedPercent, gap, daysRemaining, dailyAverageNeeded, dailyAverageSoFar,
    target, revenue, tiers,
  } = kpiData;

  const suggestions = [];

  if (achievedPercent >= 100) {
    suggestions.push({
      type: 'celebration',
      icon: '🎉',
      title: 'Em đã đạt KPI tháng này!',
      detail: `Hiện tại em đã đạt ${kpiData.achievedPercentFormatted} target. Tiếp tục phát huy để vượt tiers thưởng cao hơn ạ.`,
    });

    const nextTier = tiers.find(t => achievedPercent < (100 + t.upToPercent));
    if (nextTier) {
      const needToReach = Math.ceil(target * (100 + nextTier.upToPercent) / 100) - revenue;
      suggestions.push({
        type: 'next_tier',
        icon: '🚀',
        title: `Vượt thêm ${fmtVND(needToReach)} để đạt tier ${nextTier.upToPercent}%`,
        detail: `Tier này sẽ thưởng thêm ${nextTier.percent}% phần vượt mức.`,
      });
    }
  } else if (achievedPercent >= 80) {
    suggestions.push({
      type: 'near',
      icon: '✨',
      title: 'Em gần đạt KPI rồi!',
      detail: `Còn cách target ${kpiData.gapFormatted} (${(100 - achievedPercent).toFixed(1)}%). Còn ${daysRemaining} ngày — mỗi ngày em làm thêm ${fmtVND(dailyAverageNeeded)} là đạt.`,
    });
  } else if (achievedPercent >= 50) {
    suggestions.push({
      type: 'progressing',
      icon: '📈',
      title: 'Em đang trên đà — cần đẩy mạnh hơn',
      detail: `Hiện đạt ${kpiData.achievedPercentFormatted}. Còn ${daysRemaining} ngày, mỗi ngày cần ${fmtVND(dailyAverageNeeded)} để đạt target. Mức TB hiện tại: ${fmtVND(dailyAverageSoFar)}/ngày.`,
    });
  } else {
    suggestions.push({
      type: 'behind',
      icon: '⚠️',
      title: 'Em đang khá xa target',
      detail: `Đạt ${kpiData.achievedPercentFormatted}. Còn ${daysRemaining} ngày — cần làm thêm ${fmtVND(dailyAverageNeeded)}/ngày (gấp ~${dailyAverageSoFar > 0 ? Math.ceil(dailyAverageNeeded / dailyAverageSoFar) : 'nhiều'} lần TB hiện tại).`,
    });
  }

  if (achievedPercent < 100) {
    suggestions.push({
      type: 'action',
      icon: '💡',
      title: 'Gợi ý hành động cụ thể:',
      actions: [
        '• Đề xuất upsell với khách check-in (Deluxe → Suite)',
        '• Tư vấn extra night cho khách đã có booking',
        '• Gọi lại khách cũ trong DB (Customer history)',
        '• Tăng dịch vụ kèm (POS): minibar, ăn sáng, giặt là',
        '• Push thêm booking qua OTA / Zalo nếu được phép',
      ],
    });
  }

  return {
    ...kpiData,
    suggestions,
    suggestionCount: suggestions.length,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 5. getMyAdvances
// ═════════════════════════════════════════════════════════════════════════
async function getMyAdvances({ ctx, year, month, targetUserId, employeeName } = {}) {
  const resolved = await resolveTargetUser({ ctx, targetUserId, employeeName });
  if (!resolved.ok) {
    return { error: resolved.error, candidates: resolved.candidates };
  }
  const userId = resolved.userId;
  const targetUser = resolved.user;
  const isSelf = String(userId) === resolveUserId(ctx);

  const now = new Date();
  const y = parseInt(year, 10) || now.getFullYear();
  const m = parseInt(month, 10) || (now.getMonth() + 1);

  try {
    const advances = await getAdvancesForPeriod(userId, y, m);
    const total = advances.reduce((s, a) => s + (a.amount || 0), 0);

    return {
      year: y, month: m,
      label: `Tháng ${m}/${y}`,
      userName: targetUser.fullName,
      isSelf,
      count: advances.length,
      total,
      totalFormatted: fmtVND(total),
      advances: advances.map(a => ({
        amount: a.amount,
        amountFormatted: fmtVND(a.amount),
        reason: a.reason || '(không ghi)',
        paymentMethod: a.paymentMethod,
        paymentMethodLabel: a.paymentMethod === 'cash' ? 'Tiền mặt'
                          : a.paymentMethod === 'transfer' ? 'Chuyển khoản'
                          : a.paymentMethod,
        advancedAt: a.advancedAt,
        advancedAtFormatted: fmtDateShort(a.advancedAt),
        note: a.note || null,
      })),
    };
  } catch (err) {
    console.error('[getMyAdvances]', err);
    return { error: err.message || 'Không lấy được lương ứng' };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 6. getMyPenalties
// ═════════════════════════════════════════════════════════════════════════
async function getMyPenalties({ ctx, year, month, targetUserId, employeeName } = {}) {
  const resolved = await resolveTargetUser({ ctx, targetUserId, employeeName });
  if (!resolved.ok) {
    return { error: resolved.error, candidates: resolved.candidates };
  }
  const userId = resolved.userId;
  const targetUser = resolved.user;
  const isSelf = String(userId) === resolveUserId(ctx);

  const now = new Date();
  const y = parseInt(year, 10) || now.getFullYear();
  const m = parseInt(month, 10) || (now.getMonth() + 1);

  try {
    const penalties = await getPenaltiesForPeriod(userId, y, m);
    const total = penalties.reduce((s, p) => s + (p.amount || 0), 0);

    const byType = penalties.reduce((acc, p) => {
      const k = p.type || 'unknown';
      if (!acc[k]) acc[k] = { count: 0, total: 0 };
      acc[k].count++;
      acc[k].total += p.amount || 0;
      return acc;
    }, {});

    const bySeverity = penalties.reduce((acc, p) => {
      const k = p.severity || 'medium';
      if (!acc[k]) acc[k] = { count: 0, total: 0 };
      acc[k].count++;
      acc[k].total += p.amount || 0;
      return acc;
    }, {});

    return {
      year: y, month: m,
      label: `Tháng ${m}/${y}`,
      userName: targetUser.fullName,
      isSelf,
      count: penalties.length,
      total,
      totalFormatted: fmtVND(total),
      byType: Object.entries(byType).map(([type, v]) => ({
        type,
        typeLabel: type === 'fixed' ? 'Cố định'
                  : type === 'time_window' ? 'Theo khung giờ'
                  : type === 'repeat_count' ? 'Theo số lần'
                  : type,
        count: v.count,
        total: v.total,
        totalFormatted: fmtVND(v.total),
      })),
      bySeverity: Object.entries(bySeverity).map(([severity, v]) => ({
        severity,
        severityLabel: severity === 'low' ? 'Nhẹ'
                     : severity === 'medium' ? 'Trung bình'
                     : severity === 'high' ? 'Nặng'
                     : severity === 'critical' ? 'Rất nặng'
                     : severity,
        count: v.count,
        total: v.total,
        totalFormatted: fmtVND(v.total),
      })),
      penalties: penalties.map(p => ({
        name: p.name,
        amount: p.amount,
        amountFormatted: fmtVND(p.amount),
        type: p.type,
        severity: p.severity,
        minutes: p.minutes || undefined,
        occurrence: p.occurrence || undefined,
        reason: p.reason || '(không ghi lý do)',
        note: p.note || undefined,
        occurredOn: p.occurredOn,
        occurredOnFormatted: fmtDateShort(p.occurredOn),
        autoCreated: p.autoCreated,
      })),
    };
  } catch (err) {
    console.error('[getMyPenalties]', err);
    return { error: err.message || 'Không lấy được khoản phạt' };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 7. getBranchKPIOverview — KPI toàn chi nhánh (Admin/Manager)
// ═════════════════════════════════════════════════════════════════════════
async function getBranchKPIOverview({ ctx, branchId, branchName } = {}) {
  if (!ctx || (ctx.role !== 'Admin' && ctx.role !== 'Manager')) {
    return { error: 'forbidden', message: 'Tính năng này chỉ dành cho Admin/Manager ạ.' };
  }

  let bId = branchId;

  // ⭐ Manager: ép vào branch của họ
  if (ctx.role === 'Manager') {
    if (!ctx.userBranchId) return { error: 'Manager chưa được gán chi nhánh' };
    bId = ctx.userBranchId;
  }
  // ⭐ Admin: nếu user nói tên chi nhánh → resolve
  else if (ctx.role === 'Admin') {
    if (branchName && !bId) {
      const Branch = require('../models/Branch');
      const br = await Branch.findOne({
        $or: [
          { name:      { $regex: branchName, $options: 'i' } },
          { shortName: { $regex: branchName, $options: 'i' } },
        ],
      }).select('_id name').lean();
      if (br) bId = String(br._id);
    }
    // ⭐ Admin không truyền gì → fallback về branch của họ (Palm Hotel chính)
    if (!bId && ctx.userBranchId) bId = ctx.userBranchId;
  }

  if (!bId || !mongoose.Types.ObjectId.isValid(bId)) {
    // ⭐ Admin chưa có branch nào trong DB → trả toàn hệ thống (Promise.all qua mọi branch)
    if (ctx.role === 'Admin') {
      return { error: 'Vui lòng chỉ rõ chi nhánh (vd: "KPI nhân viên chi nhánh Palm Hotel")' };
    }
    return { error: 'Thiếu branchId hoặc không hợp lệ' };
  }

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;

  try {
    const [cfg, users] = await Promise.all([
      KpiConfig.findOne({ branchId: bId }).lean(),
      User.find({ branchId: bId, isActive: true, role: { $in: KPI_ROLES } })
        .select('_id fullName username role').lean(),
    ]);

    if (!cfg) {
      return {
        year: y, month: m,
        target: 0,
        message: 'Chi nhánh chưa được cấu hình KPI ạ.',
        users: [],
      };
    }

    const target = cfg.target || 0;
    const results = await Promise.all(users.map(async (u) => {
      try {
        const { revenue, result } = await computeSnapshot(u._id, y, m);
        const achievedPercent = target > 0
          ? Math.round((revenue / target) * 100 * 100) / 100
          : 0;
        return {
          userId:   String(u._id),
          fullName: u.fullName,
          role:     u.role,
          revenue,
          revenueFormatted: fmtVND(revenue),
          achievedPercent,
          achievedPercentFormatted: `${achievedPercent}%`,
          kpiTotal: result.kpiBase + result.kpiExceed,
          kpiTotalFormatted: fmtVND(result.kpiBase + result.kpiExceed),
          total: result.total,
          totalFormatted: fmtVND(result.total),
          status: achievedPercent >= 100 ? 'achieved'
                : achievedPercent >= 80  ? 'near'
                : 'behind',
        };
      } catch (err) {
        return {
          userId: String(u._id),
          fullName: u.fullName,
          role: u.role,
          error: err.message,
        };
      }
    }));

    const sorted = results.sort((a, b) => (b.achievedPercent || 0) - (a.achievedPercent || 0));
    const totalRevenue = sorted.reduce((s, r) => s + (r.revenue || 0), 0);
    const achievedCount = sorted.filter(r => (r.achievedPercent || 0) >= 100).length;

    return {
      year: y, month: m,
      branchId: String(bId),
      target,
      targetFormatted: fmtVND(target),
      userCount: sorted.length,
      achievedCount,
      achievementRate: sorted.length > 0
        ? `${Math.round((achievedCount / sorted.length) * 100)}%`
        : '0%',
      totalRevenue,
      totalRevenueFormatted: fmtVND(totalRevenue),
      users: sorted,
    };
  } catch (err) {
    console.error('[getBranchKPIOverview]', err);
    return { error: err.message || 'Không lấy được KPI chi nhánh' };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 8. getTopEmployees — Xếp hạng nhân viên (Admin/Manager)
// ═════════════════════════════════════════════════════════════════════════
async function getTopEmployees({ ctx, sortBy = 'revenue', limit = 5, branchId, branchName } = {}) {
  if (!ctx || (ctx.role !== 'Admin' && ctx.role !== 'Manager')) {
    return { error: 'forbidden', message: 'Tính năng này chỉ dành cho Admin/Manager ạ.' };
  }

  const lim = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 30);
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;

  // Filter user
  const filter = { isActive: true, role: { $in: KPI_ROLES } };

  if (ctx.role === 'Manager') {
    if (!ctx.userBranchId) return { error: 'Manager chưa được gán chi nhánh' };
    filter.branchId = ctx.userBranchId;
  } else if (ctx.role === 'Admin') {
    // ⭐ Admin: resolve theo branchName nếu có
    if (branchName && !branchId) {
      const Branch = require('../models/Branch');
      const br = await Branch.findOne({
        $or: [
          { name:      { $regex: branchName, $options: 'i' } },
          { shortName: { $regex: branchName, $options: 'i' } },
        ],
      }).select('_id').lean();
      if (br) filter.branchId = br._id;
    } else if (branchId && mongoose.Types.ObjectId.isValid(branchId)) {
      filter.branchId = branchId;
    }
    // Nếu Admin không nói gì → lấy TẤT CẢ chi nhánh (không filter branchId)
  }

  try {
    const users = await User.find(filter)
      .select('_id fullName username role branchId branchName')
      .populate('branchId', 'name')
      .lean();

    const results = await Promise.all(users.map(async (u) => {
      try {
        const { revenue, result, kpi } = await computeSnapshot(u._id, y, m);
        const target = kpi?.target || 0;
        const achievedPercent = target > 0
          ? Math.round((revenue / target) * 100 * 100) / 100
          : 0;
        return {
          userId: String(u._id),
          fullName: u.fullName,
          role: u.role,
          branch: u.branchId?.name || u.branchName,
          revenue,
          revenueFormatted: fmtVND(revenue),
          achievedPercent,
          achievedPercentFormatted: `${achievedPercent}%`,
          salary: result.total,
          salaryFormatted: fmtVND(result.total),
        };
      } catch {
        return null;
      }
    }));

    const valid = results.filter(Boolean);
    const sortField = sortBy === 'kpi' ? 'achievedPercent'
                    : sortBy === 'salary' ? 'salary'
                    : 'revenue';
    valid.sort((a, b) => (b[sortField] || 0) - (a[sortField] || 0));
    const top = valid.slice(0, lim).map((r, i) => ({ rank: i + 1, ...r }));

    return {
      year: y, month: m,
      sortBy,
      sortLabel: sortBy === 'kpi' ? 'Theo % KPI'
               : sortBy === 'salary' ? 'Theo lương'
               : 'Theo doanh thu',
      limit: lim,
      count: top.length,
      employees: top,
    };
  } catch (err) {
    console.error('[getTopEmployees]', err);
    return { error: err.message || 'Không xếp hạng được' };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 9. getBranchKpiConfig — Xem cấu hình KPI mục tiêu của branch (target + tiers)
//    Dùng khi user hỏi "KPI mục tiêu chi nhánh", "target tháng này", "doanh thu mục tiêu"
// ═════════════════════════════════════════════════════════════════════════
async function getBranchKpiConfig({ ctx, branchId, branchName } = {}) {
  if (!ctx || (ctx.role !== 'Admin' && ctx.role !== 'Manager')) {
    return { error: 'forbidden', message: 'Tính năng này chỉ dành cho Admin/Manager ạ.' };
  }

  let bId = branchId;

  // Resolve branch
  if (ctx.role === 'Manager') {
    bId = ctx.userBranchId;
  } else if (ctx.role === 'Admin') {
    if (branchName && !bId) {
      const Branch = require('../models/Branch');
      const br = await Branch.findOne({
        $or: [
          { name:      { $regex: branchName, $options: 'i' } },
          { shortName: { $regex: branchName, $options: 'i' } },
        ],
      }).select('_id name').lean();
      if (br) bId = String(br._id);
    }
    if (!bId && ctx.userBranchId) bId = ctx.userBranchId;
  }

  if (!bId || !mongoose.Types.ObjectId.isValid(bId)) {
    return { error: 'Không xác định được chi nhánh' };
  }

  try {
    const Branch = require('../models/Branch');
    const [cfg, branch] = await Promise.all([
      KpiConfig.findOne({ branchId: bId }).lean(),
      Branch.findById(bId).select('name shortName').lean(),
    ]);

    if (!cfg) {
      return {
        branchId: String(bId),
        branchName: branch?.name || 'Chi nhánh',
        hasConfig: false,
        message: `Chi nhánh "${branch?.name || ''}" chưa được cấu hình KPI ạ. Anh/chị vào "Lương & thưởng → Cấu hình KPI" để thiết lập target.`,
      };
    }

    // Tính doanh thu thực tế tháng này của branch (sum của mọi nhân viên)
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;

    const users = await User.find({
      branchId: bId,
      isActive: true,
      role: { $in: KPI_ROLES },
    }).select('_id role').lean();

    let totalRevenue = 0;
    for (const u of users) {
      try {
        const rev = await getEmployeeRevenue(u, y, m);
        totalRevenue += rev || 0;
      } catch {}
    }

    const target = cfg.target || 0;
    const achievedPercent = target > 0
      ? Math.round((totalRevenue / target) * 100 * 100) / 100
      : 0;
    const gap = Math.max(0, target - totalRevenue);

    // Format roles config
    const rolesFormatted = {};
    for (const role of KPI_ROLES) {
      const rc = cfg.roles?.[role];
      if (!rc) continue;
      rolesFormatted[role] = {
        basePercent: rc.basePercent || 0,
        basePercentLabel: `${rc.basePercent || 0}%`,
        tiers: (rc.tiers || []).map(t => ({
          upToPercent: t.upToPercent,
          percent: t.percent,
          label: `Đạt đến ${t.upToPercent}% → thưởng ${t.percent}% phần vượt`,
        })),
        underTargetPolicy: rc.underTargetPolicy || 'none',
        underTargetLabel: rc.underTargetPolicy === 'prorata'
          ? 'Không đạt target → thưởng theo tỉ lệ'
          : 'Không đạt target → không thưởng',
      };
    }

    return {
      year: y, month: m,
      branchId: String(bId),
      branchName: branch?.name || 'Chi nhánh',
      hasConfig: true,

      target,
      targetFormatted: fmtVND(target),
      currentRevenue: totalRevenue,
      currentRevenueFormatted: fmtVND(totalRevenue),
      achievedPercent,
      achievedPercentFormatted: `${achievedPercent}%`,
      gap,
      gapFormatted: fmtVND(gap),

      userCount: users.length,
      roles: rolesFormatted,

      status: achievedPercent >= 100 ? 'achieved'
            : achievedPercent >= 80  ? 'near'
            : achievedPercent >= 50  ? 'progressing'
            : 'behind',
      statusLabel: achievedPercent >= 100 ? '🎉 Chi nhánh đã đạt KPI tháng này'
                 : achievedPercent >= 80  ? '✨ Sắp đạt KPI'
                 : achievedPercent >= 50  ? '📈 Đang trên đà'
                 : '⚠️ Còn xa target',
    };
  } catch (err) {
    console.error('[getBranchKpiConfig]', err);
    return { error: err.message || 'Không lấy được cấu hình KPI' };
  }
}

// ─── Exports ────────────────────────────────────────────────────────────
module.exports = {
  getMySalary,
  getMyKPI,
  getSalaryHistory,
  getKpiImprovementSuggestions,
  // ⭐ Alias cho cách viết K hoa (chat.js đang dùng)
  getKPIImprovementSuggestions: getKpiImprovementSuggestions,
  getBranchKPIOverview,
  getBranchKpiConfig,            // ⭐ NEW
  getTopEmployees,
  getMyAdvances,
  getMyPenalties,
  computeSnapshot,
  resolveKpiForUser,
};