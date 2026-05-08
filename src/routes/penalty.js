// backend/src/routes/penalty.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const User = require('../models/User');
const { Penalty, PenaltyRecord } = require('../models/Penalty');
const { authenticate } = require('../middleware/auth');

const isAdmin = (req) => req.user?.role === 'Admin';
const isManager = (req) => req.user?.role === 'Manager';
const canRecord = (req) => isAdmin(req) || isManager(req);

async function canRecordForUser(req, targetUserId) {
  if (isAdmin(req)) return true;
  if (isManager(req)) {
    if (!req.user.branchId) return false;
    const target = await User.findById(targetUserId).select('branchId').lean();
    if (!target) return false;
    return String(target.branchId) === String(req.user.branchId);
  }
  return false;
}

async function canViewForUser(req, targetUserId) {
  if (String(req.user.id) === String(targetUserId)) return true;
  return canRecordForUser(req, targetUserId);
}

// Tính số tiền phạt từ định nghĩa Penalty + input
function computePenaltyAmount(penalty, { minutes, severityName }) {
  if (!penalty) return 0;

  if (penalty.type === 'fixed') {
    return Number(penalty.fixedAmount) || 0;
  }

  if (penalty.type === 'per_minute') {
    const m = Math.max(0, Number(minutes) || 0);
    const total = (Number(penalty.perMinuteAmount) || 0) * m;
    if (penalty.maxAmount > 0 && total > penalty.maxAmount) {
      return penalty.maxAmount;
    }
    return total;
  }

  if (penalty.type === 'tiered') {
    const tier = (penalty.severityTiers || []).find((t) => t.name === severityName);
    return tier ? Number(tier.amount) || 0 : 0;
  }

  return 0;
}

// ═════════════════════════════════════════════════════════════════════════
// GET /api/penalty/catalog?branchId=...
// Liệt kê danh mục các loại phạt của 1 branch
// ═════════════════════════════════════════════════════════════════════════
router.get('/catalog', authenticate, async (req, res) => {
  try {
    let branchId = req.query.branchId;
    if (isManager(req)) {
      branchId = String(req.user.branchId);
    } else if (!isAdmin(req)) {
      // Nhân viên thường: lấy theo branch của mình
      branchId = String(req.user.branchId);
    }

    if (!branchId || !mongoose.isValidObjectId(branchId)) {
      return res.status(400).json({ message: 'Thiếu branchId' });
    }

    const list = await Penalty.find({ branchId, isActive: true })
      .sort({ category: 1, name: 1 })
      .lean();

    res.json(list);
  } catch (err) {
    console.error('[GET /penalty/catalog]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/penalty/catalog — tạo loại phạt mới (Admin)
// ═════════════════════════════════════════════════════════════════════════
router.post('/catalog', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Admin được tạo loại phạt' });
    }

    const {
      branchId,
      name,
      description = '',
      type,
      fixedAmount = 0,
      perMinuteAmount = 0,
      maxAmount = 0,
      severityTiers = [],
      category = 'other',
    } = req.body;

    if (!mongoose.isValidObjectId(branchId)) {
      return res.status(400).json({ message: 'branchId không hợp lệ' });
    }
    if (!name || !type) {
      return res.status(400).json({ message: 'Thiếu name hoặc type' });
    }
    if (!['fixed', 'per_minute', 'tiered'].includes(type)) {
      return res.status(400).json({ message: 'Type không hợp lệ' });
    }

    const doc = await Penalty.create({
      branchId,
      name: String(name).trim(),
      description,
      type,
      fixedAmount: Number(fixedAmount) || 0,
      perMinuteAmount: Number(perMinuteAmount) || 0,
      maxAmount: Number(maxAmount) || 0,
      severityTiers: Array.isArray(severityTiers)
        ? severityTiers
            .filter((t) => t.name && typeof t.amount === 'number')
            .map((t) => ({ name: String(t.name).trim(), amount: Number(t.amount) || 0 }))
        : [],
      category,
      createdBy: req.user.id,
    });

    res.json(doc);
  } catch (err) {
    console.error('[POST /penalty/catalog]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PUT /api/penalty/catalog/:id — cập nhật (Admin)
// ═════════════════════════════════════════════════════════════════════════
router.put('/catalog/:id', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Admin được sửa loại phạt' });
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }

    const allowedFields = [
      'name',
      'description',
      'type',
      'fixedAmount',
      'perMinuteAmount',
      'maxAmount',
      'severityTiers',
      'category',
      'isActive',
    ];
    const update = {};
    for (const f of allowedFields) {
      if (req.body[f] !== undefined) update[f] = req.body[f];
    }
    if (update.type && !['fixed', 'per_minute', 'tiered'].includes(update.type)) {
      return res.status(400).json({ message: 'Type không hợp lệ' });
    }
    if (update.severityTiers && Array.isArray(update.severityTiers)) {
      update.severityTiers = update.severityTiers
        .filter((t) => t.name && typeof t.amount === 'number')
        .map((t) => ({ name: String(t.name).trim(), amount: Number(t.amount) || 0 }));
    }
    update.updatedBy = req.user.id;

    const doc = await Penalty.findByIdAndUpdate(id, { $set: update }, { new: true });
    if (!doc) return res.status(404).json({ message: 'Không tìm thấy' });

    res.json(doc);
  } catch (err) {
    console.error('[PUT /penalty/catalog]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// DELETE /api/penalty/catalog/:id — soft delete bằng cách set isActive=false
// ═════════════════════════════════════════════════════════════════════════
router.delete('/catalog/:id', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Admin được xóa' });
    }
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }

    await Penalty.findByIdAndUpdate(id, { $set: { isActive: false, updatedBy: req.user.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /penalty/catalog]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/penalty/records/:userId?year=&month=
// Lấy danh sách phạt của user trong tháng
// ═════════════════════════════════════════════════════════════════════════
router.get('/records/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }
    if (!(await canViewForUser(req, userId))) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || new Date().getMonth() + 1;

    const records = await PenaltyRecord.find({ user: userId, year, month })
      .sort({ occurredOn: -1, createdAt: -1 })
      .lean();

    res.json(records);
  } catch (err) {
    console.error('[GET /penalty/records]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/penalty/records — ghi nhận phạt mới
// Body: { userId, year, month, penaltyId, minutes, severityName, occurredOn, reason }
// ═════════════════════════════════════════════════════════════════════════
router.post('/records', authenticate, async (req, res) => {
  try {
    if (!canRecord(req)) {
      return res.status(403).json({ message: 'Không có quyền ghi nhận phạt' });
    }

    const {
      userId,
      year,
      month,
      penaltyId,
      minutes = 0,
      severityName = '',
      occurredOn,
      reason = '',
      note = '',
    } = req.body;

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }
    if (!(await canRecordForUser(req, userId))) {
      return res.status(403).json({ message: 'Không có quyền với user này' });
    }
    if (!year || !month) {
      return res.status(400).json({ message: 'Thiếu year/month' });
    }
    if (!mongoose.isValidObjectId(penaltyId)) {
      return res.status(400).json({ message: 'penaltyId không hợp lệ' });
    }

    const penalty = await Penalty.findById(penaltyId).lean();
    if (!penalty) return res.status(404).json({ message: 'Không tìm thấy loại phạt' });

    // Validate theo type
    if (penalty.type === 'per_minute' && (!minutes || minutes <= 0)) {
      return res.status(400).json({ message: 'Vui lòng nhập số phút' });
    }
    if (penalty.type === 'tiered' && !severityName) {
      return res.status(400).json({ message: 'Vui lòng chọn mức độ' });
    }

    const amount = computePenaltyAmount(penalty, { minutes, severityName });

    const targetUser = await User.findById(userId).select('branchId').lean();

    const record = await PenaltyRecord.create({
      user: userId,
      branchId: targetUser?.branchId,
      year,
      month,
      penaltyId,
      penaltyName: penalty.name,
      penaltyType: penalty.type,
      category: penalty.category,
      minutes: penalty.type === 'per_minute' ? Number(minutes) || 0 : 0,
      severityName: penalty.type === 'tiered' ? severityName : '',
      perMinuteAmount: penalty.type === 'per_minute' ? penalty.perMinuteAmount : 0,
      amount,
      occurredOn: occurredOn ? new Date(occurredOn) : null,
      reason,
      note,
      createdBy: req.user.id,
    });

    res.json(record);
  } catch (err) {
    console.error('[POST /penalty/records]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PUT /api/penalty/records/:id — cập nhật ghi nhận phạt
// ═════════════════════════════════════════════════════════════════════════
router.put('/records/:id', authenticate, async (req, res) => {
  try {
    if (!canRecord(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }

    const existing = await PenaltyRecord.findById(id).lean();
    if (!existing) return res.status(404).json({ message: 'Không tìm thấy' });

    if (!(await canRecordForUser(req, existing.user))) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    const { minutes, severityName, occurredOn, reason, note } = req.body;

    // Lấy penalty để tính lại amount
    const penalty = await Penalty.findById(existing.penaltyId).lean();
    let amount = existing.amount;
    if (penalty) {
      amount = computePenaltyAmount(penalty, {
        minutes: minutes ?? existing.minutes,
        severityName: severityName ?? existing.severityName,
      });
    }

    const update = {
      minutes: minutes ?? existing.minutes,
      severityName: severityName ?? existing.severityName,
      occurredOn: occurredOn !== undefined ? (occurredOn ? new Date(occurredOn) : null) : existing.occurredOn,
      reason: reason ?? existing.reason,
      note: note ?? existing.note,
      amount,
      updatedBy: req.user.id,
    };

    const doc = await PenaltyRecord.findByIdAndUpdate(id, { $set: update }, { new: true });
    res.json(doc);
  } catch (err) {
    console.error('[PUT /penalty/records]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// DELETE /api/penalty/records/:id
// ═════════════════════════════════════════════════════════════════════════
router.delete('/records/:id', authenticate, async (req, res) => {
  try {
    if (!canRecord(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }

    const existing = await PenaltyRecord.findById(id).lean();
    if (!existing) return res.status(404).json({ message: 'Không tìm thấy' });

    if (!(await canRecordForUser(req, existing.user))) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    await PenaltyRecord.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /penalty/records]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

module.exports = router;