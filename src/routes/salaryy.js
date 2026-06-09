// backend/src/routes/salaryy.js
//
// ⭐ UPDATED 11/05/2026: Tích hợp lương ứng (SalaryAdvance)
//   - POST /calculate: return thêm `advanceTotal` + `remainingToPay`
//   - POST /pay/:userId: snapshot `advanceTotal` + `advances[]` vào SalaryRecord
//   - GET /history/:userId: return thêm `advanceTotal` + `remainingToPay`
//
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const User = require('../models/User');
const Booking = require('../models/Booking');                                   // ⭐ NEW 19/05: discount charges
const { SalaryConfig, KpiConfig, SalaryRecord } = require('../models/Salary');
const { PenaltyRecord } = require('../models/Penalty');
const SalaryAdvance = require('../models/SalaryAdvance');                       // ⭐ NEW
const { calculateSalary } = require('../utils/Salarycalculator');
const { getEmployeeRevenue } = require('../services/revenueService');
const { authenticate } = require('../middleware/auth');

const KPI_ROLES = ['Manager', 'Receptionist', 'Staff'];

async function canView(requester, targetUserId) {
  if (String(requester.id) === String(targetUserId)) return true;
  if (requester.role === 'Admin') return true;
  if (requester.role === 'Manager') {
    if (!requester.branchId) return false;
    const target = await User.findById(targetUserId).select('branchId').lean();
    if (!target) return false;
    return String(target.branchId) === String(requester.branchId);
  }
  return false;
}

async function canPay(requester, targetUserId) {
  if (requester.role === 'Admin') return true;
  if (requester.role === 'Manager') {
    if (!requester.branchId) return false;
    const target = await User.findById(targetUserId).select('branchId').lean();
    if (!target) return false;
    return String(target.branchId) === String(requester.branchId);
  }
  return false;
}

const canEditSalary = (req) => req.role === 'Admin';
const canEditKpi = (req) => req.role === 'Admin' || req.role === 'Manager';

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

// Lấy danh sách phạt đang áp dụng cho user trong tháng (chưa snapshot)
async function getPenaltiesForPeriod(userId, year, month) {
  const records = await PenaltyRecord.find({ user: userId, year, month })
    .sort({ occurredOn: -1, createdAt: -1 })
    .lean();

  return records.map((r) => ({
    _id: r._id,
    penaltyId: r.penaltyId,
    name: r.penaltyName,
    type: r.penaltyType,
    minutes: r.minutes,
    severityName: r.severityName,
    amount: r.amount,
    reason: r.reason,
    occurredOn: r.occurredOn,
  }));
}

// ⭐ NEW 11/05/2026: Lấy danh sách lương ứng của user trong tháng
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
    createdBy: r.createdBy,
  }));
}

// ⭐ NEW 19/05/2026: Lấy danh sách chiết khấu NV chịu trách nhiệm trong tháng
//   Query Booking collection theo discountChargedTo + discountAppliedAt
//   Booking đã `cancelled` không tính (KS không thu tiền)
async function getDiscountChargesForPeriod(userId, year, month) {
  const start = new Date(year, month - 1, 1);
  const end   = new Date(year, month, 0, 23, 59, 59, 999);

  const bookings = await Booking.find({
    discountChargedTo: userId,
    discountAppliedAt: { $gte: start, $lte: end },
    status: { $nin: ['cancelled'] },
  })
    .select('_id bookingCode roomNumber customerName discount discountReason discountAppliedAt')
    .sort({ discountAppliedAt: -1 })
    .lean();

  return bookings.map((b) => ({
    bookingId:    b._id,
    bookingCode:  b.bookingCode || '',
    roomNumber:   b.roomNumber  || '',
    customerName: b.customerName|| '',
    amount:       Number(b.discount) || 0,
    reason:       b.discountReason || '',
    appliedAt:    b.discountAppliedAt,
  }));
}

// Tính snapshot lương cho 1 user ở 1 kỳ (gồm cả phạt + lương ứng + chiết khấu chịu)
async function computeSnapshot(userId, year, month) {
  const [cfg, user] = await Promise.all([
    // ⭐ đọc cơ cấu lương theo KỲ (carry-forward từ tháng trước nếu kỳ này chưa cấu hình)
    SalaryConfig.getConfigForPeriod(userId, year, month),
    User.findById(userId).select('branchId role fullName').lean(),
  ]);
  if (!user) throw new Error('Không tìm thấy user');

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

  // ⭐ NEW 30/05/2026: Quy tắc "tạm nghỉ" — nếu lương CỐ ĐỊNH = 0 ở kỳ này thì
  //   coi như NV không làm việc kỳ đó: KPI = 0, mọi khoản = 0 (vẫn hiện, đánh dấu Nghỉ).
  const isOnLeave = (result.fixedTotal || 0) <= 0;
  if (isOnLeave) {
    result.kpiBase = 0;
    result.kpiExceed = 0;
    result.penaltyTotal = 0;
    result.total = 0;
  }

  // ⭐ NEW 11/05/2026: Thêm advance vào snapshot
  const advances = await getAdvancesForPeriod(userId, year, month);
  const advanceTotal = advances.reduce((s, a) => s + (Number(a.amount) || 0), 0);

  // ⭐ NEW 19/05/2026: Discount charges (NV chịu trách nhiệm) — trừ vào total
  const discountCharges = await getDiscountChargesForPeriod(userId, year, month);
  const discountChargesTotal = discountCharges.reduce((s, d) => s + (Number(d.amount) || 0), 0);

  // Nếu NV nghỉ kỳ này (fixed=0) → total giữ 0, không trừ thêm gì.
  const totalAfterCharges = isOnLeave
    ? 0
    : Math.max(0, (result.total || 0) - discountChargesTotal);
  const remainingToPay    = isOnLeave
    ? 0
    : Math.max(0, totalAfterCharges - advanceTotal);

  // Override total trong result để các nơi khác (POST /calculate, /pay) dùng đúng
  result.total = totalAfterCharges;

  return {
    user, cfg, kpi, revenue, result, penalties,
    advances, advanceTotal,
    discountCharges, discountChargesTotal,
    remainingToPay,
    isOnLeave,   // ⭐ cờ NV nghỉ kỳ này (lương cố định = 0)
  };
}

// ═════════════════════════════════════════════════════════════════════════
// GET /api/salary/employees
// ═════════════════════════════════════════════════════════════════════════
router.get('/employees', authenticate, async (req, res) => {
  try {
    const { role, branchId: userBranch } = req.user;
    const filter = { isActive: true };

    if (role === 'Admin') {
      const queryBranch = req.query.branchId;
      if (queryBranch && mongoose.isValidObjectId(queryBranch)) {
        filter.branchId = queryBranch;
      }
    } else if (role === 'Manager') {
      if (!userBranch) return res.json([]);
      filter.branchId = userBranch;
    } else {
      filter._id = req.user.id;
    }

    const users = await User.find(filter)
      .select('_id fullName email phone avatar role branchId branchName')
      .sort({ fullName: 1 })
      .lean();

    res.json(
      users.map((u) => ({
        _id: u._id,
        name: u.fullName,
        email: u.email,
        avatar: u.avatar || '',
        role: u.role,
        branchId: u.branchId,
        department: u.branchName || '',
      }))
    );
  } catch (err) {
    console.error('[GET /salary/employees]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/salary/summary?year=&month=&branchId=
//   ⭐ NEW 30/05/2026: Tóm tắt lương CẢ DANH SÁCH NV cho 1 kỳ (Admin/Manager).
//   Trả mỗi NV: fixedTotal, kpi(=base+exceed), penaltyTotal, advanceTotal,
//   remainingToPay (nhận dự kiến), total, paidStatus.
// ═════════════════════════════════════════════════════════════════════════
router.get('/summary', authenticate, async (req, res) => {
  try {
    const { role, branchId: userBranch } = req.user;
    const filter = { isActive: true };

    if (role === 'Admin') {
      const queryBranch = req.query.branchId;
      if (queryBranch && mongoose.isValidObjectId(queryBranch)) {
        filter.branchId = queryBranch;
      }
    } else if (role === 'Manager') {
      if (!userBranch) return res.json({ year: null, month: null, rows: [] });
      filter.branchId = userBranch;
    } else {
      filter._id = req.user.id;
    }

    const year  = parseInt(req.query.year, 10)  || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);

    const users = await User.find(filter)
      .select('_id fullName username email avatar role branchId branchName createdAt')
      .sort({ fullName: 1 })
      .lean();

    // Đã chốt? lấy record; chưa thì computeSnapshot. Bỏ qua kỳ trước khi NV vào làm.
    const rows = [];
    for (const u of users) {
      // ẩn kỳ trước tháng tạo tài khoản
      if (u.createdAt) {
        const j = new Date(u.createdAt);
        const joinYM = j.getFullYear() * 12 + j.getMonth();
        const periodYM = year * 12 + (month - 1);
        if (periodYM < joinYM) continue;
      }

      let data = null;
      const record = await SalaryRecord.findOne({ user: u._id, year, month }).lean();
      if (record) {
        const advanceTotal = record.advanceTotal || 0;
        data = {
          fixedTotal: record.fixedTotal || 0,
          kpi: (record.kpiBase || 0) + (record.kpiExceed || 0),
          penaltyTotal: record.penaltyTotal || 0,
          advanceTotal,
          total: record.total || 0,
          remainingToPay: record.remainingToPay ?? Math.max(0, (record.total || 0) - advanceTotal),
          paidStatus: record.paidStatus || 'paid',
          isFinalized: true,
          isOnLeave: (record.fixedTotal || 0) <= 0,
        };
      } else {
        try {
          const { result, advanceTotal, remainingToPay, isOnLeave } = await computeSnapshot(u._id, year, month);
          data = {
            fixedTotal: result.fixedTotal || 0,
            kpi: (result.kpiBase || 0) + (result.kpiExceed || 0),
            penaltyTotal: result.penaltyTotal || 0,
            advanceTotal: advanceTotal || 0,
            total: result.total || 0,
            remainingToPay: remainingToPay ?? Math.max(0, (result.total || 0) - (advanceTotal || 0)),
            paidStatus: 'unpaid',
            isFinalized: false,
            isOnLeave: !!isOnLeave,
          };
        } catch {
          data = { fixedTotal: 0, kpi: 0, penaltyTotal: 0, advanceTotal: 0, total: 0, remainingToPay: 0, paidStatus: 'unpaid', isFinalized: false, isOnLeave: true };
        }
      }

      rows.push({
        _id: u._id,
        name: u.fullName,
        username: u.username || '',
        email: u.email,
        avatar: u.avatar || '',
        role: u.role,
        branchId: u.branchId,
        department: u.branchName || '',
        ...data,
      });
    }

    res.json({ year, month, rows });
  } catch (err) {
    console.error('[GET /salary/summary]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/salary/config/:userId
// ═════════════════════════════════════════════════════════════════════════
router.get('/config/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }
    if (!(await canView(req.user, userId))) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    // ⭐ Đọc cơ cấu theo KỲ nếu client truyền year/month; mặc định kỳ hiện tại.
    const qYear  = parseInt(req.query.year, 10)  || new Date().getFullYear();
    const qMonth = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);

    // bản đúng kỳ này (để biết kỳ này ĐÃ có cấu hình riêng hay đang kế thừa)
    const exact = await SalaryConfig.findOne({ user: userId, year: qYear, month: qMonth }).lean();
    // bản áp dụng (carry-forward) — dùng để hiển thị giá trị mặc định
    const effective = await SalaryConfig.getConfigForPeriod(userId, qYear, qMonth);

    const base = exact || effective;
    const config = base
      ? {
          user: userId,
          year: qYear,
          month: qMonth,
          components: base.components || [],
          currency: base.currency || 'VND',
          // metadata giúp FE biết đang kế thừa từ kỳ nào
          isInherited: !exact && !!effective,
          inheritedFrom: !exact && effective && effective.year
            ? { year: effective.year, month: effective.month }
            : null,
        }
      : { user: userId, year: qYear, month: qMonth, components: [], currency: 'VND', isInherited: false, inheritedFrom: null };

    res.json(config);
  } catch (err) {
    console.error('[GET /salary/config]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PUT /api/salary/config/:userId
// ═════════════════════════════════════════════════════════════════════════
router.put('/config/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }
    if (!canEditSalary(req.user)) {
      return res.status(403).json({ message: 'Chỉ Admin mới được setup lương' });
    }

    const targetUser = await User.findById(userId).select('branchId');
    if (!targetUser) return res.status(404).json({ message: 'Không tìm thấy user' });

    const { components = [], year, month } = req.body;
    if (!Array.isArray(components)) {
      return res.status(400).json({ message: 'components phải là array' });
    }
    for (const c of components) {
      if (!c.name || typeof c.amount !== 'number' || c.amount < 0) {
        return res.status(400).json({ message: 'Khoản lương không hợp lệ' });
      }
    }

    // ⭐ Lưu cơ cấu cho ĐÚNG KỲ. Mặc định kỳ hiện tại nếu client không truyền.
    const cfgYear  = parseInt(year, 10)  || new Date().getFullYear();
    const cfgMonth = parseInt(month, 10) || (new Date().getMonth() + 1);

    const config = await SalaryConfig.findOneAndUpdate(
      { user: userId, year: cfgYear, month: cfgMonth },
      { $set: {
          user: userId, year: cfgYear, month: cfgMonth,
          branchId: targetUser.branchId, components, updatedBy: req.user.id,
        } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json(config);
  } catch (err) {
    console.error('[PUT /salary/config]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/salary/kpi
// ═════════════════════════════════════════════════════════════════════════
router.get('/kpi', authenticate, async (req, res) => {
  try {
    const { role: userRole, branchId: userBranch } = req.user;

    let branchId = req.query.branchId;
    if (userRole === 'Manager') {
      branchId = String(userBranch);
    } else if (userRole !== 'Admin') {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    if (!branchId || !mongoose.isValidObjectId(branchId)) {
      return res.status(400).json({ message: 'Thiếu branchId' });
    }

    const cfg = await KpiConfig.findOne({ branchId }).lean();

    const result = {
      branchId,
      target: cfg?.target || 0,
      roles: {
        Manager: {
          basePercent: cfg?.roles?.Manager?.basePercent || 0,
          tiers: cfg?.roles?.Manager?.tiers || [],
          underTargetPolicy: cfg?.roles?.Manager?.underTargetPolicy || 'none',
        },
        Receptionist: {
          basePercent: cfg?.roles?.Receptionist?.basePercent || 0,
          tiers: cfg?.roles?.Receptionist?.tiers || [],
          underTargetPolicy: cfg?.roles?.Receptionist?.underTargetPolicy || 'none',
        },
        Staff: {
          basePercent: cfg?.roles?.Staff?.basePercent || 0,
          tiers: cfg?.roles?.Staff?.tiers || [],
          underTargetPolicy: cfg?.roles?.Staff?.underTargetPolicy || 'none',
        },
      },
    };

    res.json(result);
  } catch (err) {
    console.error('[GET /salary/kpi]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PUT /api/salary/kpi/:branchId
// ═════════════════════════════════════════════════════════════════════════
router.put('/kpi/:branchId', authenticate, async (req, res) => {
  try {
    if (!canEditKpi(req.user)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    const { branchId } = req.params;
    if (!mongoose.isValidObjectId(branchId)) {
      return res.status(400).json({ message: 'branchId không hợp lệ' });
    }

    if (req.user.role === 'Manager' && String(req.user.branchId) !== branchId) {
      return res.status(403).json({ message: 'Manager chỉ được sửa KPI branch mình' });
    }

    const { target = 0, roles = {} } = req.body;

    const sanitized = {};
    for (const r of KPI_ROLES) {
      const src = roles[r] || {};
      const tiers = Array.isArray(src.tiers)
        ? src.tiers
            .filter(
              (t) =>
                typeof t.upToPercent === 'number' &&
                typeof t.percent === 'number' &&
                t.upToPercent >= 0 &&
                t.percent >= 0
            )
            .map((t) => ({ upToPercent: Number(t.upToPercent), percent: Number(t.percent) }))
            .sort((a, b) => a.upToPercent - b.upToPercent)
        : [];

      sanitized[r] = {
        basePercent: Number(src.basePercent) || 0,
        tiers,
        underTargetPolicy: ['none', 'prorata'].includes(src.underTargetPolicy)
          ? src.underTargetPolicy
          : 'none',
      };
    }

    const updated = await KpiConfig.findOneAndUpdate(
      { branchId },
      { $set: { branchId, target: Number(target) || 0, roles: sanitized, updatedBy: req.user.id } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json(updated);
  } catch (err) {
    console.error('[PUT /salary/kpi]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/salary/calculate
// ═════════════════════════════════════════════════════════════════════════
router.post('/calculate', authenticate, async (req, res) => {
  try {
    const { components, target, roleKpi, revenue, userId, year, month } = req.body;

    if (Array.isArray(components)) {
      const result = calculateSalary(
        {
          components,
          target: Number(target) || 0,
          roleKpi: roleKpi || {},
          penalties: req.body.penalties || [],
        },
        Number(revenue) || 0
      );
      return res.json(result);
    }

    if (userId) {
      if (!(await canView(req.user, userId))) {
        return res.status(403).json({ message: 'Không có quyền' });
      }
      const y = parseInt(year, 10) || new Date().getFullYear();
      const m = parseInt(month, 10) || new Date().getMonth() + 1;

      // Nếu đã có SalaryRecord (đã chốt) → trả snapshot
      const existing = await SalaryRecord.findOne({ user: userId, year: y, month: m }).lean();
      if (existing) {
        // ⭐ NEW 11/05/2026: Đọc advanceTotal từ snapshot (đã chốt thì giữ nguyên)
        const existingAdvanceTotal   = existing.advanceTotal   || 0;
        const existingDiscountChargesTotal = existing.discountChargesTotal || 0;   // ⭐ NEW 19/05
        const existingRemainingToPay = existing.remainingToPay ?? Math.max(0, existing.total - existingAdvanceTotal);

        return res.json({
          fixedTotal: existing.fixedTotal,
          kpiBase: existing.kpiBase,
          kpiExceed: existing.kpiExceed,
          penaltyTotal: existing.penaltyTotal || 0,
          penalties: existing.penalties || [],
          total: existing.total,
          // ⭐ NEW
          advanceTotal:   existingAdvanceTotal,
          remainingToPay: existingRemainingToPay,
          advances:       existing.advances || [],
          // ⭐ NEW 19/05: Discount charges từ snapshot
          discountCharges:      existing.discountCharges || [],
          discountChargesTotal: existingDiscountChargesTotal,
          breakdown: {
            target: existing.target,
            revenue: existing.revenue,
            exceed: Math.max(0, existing.revenue - existing.target),
            exceedPercent:
              existing.target > 0
                ? Math.round(((existing.revenue - existing.target) / existing.target) * 100 * 100) /
                  100
                : 0,
            basePercent: existing.basePercent,
            appliedTier: existing.appliedTier || null,
            penaltyCount: (existing.penalties || []).length,
          },
          revenue: existing.revenue,
          year: y,
          month: m,
          target: existing.target,
          roleKpi: { basePercent: existing.basePercent },
          hasKpi: true,
          userRole: existing.role,
          isFinalized: true,
          paidStatus: existing.paidStatus,
          paidAt: existing.paidAt,
          paymentMethod: existing.paymentMethod,
          paidNote: existing.paidNote,
        });
      }

      // Chưa chốt → tính realtime (đã có sẵn advance + discountCharges trong computeSnapshot)
      const {
        user, kpi, revenue: rev, result, penalties,
        advances, advanceTotal, remainingToPay,
        discountCharges, discountChargesTotal,
      } = await computeSnapshot(userId, y, m);

      return res.json({
        ...result,
        penalties,
        // ⭐ NEW
        advanceTotal,
        remainingToPay,
        advances,
        // ⭐ NEW 19/05
        discountCharges,
        discountChargesTotal,
        revenue: rev,
        year: y,
        month: m,
        target: kpi?.target || 0,
        roleKpi: kpi?.roleKpi || null,
        hasKpi: !!kpi,
        userRole: user.role,
        isFinalized: false,
      });
    }

    return res.status(400).json({ message: 'Thiếu components hoặc userId' });
  } catch (err) {
    console.error('[POST /salary/calculate]', err);
    res.status(500).json({ message: err.message || 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/salary/revenue/:userId
// ═════════════════════════════════════════════════════════════════════════
router.get('/revenue/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!(await canView(req.user, userId))) {
      return res.status(403).json({ message: 'Không có quyền' });
    }
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || new Date().getMonth() + 1;

    const user = await User.findById(userId).select('branchId role').lean();
    if (!user) return res.status(404).json({ message: 'Không tìm thấy user' });

    const revenue = await getEmployeeRevenue(user, year, month);
    res.json({ revenue, year, month });
  } catch (err) {
    console.error('[GET /salary/revenue]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/salary/pay/:userId — đánh dấu đã trả
// ═════════════════════════════════════════════════════════════════════════
router.post('/pay/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }
    if (!(await canPay(req.user, userId))) {
      return res.status(403).json({ message: 'Không có quyền đánh dấu đã trả' });
    }

    const { year, month, paymentMethod = 'cash', paidNote = '' } = req.body;
    if (!year || !month) return res.status(400).json({ message: 'Thiếu year/month' });
    if (!['cash', 'transfer'].includes(paymentMethod)) {
      return res.status(400).json({ message: 'Phương thức thanh toán không hợp lệ' });
    }

    const existing = await SalaryRecord.findOne({ user: userId, year, month }).lean();
    if (existing && existing.paidStatus === 'paid') {
      return res.status(400).json({ message: 'Kỳ lương này đã được đánh dấu trả rồi' });
    }

    const {
      user, cfg, kpi, revenue, result, penalties,
      advances, advanceTotal, remainingToPay,
      discountCharges, discountChargesTotal,
    } = await computeSnapshot(userId, year, month);

    const record = await SalaryRecord.findOneAndUpdate(
      { user: userId, year, month },
      {
        $set: {
          user: userId,
          branchId: user.branchId,
          role: user.role,
          year,
          month,
          components: cfg?.components || [],
          target: kpi?.target || 0,
          basePercent: kpi?.roleKpi?.basePercent || 0,
          appliedTier: result.breakdown.appliedTier || null,
          revenue,
          fixedTotal: result.fixedTotal,
          kpiBase: result.kpiBase,
          kpiExceed: result.kpiExceed,
          penalties: penalties.map((p) => ({
            penaltyId: p.penaltyId,
            name: p.name,
            type: p.type,
            minutes: p.minutes,
            severityName: p.severityName,
            amount: p.amount,
            reason: p.reason,
            occurredOn: p.occurredOn,
          })),
          penaltyTotal: result.penaltyTotal,

          // ⭐ NEW 19/05/2026: Snapshot discount charges
          discountCharges: discountCharges.map((d) => ({
            bookingId:    d.bookingId,
            bookingCode:  d.bookingCode,
            roomNumber:   d.roomNumber,
            customerName: d.customerName,
            amount:       d.amount,
            reason:       d.reason,
            appliedAt:    d.appliedAt,
          })),
          discountChargesTotal,

          total: result.total,

          // ⭐ NEW 11/05/2026: Snapshot lương ứng
          advanceTotal,
          remainingToPay,
          advances: advances.map((a) => ({
            advanceId: a._id,
            amount: a.amount,
            reason: a.reason,
            paymentMethod: a.paymentMethod,
            note: a.note,
            advancedAt: a.advancedAt,
          })),

          paidStatus: 'paid',
          paidAt: new Date(),
          paymentMethod,
          paidNote,
          paidBy: req.user.id,
          createdBy: req.user.id,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json(record);
  } catch (err) {
    console.error('[POST /salary/pay]', err);
    res.status(500).json({ message: err.message || 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// DELETE /api/salary/pay/:userId/:year/:month
// ═════════════════════════════════════════════════════════════════════════
router.delete('/pay/:userId/:year/:month', authenticate, async (req, res) => {
  try {
    const { userId, year, month } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }
    if (!(await canPay(req.user, userId))) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    const result = await SalaryRecord.deleteOne({
      user: userId,
      year: parseInt(year, 10),
      month: parseInt(month, 10),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Không tìm thấy bản ghi' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /salary/pay]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/salary/history/:userId?months=12
// ═════════════════════════════════════════════════════════════════════════
router.get('/history/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!(await canView(req.user, userId))) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 12);
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    // ⭐ NEW 30/05/2026: chỉ tính lương TỪ tháng nhân viên được tạo tài khoản trở đi.
    //   Các tháng trước khi NV vào làm không hiển thị.
    const histUser = await User.findById(userId).select('createdAt').lean();
    const joinDate = histUser?.createdAt ? new Date(histUser.createdAt) : null;
    const joinYM = joinDate ? joinDate.getFullYear() * 12 + joinDate.getMonth() : null; // tháng 0-index

    const periods = [];
    for (let i = 0; i < months; i++) {
      const d = new Date(currentYear, currentMonth - 1 - i, 1);
      // Bỏ qua kỳ trước tháng NV vào làm
      if (joinYM !== null) {
        const periodYM = d.getFullYear() * 12 + d.getMonth();
        if (periodYM < joinYM) continue;
      }
      periods.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    }

    const records = await SalaryRecord.find({
      user: userId,
      $or: periods.map((p) => ({ year: p.year, month: p.month })),
    }).lean();

    const recordMap = new Map();
    for (const r of records) {
      recordMap.set(`${r.year}-${r.month}`, r);
    }

    const history = [];
    for (const p of periods) {
      const key = `${p.year}-${p.month}`;
      const record = recordMap.get(key);

      if (record) {
        // ⭐ NEW 11/05/2026: Đọc advanceTotal từ snapshot
        const recAdvanceTotal   = record.advanceTotal   || 0;
        const recDiscountChargesTotal = record.discountChargesTotal || 0;   // ⭐ NEW 19/05
        const recRemainingToPay = record.remainingToPay ?? Math.max(0, record.total - recAdvanceTotal);

        history.push({
          year: p.year,
          month: p.month,
          fixedTotal: record.fixedTotal,
          kpiBase: record.kpiBase,
          kpiExceed: record.kpiExceed,
          penaltyTotal: record.penaltyTotal || 0,
          total: record.total,
          advanceTotal:   recAdvanceTotal,
          remainingToPay: recRemainingToPay,
          discountChargesTotal: recDiscountChargesTotal,   // ⭐ NEW 19/05
          revenue: record.revenue,
          target: record.target,
          paidStatus: record.paidStatus,
          paidAt: record.paidAt,
          paymentMethod: record.paymentMethod,
          paidNote: record.paidNote,
          isFinalized: true,
          isCurrent: p.year === currentYear && p.month === currentMonth,
        });
      } else {
        // ⭐ FIX 30/05/2026: TRƯỚC ĐÂY chỉ tháng hiện tại mới được tính snapshot tạm,
        //   các tháng quá khứ chưa chốt bị đánh isEmpty → không thể chốt (vd: qua
        //   tháng 6 nhưng lương tháng 5 chưa tổng kết). NAY: mọi tháng chưa có record
        //   đều thử computeSnapshot để có số liệu xem + chốt.
        const isCurrent = p.year === currentYear && p.month === currentMonth;
        try {
          const { result, revenue, kpi, advanceTotal, remainingToPay, discountChargesTotal } =
            await computeSnapshot(userId, p.year, p.month);
          // Nếu tháng không có cấu hình lương + không phát sinh gì → coi là rỗng thật.
          const hasData = (result.fixedTotal || 0) > 0
            || (result.total || 0) > 0
            || (revenue || 0) > 0
            || (result.penaltyTotal || 0) > 0;
          history.push({
            year: p.year,
            month: p.month,
            fixedTotal: result.fixedTotal,
            kpiBase: result.kpiBase,
            kpiExceed: result.kpiExceed,
            penaltyTotal: result.penaltyTotal || 0,
            total: result.total,
            advanceTotal,
            remainingToPay,
            discountChargesTotal,
            revenue,
            target: kpi?.target || 0,
            paidStatus: 'unpaid',
            isFinalized: false,
            isCurrent,
            // chỉ đánh rỗng khi thực sự không có gì để chốt
            isEmpty: !hasData,
          });
        } catch {
          history.push({
            year: p.year,
            month: p.month,
            fixedTotal: 0, kpiBase: 0, kpiExceed: 0, penaltyTotal: 0, total: 0,
            advanceTotal: 0, remainingToPay: 0, discountChargesTotal: 0,
            revenue: 0, target: 0,
            paidStatus: 'unpaid',
            isFinalized: false,
            isCurrent,
            isEmpty: true,
          });
        }
      }
    }

    res.json({ history });
  } catch (err) {
    console.error('[GET /salary/history]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

module.exports = router;