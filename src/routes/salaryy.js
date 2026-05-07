// backend/src/routes/salary.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const User = require('../models/User');
const { SalaryConfig, KpiConfig, SalaryRecord } = require('../models/Salary');
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

// Tính ra snapshot lương cho 1 user ở 1 kỳ (dùng cho preview & pay)
async function computeSnapshot(userId, year, month) {
  const [cfg, user] = await Promise.all([
    SalaryConfig.findOne({ user: userId }).lean(),
    User.findById(userId).select('branchId role fullName').lean(),
  ]);
  if (!user) throw new Error('Không tìm thấy user');

  const kpi = await resolveKpiForUser(user);
  const revenue = kpi ? await getEmployeeRevenue(user, year, month) : 0;
  const result = calculateSalary(
    {
      components: cfg?.components || [],
      target: kpi?.target || 0,
      roleKpi: kpi?.roleKpi || {},
    },
    revenue
  );

  return {
    user,
    cfg,
    kpi,
    revenue,
    result,
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
      .select('_id fullName email phone role branchId branchName')
      .sort({ fullName: 1 })
      .lean();

    res.json(
      users.map((u) => ({
        _id: u._id,
        name: u.fullName,
        email: u.email,
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

    let config = await SalaryConfig.findOne({ user: userId }).lean();
    if (!config) {
      config = { user: userId, components: [], currency: 'VND' };
    }
    res.json(config);
  } catch (err) {
    console.error('[GET /salary/config]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PUT /api/salary/config/:userId — Admin only
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

    const { components = [] } = req.body;
    if (!Array.isArray(components)) {
      return res.status(400).json({ message: 'components phải là array' });
    }
    for (const c of components) {
      if (!c.name || typeof c.amount !== 'number' || c.amount < 0) {
        return res.status(400).json({ message: 'Khoản lương không hợp lệ' });
      }
    }

    const config = await SalaryConfig.findOneAndUpdate(
      { user: userId },
      {
        $set: {
          user: userId,
          branchId: targetUser.branchId,
          components,
          updatedBy: req.user.id,
        },
      },
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
            .map((t) => ({
              upToPercent: Number(t.upToPercent),
              percent: Number(t.percent),
            }))
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
      {
        $set: {
          branchId,
          target: Number(target) || 0,
          roles: sanitized,
          updatedBy: req.user.id,
        },
      },
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

    // Mode 1: preview
    if (Array.isArray(components)) {
      const result = calculateSalary(
        { components, target: Number(target) || 0, roleKpi: roleKpi || {} },
        Number(revenue) || 0
      );
      return res.json(result);
    }

    // Mode 2: tính cho user thật (chỉ tháng hiện tại — preview live)
    if (userId) {
      if (!(await canView(req.user, userId))) {
        return res.status(403).json({ message: 'Không có quyền' });
      }
      const y = parseInt(year, 10) || new Date().getFullYear();
      const m = parseInt(month, 10) || new Date().getMonth() + 1;

      // Nếu kỳ này đã có SalaryRecord (đã chốt) → trả về snapshot từ DB
      const existing = await SalaryRecord.findOne({ user: userId, year: y, month: m }).lean();
      if (existing) {
        return res.json({
          fixedTotal: existing.fixedTotal,
          kpiBase: existing.kpiBase,
          kpiExceed: existing.kpiExceed,
          total: existing.total,
          breakdown: {
            target: existing.target,
            revenue: existing.revenue,
            exceed: Math.max(0, existing.revenue - existing.target),
            exceedPercent:
              existing.target > 0
                ? Math.round(
                    ((existing.revenue - existing.target) / existing.target) * 100 * 100
                  ) / 100
                : 0,
            basePercent: existing.basePercent,
            appliedTier: existing.appliedTier || null,
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

      // Chưa chốt → preview realtime
      const { user, cfg, kpi, revenue: rev, result } = await computeSnapshot(userId, y, m);

      return res.json({
        ...result,
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
// ⭐ POST /api/salary/pay/:userId — đánh dấu đã trả (gộp chốt + đánh dấu)
// Body: { year, month, paymentMethod, paidNote }
// Admin + Manager (cùng branch) đều được
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
    if (!year || !month) {
      return res.status(400).json({ message: 'Thiếu year/month' });
    }
    if (!['cash', 'transfer'].includes(paymentMethod)) {
      return res.status(400).json({ message: 'Phương thức thanh toán không hợp lệ' });
    }

    // Kiểm tra đã có record cho kỳ này chưa
    const existing = await SalaryRecord.findOne({ user: userId, year, month }).lean();
    if (existing && existing.paidStatus === 'paid') {
      return res.status(400).json({ message: 'Kỳ lương này đã được đánh dấu trả rồi' });
    }

    // Tính snapshot tại thời điểm hiện tại
    const { user, cfg, kpi, revenue, result } = await computeSnapshot(userId, year, month);

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
          total: result.total,
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
// ⭐ DELETE /api/salary/pay/:userId/:year/:month — hủy đánh dấu trả
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
// ⭐ GET /api/salary/history/:userId?months=12
// Trả lịch sử N tháng gần nhất (gồm cả tháng hiện tại = preview, các tháng trước = từ DB)
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

    // Tạo list (year, month) cho N tháng gần nhất, gần nhất ở đầu
    const periods = [];
    for (let i = 0; i < months; i++) {
      const d = new Date(currentYear, currentMonth - 1 - i, 1);
      periods.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    }

    // Fetch tất cả SalaryRecord trong khoảng này
    const earliest = periods[periods.length - 1];
    const records = await SalaryRecord.find({
      user: userId,
      $or: periods.map((p) => ({ year: p.year, month: p.month })),
    }).lean();

    const recordMap = new Map();
    for (const r of records) {
      recordMap.set(`${r.year}-${r.month}`, r);
    }

    // Build list từng tháng
    const history = [];
    for (const p of periods) {
      const key = `${p.year}-${p.month}`;
      const record = recordMap.get(key);

      if (record) {
        // Đã có snapshot
        history.push({
          year: p.year,
          month: p.month,
          fixedTotal: record.fixedTotal,
          kpiBase: record.kpiBase,
          kpiExceed: record.kpiExceed,
          total: record.total,
          revenue: record.revenue,
          target: record.target,
          paidStatus: record.paidStatus,
          paidAt: record.paidAt,
          paymentMethod: record.paymentMethod,
          paidNote: record.paidNote,
          isFinalized: true,
          isCurrent: p.year === currentYear && p.month === currentMonth,
        });
      } else if (p.year === currentYear && p.month === currentMonth) {
        // Tháng hiện tại chưa chốt → preview realtime
        try {
          const { result, revenue, kpi } = await computeSnapshot(userId, p.year, p.month);
          history.push({
            year: p.year,
            month: p.month,
            fixedTotal: result.fixedTotal,
            kpiBase: result.kpiBase,
            kpiExceed: result.kpiExceed,
            total: result.total,
            revenue,
            target: kpi?.target || 0,
            paidStatus: 'unpaid',
            isFinalized: false,
            isCurrent: true,
          });
        } catch {
          history.push({
            year: p.year,
            month: p.month,
            fixedTotal: 0,
            kpiBase: 0,
            kpiExceed: 0,
            total: 0,
            revenue: 0,
            target: 0,
            paidStatus: 'unpaid',
            isFinalized: false,
            isCurrent: true,
          });
        }
      } else {
        // Tháng cũ chưa được chốt → empty
        history.push({
          year: p.year,
          month: p.month,
          fixedTotal: 0,
          kpiBase: 0,
          kpiExceed: 0,
          total: 0,
          revenue: 0,
          target: 0,
          paidStatus: 'unpaid',
          isFinalized: false,
          isCurrent: false,
          isEmpty: true,
        });
      }
    }

    res.json({ history });
  } catch (err) {
    console.error('[GET /salary/history]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

module.exports = router;