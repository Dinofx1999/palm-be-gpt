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

const VALID_TYPES = ['fixed', 'time_window', 'repeat_count'];
const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'];

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

// ⭐ Tính số tiền phạt theo type
function computePenaltyAmount(penalty, { minutes, occurrence }) {
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

    for (const t of tiers) {
      if (m <= t.upToMinutes) {
        return {
          amount: Number(t.amount) || 0,
          appliedTier: { upToMinutes: t.upToMinutes, amount: t.amount },
        };
      }
    }
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

// ═════════════════════════════════════════════════════════════════════════
// GET /api/penalty/catalog?branchId=...
// ═════════════════════════════════════════════════════════════════════════
router.get('/catalog', authenticate, async (req, res) => {
  try {
    let branchId = req.query.branchId;
    if (isManager(req)) {
      branchId = String(req.user.branchId);
    } else if (!isAdmin(req)) {
      branchId = String(req.user.branchId);
    }

    if (!branchId || !mongoose.isValidObjectId(branchId)) {
      return res.status(400).json({ message: 'Thiếu branchId' });
    }

    const list = await Penalty.find({ branchId, isActive: true })
      .sort({ severity: 1, name: 1 })
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
      timeWindowTiers = [],
      repeatCountTiers = [],
      severity = 'medium',
      autoApplyOnLate = false,
    } = req.body;

    if (!mongoose.isValidObjectId(branchId)) {
      return res.status(400).json({ message: 'branchId không hợp lệ' });
    }
    if (!name || !type) {
      return res.status(400).json({ message: 'Thiếu name hoặc type' });
    }
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({
        message: `Type không hợp lệ. Phải là: ${VALID_TYPES.join(', ')}`,
      });
    }
    if (!VALID_SEVERITIES.includes(severity)) {
      return res.status(400).json({
        message: `Severity không hợp lệ. Phải là: ${VALID_SEVERITIES.join(', ')}`,
      });
    }

    // Sanitize tiers
    const cleanTimeWindowTiers = Array.isArray(timeWindowTiers)
      ? timeWindowTiers
          .filter(
            (t) =>
              typeof t.upToMinutes === 'number' &&
              typeof t.amount === 'number' &&
              t.upToMinutes > 0 &&
              t.amount >= 0
          )
          .map((t) => ({
            upToMinutes: Number(t.upToMinutes),
            amount: Number(t.amount),
          }))
          .sort((a, b) => a.upToMinutes - b.upToMinutes)
      : [];

    const cleanRepeatCountTiers = Array.isArray(repeatCountTiers)
      ? repeatCountTiers
          .filter(
            (t) =>
              typeof t.occurrence === 'number' &&
              typeof t.amount === 'number' &&
              t.occurrence >= 1 &&
              t.amount >= 0
          )
          .map((t) => ({
            occurrence: Number(t.occurrence),
            amount: Number(t.amount),
          }))
          .sort((a, b) => a.occurrence - b.occurrence)
      : [];

    // Validate có data theo type
    if (type === 'time_window' && cleanTimeWindowTiers.length === 0) {
      return res.status(400).json({ message: 'Khung giờ phải có ít nhất 1 bậc' });
    }
    if (type === 'repeat_count' && cleanRepeatCountTiers.length === 0) {
      return res.status(400).json({ message: 'Khung nhiều lần phải có ít nhất 1 bậc' });
    }

    const doc = await Penalty.create({
      branchId,
      name: String(name).trim(),
      description,
      type,
      fixedAmount: Number(fixedAmount) || 0,
      timeWindowTiers: cleanTimeWindowTiers,
      repeatCountTiers: cleanRepeatCountTiers,
      severity,
      autoApplyOnLate: !!autoApplyOnLate,
      createdBy: req.user.id,
    });

    res.json(doc);
  } catch (err) {
    console.error('[POST /penalty/catalog]', err);
    res.status(500).json({ message: err.message || 'Lỗi server' });
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
      'timeWindowTiers',
      'repeatCountTiers',
      'severity',
      'autoApplyOnLate',
      'isActive',
    ];
    const update = {};
    for (const f of allowedFields) {
      if (req.body[f] !== undefined) update[f] = req.body[f];
    }

    if (update.type && !VALID_TYPES.includes(update.type)) {
      return res.status(400).json({
        message: `Type không hợp lệ. Phải là: ${VALID_TYPES.join(', ')}`,
      });
    }
    if (update.severity && !VALID_SEVERITIES.includes(update.severity)) {
      return res.status(400).json({ message: 'Severity không hợp lệ' });
    }

    if (update.timeWindowTiers && Array.isArray(update.timeWindowTiers)) {
      update.timeWindowTiers = update.timeWindowTiers
        .filter(
          (t) =>
            typeof t.upToMinutes === 'number' &&
            typeof t.amount === 'number' &&
            t.upToMinutes > 0 &&
            t.amount >= 0
        )
        .map((t) => ({
          upToMinutes: Number(t.upToMinutes),
          amount: Number(t.amount),
        }))
        .sort((a, b) => a.upToMinutes - b.upToMinutes);
    }

    if (update.repeatCountTiers && Array.isArray(update.repeatCountTiers)) {
      update.repeatCountTiers = update.repeatCountTiers
        .filter(
          (t) =>
            typeof t.occurrence === 'number' &&
            typeof t.amount === 'number' &&
            t.occurrence >= 1 &&
            t.amount >= 0
        )
        .map((t) => ({
          occurrence: Number(t.occurrence),
          amount: Number(t.amount),
        }))
        .sort((a, b) => a.occurrence - b.occurrence);
    }

    update.updatedBy = req.user.id;

    const doc = await Penalty.findByIdAndUpdate(id, { $set: update }, { new: true });
    if (!doc) return res.status(404).json({ message: 'Không tìm thấy' });

    res.json(doc);
  } catch (err) {
    console.error('[PUT /penalty/catalog]', err);
    res.status(500).json({ message: err.message || 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// DELETE /api/penalty/catalog/:id — soft delete
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

    await Penalty.findByIdAndUpdate(id, {
      $set: { isActive: false, updatedBy: req.user.id },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /penalty/catalog]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/penalty/records/:userId?year=&month=
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
      occurrence = 0,
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
    if (penalty.type === 'time_window' && (!minutes || minutes <= 0)) {
      return res.status(400).json({ message: 'Vui lòng nhập số phút trễ' });
    }
    if (penalty.type === 'repeat_count' && (!occurrence || occurrence < 1)) {
      return res.status(400).json({ message: 'Vui lòng nhập số lần vi phạm' });
    }

    const { amount, appliedTier } = computePenaltyAmount(penalty, { minutes, occurrence });

    const targetUser = await User.findById(userId).select('branchId').lean();

    const record = await PenaltyRecord.create({
      user: userId,
      branchId: targetUser?.branchId,
      year,
      month,
      penaltyId,
      penaltyName: penalty.name,
      penaltyType: penalty.type,
      severity: penalty.severity,
      minutes: penalty.type === 'time_window' ? Number(minutes) || 0 : 0,
      occurrence: penalty.type === 'repeat_count' ? Number(occurrence) || 0 : 0,
      appliedTier,
      amount,
      occurredOn: occurredOn ? new Date(occurredOn) : null,
      reason,
      note,
      createdBy: req.user.id,
    });

    res.json(record);
  } catch (err) {
    console.error('[POST /penalty/records]', err);
    res.status(500).json({ message: err.message || 'Lỗi server' });
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

    const { minutes, occurrence, occurredOn, reason, note } = req.body;

    // Tính lại amount
    const penalty = await Penalty.findById(existing.penaltyId).lean();
    let amount = existing.amount;
    let appliedTier = existing.appliedTier;
    if (penalty) {
      const calc = computePenaltyAmount(penalty, {
        minutes: minutes ?? existing.minutes,
        occurrence: occurrence ?? existing.occurrence,
      });
      amount = calc.amount;
      appliedTier = calc.appliedTier;
    }

    const update = {
      minutes: minutes ?? existing.minutes,
      occurrence: occurrence ?? existing.occurrence,
      appliedTier,
      occurredOn:
        occurredOn !== undefined
          ? occurredOn
            ? new Date(occurredOn)
            : null
          : existing.occurredOn,
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