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

// ─────────────────────────────────────────────────────────────────────────
// Phân quyền
// ─────────────────────────────────────────────────────────────────────────
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

const canEditSalary = (req) => req.role === 'Admin';
const canEditKpi = (req) => req.role === 'Admin' || req.role === 'Manager';

/** Lấy KPI áp dụng cho 1 user (theo branch của user, role của user) */
async function resolveKpiForUser(user) {
  if (!user || user.role === 'Admin') return null;
  if (!KPI_ROLES.includes(user.role)) return null;
  if (!user.branchId) return null;

  const cfg = await KpiConfig.findOne({ branchId: user.branchId }).lean();
  if (!cfg) return null;

  const roleKpi = cfg.roles?.[user.role];
  if (!roleKpi) return null;

  return {
    target: cfg.target || 0,
    roleKpi,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// GET /api/salary/employees?branchId=xxx
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
// GET /api/salary/kpi?branchId=xxx
// Trả về cả KpiConfig của branch (1 object), với roles đầy đủ 3 role
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

    // Default object — đảm bảo luôn đủ 3 role
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
// Body: { target, roles: { Manager: {...}, Receptionist: {...}, Staff: {...} } }
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
// Mode 1: { components, target, roleKpi, revenue } - preview
// Mode 2: { userId, year, month } - tính cho user
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

    // Mode 2: tính cho user thật
    if (userId) {
      if (!(await canView(req.user, userId))) {
        return res.status(403).json({ message: 'Không có quyền' });
      }
      const y = parseInt(year, 10) || new Date().getFullYear();
      const m = parseInt(month, 10) || new Date().getMonth() + 1;

      const [cfg, user] = await Promise.all([
        SalaryConfig.findOne({ user: userId }).lean(),
        User.findById(userId).select('branchId role fullName').lean(),
      ]);
      if (!user) return res.status(404).json({ message: 'Không tìm thấy user' });

      const kpi = await resolveKpiForUser(user);
      const rev = kpi ? await getEmployeeRevenue(user, y, m) : 0;
      const result = calculateSalary(
        {
          components: cfg?.components || [],
          target: kpi?.target || 0,
          roleKpi: kpi?.roleKpi || {},
        },
        rev
      );

      return res.json({
        ...result,
        revenue: rev,
        year: y,
        month: m,
        target: kpi?.target || 0,
        roleKpi: kpi?.roleKpi || null,
        hasKpi: !!kpi,
        userRole: user.role,
      });
    }

    return res.status(400).json({ message: 'Thiếu components hoặc userId' });
  } catch (err) {
    console.error('[POST /salary/calculate]', err);
    res.status(500).json({ message: 'Lỗi server' });
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
// POST /api/salary/finalize/:userId — Admin only
// ═════════════════════════════════════════════════════════════════════════
router.post('/finalize/:userId', authenticate, async (req, res) => {
  try {
    if (!canEditSalary(req.user)) {
      return res.status(403).json({ message: 'Chỉ Admin mới được chốt lương' });
    }

    const { userId } = req.params;
    const { year, month, note } = req.body;
    if (!year || !month) return res.status(400).json({ message: 'Thiếu year/month' });

    const [cfg, user] = await Promise.all([
      SalaryConfig.findOne({ user: userId }).lean(),
      User.findById(userId).select('branchId role').lean(),
    ]);
    if (!user) return res.status(404).json({ message: 'Không tìm thấy user' });

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
          note: note || '',
          createdBy: req.user.id,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json(record);
  } catch (err) {
    console.error('[POST /salary/finalize]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

module.exports = router;