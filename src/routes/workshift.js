// backend/src/routes/workshift.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const WorkShift = require('../models/WorkShift');
const { authenticate } = require('../middleware/auth');

const isAdmin = (req) => req.user?.role === 'Admin';
const isManager = (req) => req.user?.role === 'Manager';
const canEdit = (req) => isAdmin(req) || isManager(req);

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

    // Validate HH:mm
    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      return res.status(400).json({ message: 'Giờ phải đúng định dạng HH:mm' });
    }

    // Manager chỉ được tạo ca cho branch mình
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
    await WorkShift.findByIdAndUpdate(id, { $set: { isActive: false, updatedBy: req.user.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /workshift]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

module.exports = router;