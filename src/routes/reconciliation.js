// backend/src/routes/reconciliation.js
//
// ⭐ NEW 14/05/2026: APIs Đối soát thu chi (Reconciliation)
//
// Endpoints:
//   GET    /reconciliations                — List (filter branch, period, status, date)
//   GET    /reconciliations/:id            — Chi tiết
//   POST   /reconciliations                — Tạo mới (auto-fetch system data theo kỳ)
//   PUT    /reconciliations/:id            — Update actual amounts + explanations
//   POST   /reconciliations/:id/refresh    — Refetch system data (nếu có transaction mới)
//   POST   /reconciliations/:id/submit     — Submit để chờ duyệt
//   POST   /reconciliations/:id/approve    — Admin duyệt (status='approved')
//   POST   /reconciliations/:id/reject     — Admin từ chối (status='disputed')
//   DELETE /reconciliations/:id            — Xoá (chỉ draft)
//
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const Reconciliation = require('../models/Reconciliation');
const { authenticate } = require('../middleware/auth');

// ─── Permission helpers ─────────────────────────────────────────────
//   - Tạo + sửa: Admin/Manager
//   - Duyệt + từ chối: chỉ Admin
//   - Xem: Admin (mọi), Manager (branch), Recep/Staff (branch nhưng read-only)
const canCreate  = (user) => ['Admin', 'Manager'].includes(user.role);
const canApprove = (user) => user.role === 'Admin';
const canView    = (user) => !!user;

function applyScopeFilter(filter, user) {
  if (user.role === 'Admin') return filter;
  filter.branchId = user.branchId;
  return filter;
}

// ═════════════════════════════════════════════════════════════════════════
// GET /api/reconciliations — List
// ═════════════════════════════════════════════════════════════════════════
router.get('/', authenticate, async (req, res) => {
  try {
    const filter = {};
    applyScopeFilter(filter, req.user);

    if (req.query.branchId && req.user.role === 'Admin' && mongoose.isValidObjectId(req.query.branchId)) {
      filter.branchId = req.query.branchId;
    }
    if (req.query.status) filter.status = req.query.status;
    if (req.query.period) filter.period = req.query.period;

    if (req.query.fromDate || req.query.toDate) {
      filter.fromDate = {};
      if (req.query.fromDate) filter.fromDate.$gte = new Date(req.query.fromDate);
      if (req.query.toDate)   filter.fromDate.$lte = new Date(req.query.toDate);
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const [data, total] = await Promise.all([
      Reconciliation.find(filter)
        .populate('branchId', 'name')
        .populate('createdBy', 'fullName username')
        .populate('submittedBy', 'fullName username')
        .populate('approvedBy', 'fullName username')
        .sort({ fromDate: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Reconciliation.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { data, total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[GET /reconciliations]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/reconciliations/:id — Chi tiết
// ═════════════════════════════════════════════════════════════════════════
router.get('/:id', authenticate, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const rec = await Reconciliation.findById(req.params.id)
      .populate('branchId', 'name')
      .populate('createdBy', 'fullName username')
      .populate('submittedBy', 'fullName username')
      .populate('approvedBy', 'fullName username')
      .populate({
        path: 'shiftIds',
        select: 'shiftCode user openedAt closedAt cashDifference bankDifference status',
        populate: { path: 'user', select: 'fullName username' },
      })
      .lean();

    if (!rec) return res.status(404).json({ success: false, message: 'Không tìm thấy' });

    // Scope check
    if (req.user.role !== 'Admin' && String(rec.branchId?._id) !== String(req.user.branchId)) {
      return res.status(403).json({ success: false, message: 'Không có quyền xem đối soát của chi nhánh khác' });
    }

    res.json({ success: true, data: { reconciliation: rec } });
  } catch (err) {
    console.error('[GET /reconciliations/:id]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/reconciliations — Tạo mới
// Body: { branchId?, period, fromDate, toDate, label?, notes? }
//   - Auto-fetch system data từ Transaction collection
//   - Auto-link shifts đã closed trong kỳ
// ═════════════════════════════════════════════════════════════════════════
router.post('/', authenticate, async (req, res) => {
  try {
    if (!canCreate(req.user)) {
      return res.status(403).json({ success: false, message: 'Chỉ Admin/Manager mới được tạo đối soát' });
    }

    const { branchId, period = 'daily', fromDate, toDate, label, notes = '' } = req.body;

    if (!fromDate || !toDate) {
      return res.status(400).json({ success: false, message: 'Thiếu khoảng thời gian (fromDate, toDate)' });
    }

    let bId = branchId;
    if (req.user.role === 'Manager') {
      bId = req.user.branchId;
    }
    if (!bId || !mongoose.isValidObjectId(bId)) {
      return res.status(400).json({ success: false, message: 'Thiếu chi nhánh' });
    }

    const fromD = new Date(fromDate);
    const toD = new Date(toDate);
    if (fromD > toD) {
      return res.status(400).json({ success: false, message: 'fromDate phải <= toDate' });
    }

    // Check trùng kỳ
    const existed = await Reconciliation.findOne({
      branchId: bId,
      period,
      fromDate: { $gte: new Date(fromD.setHours(0, 0, 0, 0)), $lte: new Date(fromD.setHours(23, 59, 59, 999)) },
      status: { $in: ['draft', 'submitted', 'approved'] },
    });
    if (existed) {
      return res.status(409).json({
        success: false,
        message: `Đã có đối soát ${period} cho ngày này (${existed.reconciliationCode})`,
        data: { existedId: existed._id },
      });
    }

    // Auto-fetch system data
    const systemData = await Reconciliation.fetchSystemData(bId, fromDate, toDate);
    const shifts = await Reconciliation.fetchShiftsInPeriod(bId, fromDate, toDate);

    const rec = await Reconciliation.create({
      branchId: bId,
      period,
      fromDate: new Date(fromDate),
      toDate: new Date(toDate),
      label: label || '',
      notes,
      // Sub-docs: chỉ điền systemIn/Out, actualIn/Out để trống cho Manager nhập
      cash:     { systemIn: systemData.cash.systemIn,     systemOut: systemData.cash.systemOut },
      transfer: { systemIn: systemData.transfer.systemIn, systemOut: systemData.transfer.systemOut },
      card:     { systemIn: systemData.card.systemIn,     systemOut: systemData.card.systemOut },
      other:    { systemIn: systemData.other.systemIn,    systemOut: systemData.other.systemOut },
      shiftIds: shifts.map(s => s._id),
      status: 'draft',
      createdBy: req.user.id,
    });

    const populated = await Reconciliation.findById(rec._id)
      .populate('branchId', 'name')
      .populate('createdBy', 'fullName username')
      .lean();

    res.status(201).json({
      success: true,
      message: `Đã tạo ${rec.label}`,
      data: { reconciliation: populated, shiftsIncluded: shifts.length },
    });
  } catch (err) {
    console.error('[POST /reconciliations]', err);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Đã tồn tại đối soát cho kỳ này' });
    }
    res.status(500).json({ success: false, message: err.message || 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PUT /api/reconciliations/:id — Update actual amounts + explanations
// Body: { cash: {actualIn, actualOut, note}, transfer: {...}, card: {...}, other: {...},
//         discrepancyExplanations: [...], notes, attachments }
// ═════════════════════════════════════════════════════════════════════════
router.put('/:id', authenticate, async (req, res) => {
  try {
    if (!canCreate(req.user)) {
      return res.status(403).json({ success: false, message: 'Không có quyền sửa' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const rec = await Reconciliation.findById(req.params.id);
    if (!rec) return res.status(404).json({ success: false, message: 'Không tìm thấy' });

    // Scope check
    if (req.user.role === 'Manager' && String(rec.branchId) !== String(req.user.branchId)) {
      return res.status(403).json({ success: false, message: 'Manager chỉ sửa được đối soát của chi nhánh mình' });
    }

    // Chỉ cho sửa khi status = draft hoặc disputed
    if (!['draft', 'disputed'].includes(rec.status)) {
      return res.status(400).json({
        success: false,
        message: `Đối soát đã ${rec.status === 'approved' ? 'duyệt' : 'submit'} — không thể sửa`,
      });
    }

    // Update actual amounts cho từng paymentMethod
    const methods = ['cash', 'transfer', 'card', 'other'];
    for (const m of methods) {
      if (req.body[m] && typeof req.body[m] === 'object') {
        const detail = req.body[m];
        if (detail.actualIn  !== undefined) rec[m].actualIn  = Number(detail.actualIn)  || 0;
        if (detail.actualOut !== undefined) rec[m].actualOut = Number(detail.actualOut) || 0;
        if (detail.note      !== undefined) rec[m].note      = String(detail.note).slice(0, 500);
      }
    }

    // Update các field khác
    if (req.body.notes !== undefined) rec.notes = String(req.body.notes).slice(0, 2000);
    if (Array.isArray(req.body.attachments)) rec.attachments = req.body.attachments;
    if (Array.isArray(req.body.discrepancyExplanations)) {
      rec.discrepancyExplanations = req.body.discrepancyExplanations
        .filter(e => e && e.paymentMethod)
        .map(e => ({
          paymentMethod: e.paymentMethod,
          amount: Number(e.amount) || 0,
          reason: String(e.reason || '').slice(0, 1000),
        }));
    }

    await rec.save();   // Pre-save sẽ auto-tính lại totals + differences

    const populated = await Reconciliation.findById(rec._id)
      .populate('branchId', 'name')
      .populate('createdBy', 'fullName username')
      .lean();

    res.json({
      success: true,
      message: 'Đã cập nhật',
      data: {
        reconciliation: populated,
        hasDiscrepancy: Math.abs(rec.totalDifference) > 0,
        totalDifference: rec.totalDifference,
      },
    });
  } catch (err) {
    console.error('[PUT /reconciliations/:id]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/reconciliations/:id/refresh — Refetch system data
//   Dùng khi: tạo đối soát rồi nhưng sau đó có thêm transaction trong kỳ
//   → Bấm refresh để cập nhật lại số liệu hệ thống
// ═════════════════════════════════════════════════════════════════════════
router.post('/:id/refresh', authenticate, async (req, res) => {
  try {
    if (!canCreate(req.user)) {
      return res.status(403).json({ success: false, message: 'Không có quyền' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const rec = await Reconciliation.findById(req.params.id);
    if (!rec) return res.status(404).json({ success: false, message: 'Không tìm thấy' });
    if (rec.status === 'approved') {
      return res.status(400).json({ success: false, message: 'Đối soát đã duyệt — không thể refresh' });
    }

    const systemData = await Reconciliation.fetchSystemData(rec.branchId, rec.fromDate, rec.toDate);
    const shifts = await Reconciliation.fetchShiftsInPeriod(rec.branchId, rec.fromDate, rec.toDate);

    // Chỉ refresh system data, GIỮ NGUYÊN actual amounts đã nhập
    rec.cash.systemIn      = systemData.cash.systemIn;
    rec.cash.systemOut     = systemData.cash.systemOut;
    rec.transfer.systemIn  = systemData.transfer.systemIn;
    rec.transfer.systemOut = systemData.transfer.systemOut;
    rec.card.systemIn      = systemData.card.systemIn;
    rec.card.systemOut     = systemData.card.systemOut;
    rec.other.systemIn     = systemData.other.systemIn;
    rec.other.systemOut    = systemData.other.systemOut;
    rec.shiftIds           = shifts.map(s => s._id);

    await rec.save();

    res.json({
      success: true,
      message: 'Đã cập nhật số liệu hệ thống',
      data: {
        reconciliation: rec.toObject(),
        shiftsIncluded: shifts.length,
        transactionCount: systemData.transactionCount,
      },
    });
  } catch (err) {
    console.error('[POST /reconciliations/:id/refresh]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/reconciliations/:id/submit — Submit để chờ duyệt
// ═════════════════════════════════════════════════════════════════════════
router.post('/:id/submit', authenticate, async (req, res) => {
  try {
    if (!canCreate(req.user)) {
      return res.status(403).json({ success: false, message: 'Không có quyền' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const rec = await Reconciliation.findById(req.params.id);
    if (!rec) return res.status(404).json({ success: false, message: 'Không tìm thấy' });

    if (rec.status !== 'draft' && rec.status !== 'disputed') {
      return res.status(400).json({ success: false, message: 'Chỉ submit được đối soát ở trạng thái nháp' });
    }

    // Cảnh báo: nếu có chênh lệch mà chưa có giải trình
    if (Math.abs(rec.totalDifference) > 0 && (!rec.discrepancyExplanations || rec.discrepancyExplanations.length === 0)) {
      // Chỉ cảnh báo, vẫn cho submit
      console.warn(`[reconciliation/submit] ${rec.reconciliationCode} có chênh lệch ${rec.totalDifference}đ chưa giải trình`);
    }

    rec.submittedBy = req.user.id;
    rec.submittedAt = new Date();
    rec.status = 'submitted';
    await rec.save();

    res.json({
      success: true,
      message: 'Đã submit, chờ Admin duyệt',
      data: { reconciliation: rec.toObject() },
    });
  } catch (err) {
    console.error('[POST /reconciliations/:id/submit]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/reconciliations/:id/approve — Admin duyệt
// ═════════════════════════════════════════════════════════════════════════
router.post('/:id/approve', authenticate, async (req, res) => {
  try {
    if (!canApprove(req.user)) {
      return res.status(403).json({ success: false, message: 'Chỉ Admin mới duyệt được' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const rec = await Reconciliation.findById(req.params.id);
    if (!rec) return res.status(404).json({ success: false, message: 'Không tìm thấy' });

    if (rec.status !== 'submitted') {
      return res.status(400).json({ success: false, message: 'Chỉ duyệt được đối soát đã submit' });
    }

    rec.approvedBy = req.user.id;
    rec.approvedAt = new Date();
    rec.status = 'approved';
    await rec.save();

    res.json({
      success: true,
      message: 'Đã duyệt đối soát',
      data: { reconciliation: rec.toObject() },
    });
  } catch (err) {
    console.error('[POST /reconciliations/:id/approve]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/reconciliations/:id/reject — Admin từ chối
// Body: { reason }
// ═════════════════════════════════════════════════════════════════════════
router.post('/:id/reject', authenticate, async (req, res) => {
  try {
    if (!canApprove(req.user)) {
      return res.status(403).json({ success: false, message: 'Chỉ Admin mới từ chối được' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const { reason = '' } = req.body;
    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({ success: false, message: 'Vui lòng nhập lý do từ chối (≥5 ký tự)' });
    }

    const rec = await Reconciliation.findById(req.params.id);
    if (!rec) return res.status(404).json({ success: false, message: 'Không tìm thấy' });

    if (rec.status !== 'submitted') {
      return res.status(400).json({ success: false, message: 'Chỉ từ chối được đối soát đã submit' });
    }

    rec.status = 'disputed';
    rec.rejectedReason = reason;
    rec.approvedBy = req.user.id;     // Lưu ai là người reject
    rec.approvedAt = new Date();
    await rec.save();

    res.json({
      success: true,
      message: 'Đã từ chối — chuyển về trạng thái tranh chấp để Manager sửa',
      data: { reconciliation: rec.toObject() },
    });
  } catch (err) {
    console.error('[POST /reconciliations/:id/reject]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// DELETE /api/reconciliations/:id — Xoá (chỉ draft)
// ═════════════════════════════════════════════════════════════════════════
router.delete('/:id', authenticate, async (req, res) => {
  try {
    if (!canCreate(req.user)) {
      return res.status(403).json({ success: false, message: 'Không có quyền' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const rec = await Reconciliation.findById(req.params.id);
    if (!rec) return res.status(404).json({ success: false, message: 'Không tìm thấy' });

    if (rec.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Chỉ xoá được đối soát ở trạng thái nháp' });
    }
    if (req.user.role === 'Manager' && String(rec.branchId) !== String(req.user.branchId)) {
      return res.status(403).json({ success: false, message: 'Manager chỉ xoá được trong branch' });
    }

    await rec.deleteOne();
    res.json({ success: true, message: 'Đã xoá' });
  } catch (err) {
    console.error('[DELETE /reconciliations/:id]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/reconciliations/preview/system-data
// Query: ?branchId=...&fromDate=...&toDate=...
//   Dùng cho FE preview số liệu trước khi tạo đối soát
// ═════════════════════════════════════════════════════════════════════════
router.get('/preview/system-data', authenticate, async (req, res) => {
  try {
    if (!canView(req.user)) {
      return res.status(403).json({ success: false, message: 'Vui lòng đăng nhập' });
    }

    const { fromDate, toDate } = req.query;
    if (!fromDate || !toDate) {
      return res.status(400).json({ success: false, message: 'Thiếu fromDate, toDate' });
    }

    let bId = req.query.branchId;
    if (req.user.role !== 'Admin') bId = req.user.branchId;
    if (!bId) return res.status(400).json({ success: false, message: 'Thiếu branchId' });

    const [systemData, shifts] = await Promise.all([
      Reconciliation.fetchSystemData(bId, fromDate, toDate),
      Reconciliation.fetchShiftsInPeriod(bId, fromDate, toDate),
    ]);

    res.json({
      success: true,
      data: {
        systemData,
        shifts,
        period: { fromDate, toDate },
      },
    });
  } catch (err) {
    console.error('[GET /reconciliations/preview/system-data]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

module.exports = router;