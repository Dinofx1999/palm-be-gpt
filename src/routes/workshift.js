// backend/src/routes/workshift.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const WorkShift = require('../models/WorkShift');
// ⭐ FIX: thiếu import Penalty → crash khi gọi findMatchingPenalty
const { Penalty } = require('../models/Penalty');
const { authenticate } = require('../middleware/auth');

const isAdmin = (req) => req.user?.role === 'Admin';
const isManager = (req) => req.user?.role === 'Manager';
const canEdit = (req) => isAdmin(req) || isManager(req);

// Helper: tìm penalty cùng tên ở branch đích
async function findMatchingPenalty(sourcePenaltyId, targetBranchId) {
  if (!sourcePenaltyId || !mongoose.isValidObjectId(sourcePenaltyId)) return null;
  const sourcePenalty = await Penalty.findById(sourcePenaltyId).lean();
  if (!sourcePenalty) return null;
  const target = await Penalty.findOne({
    branchId: targetBranchId,
    name: sourcePenalty.name,
    isActive: { $ne: false },
  }).lean();
  return target ? target._id : null;
}

// ═══════════════════════════════════════════════════════════════════════
// ⭐ POST /api/workshift/:id/copy-to-branches
// Copy 1 ca làm sang nhiều branch đích
// Body: { targetBranchIds, skipIfNameExists }
// ═══════════════════════════════════════════════════════════════════════
router.post('/:id/copy-to-branches', authenticate, async (req, res) => {
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

    const source = await WorkShift.findById(id).lean();
    if (!source) return res.status(404).json({ message: 'Không tìm thấy ca' });

    const validBranchIds = targetBranchIds.filter((b) =>
      mongoose.isValidObjectId(b) && String(b) !== String(source.branchId)
    );

    if (validBranchIds.length === 0) {
      return res.status(400).json({
        message: 'Không có branch đích hợp lệ',
      });
    }

    const results = {
      created: [],
      skipped: [],
      penaltyMissing: [],
    };

    for (const targetBranchId of validBranchIds) {
      try {
        if (skipIfNameExists) {
          const existing = await WorkShift.findOne({
            branchId: targetBranchId,
            name: source.name,
            isActive: { $ne: false },
          }).lean();
          if (existing) {
            results.skipped.push({
              branchId: targetBranchId,
              reason: `Đã có ca "${source.name}"`,
            });
            continue;
          }
        }

        // Map latePenaltyId sang branch đích
        let mappedPenaltyId = null;
        if (source.latePenaltyId) {
          mappedPenaltyId = await findMatchingPenalty(source.latePenaltyId, targetBranchId);
          if (!mappedPenaltyId) {
            results.penaltyMissing.push({
              branchId: targetBranchId,
              shiftName: source.name,
            });
          }
        }

        const { _id, createdAt, updatedAt, __v, ...cloneData } = source;
        const newShift = await WorkShift.create({
          ...cloneData,
          branchId: targetBranchId,
          latePenaltyId: mappedPenaltyId,
          createdBy: req.user.id,
        });

        results.created.push({
          branchId: targetBranchId,
          newId: newShift._id,
        });
      } catch (err) {
        results.skipped.push({
          branchId: targetBranchId,
          reason: err.message,
        });
      }
    }

    let warningMsg = '';
    if (results.penaltyMissing.length > 0) {
      warningMsg = ` ⚠️ ${results.penaltyMissing.length} branch không có loại phạt cùng tên (đã set null).`;
    }

    res.json({
      success: true,
      sourceName: source.name,
      results,
      message: `Đã copy ca "${source.name}" sang ${results.created.length}/${validBranchIds.length} branch.${warningMsg}`,
    });
  } catch (err) {
    console.error('[POST /workshift/copy]', err);
    res.status(500).json({ message: err.message || 'Lỗi server' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ⭐ POST /api/workshift/sync-to-branches
// Đồng bộ TOÀN BỘ ca làm từ branch nguồn → các branch đích
// ═══════════════════════════════════════════════════════════════════════
router.post('/sync-to-branches', authenticate, async (req, res) => {
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

    const sourceShifts = await WorkShift.find({
      branchId: sourceBranchId,
      isActive: { $ne: false },
    }).lean();
    if (sourceShifts.length === 0) {
      return res.status(400).json({ message: 'Branch nguồn chưa có ca làm nào' });
    }

    const validTargets = targetBranchIds.filter((b) =>
      mongoose.isValidObjectId(b) && String(b) !== String(sourceBranchId)
    );

    const summary = {
      sourceBranchId,
      sourceCount: sourceShifts.length,
      branches: [],
    };

    for (const targetBranchId of validTargets) {
      const branchResult = {
        branchId: targetBranchId,
        deleted: 0,
        created: 0,
        skipped: 0,
        penaltyMissing: 0,
      };

      try {
        if (deleteOldFirst) {
          // Soft delete (set isActive: false) thay vì hard delete để giữ history
          const delResult = await WorkShift.updateMany(
            { branchId: targetBranchId, isActive: { $ne: false } },
            { $set: { isActive: false, updatedBy: req.user.id } }
          );
          branchResult.deleted = delResult.modifiedCount || 0;
        }

        for (const source of sourceShifts) {
          if (!deleteOldFirst) {
            const existing = await WorkShift.findOne({
              branchId: targetBranchId,
              name: source.name,
              isActive: { $ne: false },
            }).lean();
            if (existing) {
              branchResult.skipped += 1;
              continue;
            }
          }

          let mappedPenaltyId = null;
          if (source.latePenaltyId) {
            mappedPenaltyId = await findMatchingPenalty(source.latePenaltyId, targetBranchId);
            if (!mappedPenaltyId) branchResult.penaltyMissing += 1;
          }

          const { _id, createdAt, updatedAt, __v, ...cloneData } = source;
          await WorkShift.create({
            ...cloneData,
            branchId: targetBranchId,
            latePenaltyId: mappedPenaltyId,
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
    const totalPenaltyMissing = summary.branches.reduce((s, b) => s + b.penaltyMissing, 0);

    let warningMsg = '';
    if (totalPenaltyMissing > 0) {
      warningMsg = ` ⚠️ ${totalPenaltyMissing} ca thiếu loại phạt tương ứng. Khuyên đồng bộ "Cấu hình Phạt" trước rồi đồng bộ ca.`;
    }

    res.json({
      success: true,
      summary,
      message: `Đồng bộ xong: tạo ${totalCreated} ca${
        deleteOldFirst ? `, xóa ${totalDeleted} ca cũ` : ''
      } trên ${validTargets.length} branch.${warningMsg}`,
    });
  } catch (err) {
    console.error('[POST /workshift/sync]', err);
    res.status(500).json({ message: err.message || 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/workshift?branchId=...
// Liệt kê các ca làm của branch
// ═════════════════════════════════════════════════════════════════════════
router.get('/', authenticate, async (req, res) => {
  try {
    let branchId = req.query.branchId;
    if (isManager(req) || (!isAdmin(req) && !branchId)) {
      branchId = String(req.user.branchId);
    }
    if (!branchId || !mongoose.isValidObjectId(branchId)) {
      return res.status(400).json({ message: 'Thiếu branchId' });
    }

    const list = await WorkShift.find({ branchId, isActive: true })
      .sort({ sortOrder: 1, startTime: 1 })
      .populate('latePenaltyId', 'name type')
      .lean();

    res.json(list);
  } catch (err) {
    console.error('[GET /workshift]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/workshift — tạo ca mới (Admin/Manager)
// ═════════════════════════════════════════════════════════════════════════
router.post('/', authenticate, async (req, res) => {
  try {
    if (!canEdit(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    const {
      branchId,
      name,
      startTime,
      endTime,
      crossesMidnight = false,
      latePenaltyId = null,
      graceMinutes = 0,
      sortOrder = 0,
    } = req.body;

    if (!mongoose.isValidObjectId(branchId)) {
      return res.status(400).json({ message: 'branchId không hợp lệ' });
    }
    if (!name || !startTime || !endTime) {
      return res.status(400).json({ message: 'Thiếu thông tin' });
    }

    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      return res.status(400).json({ message: 'Giờ phải đúng định dạng HH:mm' });
    }

    if (isManager(req) && String(req.user.branchId) !== String(branchId)) {
      return res.status(403).json({ message: 'Manager chỉ tạo ca cho branch mình' });
    }

    const doc = await WorkShift.create({
      branchId,
      name: name.trim(),
      startTime,
      endTime,
      crossesMidnight,
      latePenaltyId: latePenaltyId && mongoose.isValidObjectId(latePenaltyId)
        ? latePenaltyId : null,
      graceMinutes: Number(graceMinutes) || 0,
      sortOrder: Number(sortOrder) || 0,
      createdBy: req.user.id,
    });

    res.json(doc);
  } catch (err) {
    console.error('[POST /workshift]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PUT /api/workshift/:id
// ═════════════════════════════════════════════════════════════════════════
router.put('/:id', authenticate, async (req, res) => {
  try {
    if (!canEdit(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }

    const allowed = [
      'name', 'startTime', 'endTime', 'crossesMidnight',
      'latePenaltyId', 'graceMinutes', 'sortOrder', 'isActive',
    ];
    const update = {};
    for (const f of allowed) {
      if (req.body[f] !== undefined) update[f] = req.body[f];
    }
    if (update.latePenaltyId === '') update.latePenaltyId = null;
    update.updatedBy = req.user.id;

    const doc = await WorkShift.findByIdAndUpdate(id, { $set: update }, { new: true });
    if (!doc) return res.status(404).json({ message: 'Không tìm thấy' });

    res.json(doc);
  } catch (err) {
    console.error('[PUT /workshift]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// DELETE /api/workshift/:id — soft delete
// ═════════════════════════════════════════════════════════════════════════
router.delete('/:id', authenticate, async (req, res) => {
  try {
    if (!canEdit(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }
    await WorkShift.findByIdAndUpdate(id, {
      $set: { isActive: false, updatedBy: req.user.id },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /workshift]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

module.exports = router;