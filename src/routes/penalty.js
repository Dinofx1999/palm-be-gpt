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

// ═══════════════════════════════════════════════════════════════════════
// ⭐ POST /api/penalty/catalog/:id/copy-to-branches
// Copy 1 loại phạt sang nhiều branch đích (chỉ thêm mới, giữ nguyên data cũ)
// Body: { targetBranchIds: ['id1', 'id2'], skipIfNameExists: true }
// ═══════════════════════════════════════════════════════════════════════
router.post('/catalog/:id/copy-to-branches', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Admin được copy/đồng bộ' });
    }

    const { id } = req.params;
    const { targetBranchIds = [], skipIfNameExists = true } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }
    if (!Array.isArray(targetBranchIds) || targetBranchIds.length === 0) {
      return res.status(400).json({ message: 'Phải chọn ít nhất 1 branch đích' });
    }

    const source = await Penalty.findById(id).lean();
    if (!source) return res.status(404).json({ message: 'Không tìm thấy loại phạt' });

    const validBranchIds = targetBranchIds.filter((b) =>
      mongoose.isValidObjectId(b) && String(b) !== String(source.branchId)
    );

    if (validBranchIds.length === 0) {
      return res.status(400).json({
        message: 'Không có branch đích hợp lệ (không thể copy về chính branch nguồn)',
      });
    }

    const results = {
      created: [],
      skipped: [],
      errors: [],
    };

    for (const targetBranchId of validBranchIds) {
      try {
        if (skipIfNameExists) {
          const existing = await Penalty.findOne({
            branchId: targetBranchId,
            name: source.name,
            isActive: { $ne: false },
          }).lean();
          if (existing) {
            results.skipped.push({
              branchId: targetBranchId,
              reason: `Đã có loại phạt "${source.name}"`,
            });
            continue;
          }
        }

        const { _id, createdAt, updatedAt, __v, ...cloneData } = source;
        const newPenalty = await Penalty.create({
          ...cloneData,
          branchId: targetBranchId,
          createdBy: req.user.id,
        });

        results.created.push({
          branchId: targetBranchId,
          newId: newPenalty._id,
        });
      } catch (err) {
        results.errors.push({
          branchId: targetBranchId,
          error: err.message,
        });
      }
    }

    res.json({
      success: true,
      sourceName: source.name,
      results,
      message: `Đã copy "${source.name}" sang ${results.created.length}/${validBranchIds.length} branch`,
    });
  } catch (err) {
    console.error('[POST /penalty/catalog/copy]', err);
    res.status(500).json({ message: err.message || 'Lỗi server' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ⭐ POST /api/penalty/catalog/sync-to-branches
// Đồng bộ TOÀN BỘ catalog từ branch nguồn → các branch đích
// Body: { sourceBranchId, targetBranchIds, deleteOldFirst: false }
// ═══════════════════════════════════════════════════════════════════════
router.post('/catalog/sync-to-branches', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Admin được đồng bộ' });
    }

    const { sourceBranchId, targetBranchIds = [], deleteOldFirst = false } = req.body;

    if (!mongoose.isValidObjectId(sourceBranchId)) {
      return res.status(400).json({ message: 'sourceBranchId không hợp lệ' });
    }
    if (!Array.isArray(targetBranchIds) || targetBranchIds.length === 0) {
      return res.status(400).json({ message: 'Phải chọn ít nhất 1 branch đích' });
    }

    const sourcePenalties = await Penalty.find({
      branchId: sourceBranchId,
      isActive: { $ne: false },
    }).lean();
    if (sourcePenalties.length === 0) {
      return res.status(400).json({ message: 'Branch nguồn chưa có loại phạt nào' });
    }

    const validTargets = targetBranchIds.filter((b) =>
      mongoose.isValidObjectId(b) && String(b) !== String(sourceBranchId)
    );

    const summary = {
      sourceBranchId,
      sourceCount: sourcePenalties.length,
      branches: [],
    };

    for (const targetBranchId of validTargets) {
      const branchResult = {
        branchId: targetBranchId,
        deleted: 0,
        created: 0,
        skipped: 0,
      };

      try {
        if (deleteOldFirst) {
          // Soft delete (giữ history) thay vì hard delete
          const delResult = await Penalty.updateMany(
            { branchId: targetBranchId, isActive: { $ne: false } },
            { $set: { isActive: false, updatedBy: req.user.id } }
          );
          branchResult.deleted = delResult.modifiedCount || 0;
        }

        for (const source of sourcePenalties) {
          if (!deleteOldFirst) {
            const existing = await Penalty.findOne({
              branchId: targetBranchId,
              name: source.name,
              isActive: { $ne: false },
            }).lean();
            if (existing) {
              branchResult.skipped += 1;
              continue;
            }
          }

          const { _id, createdAt, updatedAt, __v, ...cloneData } = source;
          await Penalty.create({
            ...cloneData,
            branchId: targetBranchId,
            createdBy: req.user.id,
          });
          branchResult.created += 1;
        }
      } catch (err) {
        branchResult.error = err.message;
      }

      summary.branches.push(branchResult);
    }

    const totalCreated = summary.branches.reduce((s, b) => s + b.created, 0);
    const totalDeleted = summary.branches.reduce((s, b) => s + b.deleted, 0);

    res.json({
      success: true,
      summary,
      message: `Đồng bộ xong: tạo ${totalCreated} record${
        deleteOldFirst ? `, xóa ${totalDeleted} record cũ` : ''
      } trên ${validTargets.length} branch`,
    });
  } catch (err) {
    console.error('[POST /penalty/catalog/sync]', err);
    res.status(500).json({ message: err.message || 'Lỗi server' });
  }
});

// Tính số tiền phạt theo type
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
// GET /api/penalty/catalog
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
// POST /api/penalty/catalog
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
// PUT /api/penalty/catalog/:id
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
      'name', 'description', 'type', 'fixedAmount',
      'timeWindowTiers', 'repeatCountTiers',
      'severity', 'autoApplyOnLate', 'isActive',
    ];
    const update = {};
    for (const f of allowedFields) {
      if (req.body[f] !== undefined) update[f] = req.body[f];
    }

    if (update.type && !VALID_TYPES.includes(update.type)) {
      return res.status(400).json({ message: 'Type không hợp lệ' });
    }
    if (update.severity && !VALID_SEVERITIES.includes(update.severity)) {
      return res.status(400).json({ message: 'Severity không hợp lệ' });
    }

    if (update.timeWindowTiers && Array.isArray(update.timeWindowTiers)) {
      update.timeWindowTiers = update.timeWindowTiers
        .filter((t) => typeof t.upToMinutes === 'number' && typeof t.amount === 'number' && t.upToMinutes > 0 && t.amount >= 0)
        .map((t) => ({ upToMinutes: Number(t.upToMinutes), amount: Number(t.amount) }))
        .sort((a, b) => a.upToMinutes - b.upToMinutes);
    }

    if (update.repeatCountTiers && Array.isArray(update.repeatCountTiers)) {
      update.repeatCountTiers = update.repeatCountTiers
        .filter((t) => typeof t.occurrence === 'number' && typeof t.amount === 'number' && t.occurrence >= 1 && t.amount >= 0)
        .map((t) => ({ occurrence: Number(t.occurrence), amount: Number(t.amount) }))
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
// DELETE /api/penalty/catalog/:id
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
// GET /api/penalty/records/:userId/count?penaltyId=...&year=&month=
// Đếm số lần đã vi phạm 1 loại phạt cụ thể trong tháng
// ═════════════════════════════════════════════════════════════════════════
router.get('/records/:userId/count', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    const { penaltyId } = req.query;

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }
    if (!mongoose.isValidObjectId(penaltyId)) {
      return res.status(400).json({ message: 'penaltyId không hợp lệ' });
    }
    if (!(await canViewForUser(req, userId))) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || new Date().getMonth() + 1;

    const count = await PenaltyRecord.countDocuments({
      user: userId,
      year,
      month,
      penaltyId,
    });

    const penalty = await Penalty.findById(penaltyId).lean();
    const nextOccurrence = count + 1;
    const { amount: nextAmount, appliedTier } = computePenaltyAmount(penalty, {
      occurrence: nextOccurrence,
    });

    res.json({
      count,
      nextOccurrence,
      nextAmount,
      appliedTier,
    });
  } catch (err) {
    console.error('[GET /penalty/records/count]', err);
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
      occurredOn,
      reason = '',
      note = '',
      manualAmount,
      shiftId,
      occurredAt,
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

    let calcMinutes = Number(minutes) || 0;
    let calcOccurrence = 0;
    let amount = 0;
    let appliedTier = null;

    if (penalty.type === 'fixed') {
      amount = Number(penalty.fixedAmount) || 0;
    } else if (penalty.type === 'time_window') {
      if (typeof manualAmount === 'number' && manualAmount >= 0) {
        amount = manualAmount;
        appliedTier = null;
      } else {
        if (shiftId && occurredAt && mongoose.isValidObjectId(shiftId)) {
          const WorkShift = require('../models/WorkShift');
          const { calculateLateMinutes } = require('../utils/geoHelpers');
          const shift = await WorkShift.findById(shiftId).lean();
          if (shift) {
            calcMinutes = calculateLateMinutes(
              new Date(occurredAt),
              shift.startTime,
              shift.crossesMidnight,
              shift.graceMinutes || 0
            );
          }
        }
        if (!calcMinutes || calcMinutes <= 0) {
          return res.status(400).json({
            message: 'Vui lòng nhập số phút trễ HOẶC chọn ca + thời điểm vi phạm HOẶC nhập số tiền thủ công',
          });
        }
        const calc = computePenaltyAmount(penalty, { minutes: calcMinutes });
        amount = calc.amount;
        appliedTier = calc.appliedTier;
      }
    } else if (penalty.type === 'repeat_count') {
      const existingCount = await PenaltyRecord.countDocuments({
        user: userId,
        year,
        month,
        penaltyId,
      });
      calcOccurrence = existingCount + 1;
      const calc = computePenaltyAmount(penalty, { occurrence: calcOccurrence });
      amount = calc.amount;
      appliedTier = calc.appliedTier;
    }

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
      minutes: penalty.type === 'time_window' ? calcMinutes : 0,
      occurrence: penalty.type === 'repeat_count' ? calcOccurrence : 0,
      appliedTier,
      amount,
      occurredOn: occurredAt
        ? new Date(occurredAt)
        : occurredOn
        ? new Date(occurredOn)
        : null,
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
// PUT /api/penalty/records/:id
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

    const { minutes, occurrence, occurredOn, reason, note, manualAmount } = req.body;

    const penalty = await Penalty.findById(existing.penaltyId).lean();
    let amount = existing.amount;
    let appliedTier = existing.appliedTier;

    if (penalty) {
      if (typeof manualAmount === 'number' && manualAmount >= 0 && penalty.type === 'time_window') {
        amount = manualAmount;
        appliedTier = null;
      } else {
        const calc = computePenaltyAmount(penalty, {
          minutes: minutes ?? existing.minutes,
          occurrence: occurrence ?? existing.occurrence,
        });
        amount = calc.amount;
        appliedTier = calc.appliedTier;
      }
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