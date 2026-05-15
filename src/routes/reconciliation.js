// backend/src/routes/reconciliation.js
//
// ⭐ NEW 14/05/2026: APIs Đối soát thu chi
// Pattern: handler dùng (req, res, next), lỗi → next(err)
//
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const Reconciliation = require('../models/Reconciliation');
const { authenticate } = require('../middleware/auth');

const canCreate  = (user) => ['Admin', 'Manager'].includes(user.role);
const canApprove = (user) => user.role === 'Admin';
const canView    = (user) => !!user;

const resolveUserId = (user) => user?.id || user?._id || user?.userId;
const resolveBranchId = (val) => {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return val._id || val.id;
  return null;
};

function applyScopeFilter(filter, user) {
  if (user.role === 'Admin') return filter;
  filter.branchId = resolveBranchId(user.branchId);
  return filter;
}

// ─────────── HANDLERS ───────────

const list = async (req, res, next) => {
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
    res.status(500).json({ success: false, message: err.message });
  }
};

const previewSystem = async (req, res, next) => {
  try {
    if (!canView(req.user)) {
      return res.status(403).json({ success: false, message: 'Vui lòng đăng nhập' });
    }
    const { fromDate, toDate } = req.query;
    if (!fromDate || !toDate) {
      return res.status(400).json({ success: false, message: 'Thiếu fromDate, toDate' });
    }
    let bId = req.query.branchId;
    if (req.user.role !== 'Admin') bId = resolveBranchId(req.user.branchId);
    if (!bId) return res.status(400).json({ success: false, message: 'Thiếu branchId' });

    const [systemData, shifts] = await Promise.all([
      Reconciliation.fetchSystemData(bId, fromDate, toDate),
      Reconciliation.fetchShiftsInPeriod(bId, fromDate, toDate),
    ]);

    res.json({
      success: true,
      data: { systemData, shifts, period: { fromDate, toDate } },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getOne = async (req, res, next) => {
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

    const userBranchId = resolveBranchId(req.user.branchId);
    if (req.user.role !== 'Admin' && String(rec.branchId?._id) !== String(userBranchId)) {
      return res.status(403).json({ success: false, message: 'Không có quyền xem đối soát của chi nhánh khác' });
    }

    res.json({ success: true, data: { reconciliation: rec } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const create = async (req, res, next) => {
  try {
    if (!canCreate(req.user)) {
      return res.status(403).json({ success: false, message: 'Chỉ Admin/Manager mới được tạo đối soát' });
    }

    const { branchId, period = 'daily', fromDate, toDate, label, notes = '' } = req.body;

    if (!fromDate || !toDate) {
      return res.status(400).json({ success: false, message: 'Thiếu khoảng thời gian (fromDate, toDate)' });
    }

    let bId = branchId;
    if (req.user.role === 'Manager') bId = resolveBranchId(req.user.branchId);
    // ⭐ Admin: nếu không gửi branchId → fallback dùng branch của user
    //   (Admin có branchId mặc định trong profile)
    if (req.user.role === 'Admin' && !bId) bId = resolveBranchId(req.user.branchId);
    if (!bId || !mongoose.isValidObjectId(bId)) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu chi nhánh — vui lòng chọn chi nhánh hoặc đảm bảo tài khoản có branchId',
      });
    }

    const fromD = new Date(fromDate);
    const toD = new Date(toDate);
    if (fromD > toD) {
      return res.status(400).json({ success: false, message: 'fromDate phải <= toDate' });
    }

    // Check trùng kỳ
    const fromDayStart = new Date(fromD); fromDayStart.setHours(0, 0, 0, 0);
    const fromDayEnd   = new Date(fromD); fromDayEnd.setHours(23, 59, 59, 999);
    const existed = await Reconciliation.findOne({
      branchId: bId,
      period,
      fromDate: { $gte: fromDayStart, $lte: fromDayEnd },
      status: { $in: ['draft', 'submitted', 'approved'] },
    });
    if (existed) {
      return res.status(409).json({
        success: false,
        message: `Đã có đối soát ${period} cho ngày này (${existed.reconciliationCode})`,
        data: { existedId: existed._id },
      });
    }

    const systemData = await Reconciliation.fetchSystemData(bId, fromDate, toDate);
    const shifts = await Reconciliation.fetchShiftsInPeriod(bId, fromDate, toDate);

    // Generate code manually
    const d = new Date(fromDate);
    const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
    const reconciliationCode = `REC_${dateStr}_${rand}`;

    // Build label
    let autoLabel = label;
    if (!autoLabel) {
      const fromStr = new Date(fromDate).toLocaleDateString('vi-VN');
      const toStr = new Date(toDate).toLocaleDateString('vi-VN');
      if (period === 'daily') autoLabel = `Đối soát ngày ${fromStr}`;
      else if (period === 'weekly') autoLabel = `Đối soát tuần ${fromStr} - ${toStr}`;
      else if (period === 'monthly') autoLabel = `Đối soát tháng ${new Date(fromDate).getMonth() + 1}/${new Date(fromDate).getFullYear()}`;
      else autoLabel = `Đối soát ${fromStr} - ${toStr}`;
    }

    const userId = resolveUserId(req.user);

    // ⭐ WORKAROUND 15/05: Manually compute totals (bypass pre-save hook bị bug)
    //   Nếu pre-save hook có issue → Reconciliation.create lỗi
    //   Giải pháp: tự tính + insertOne raw để skip hook
    const computeDetail = (sysIn, sysOut, actIn = 0, actOut = 0) => {
      const systemNet = (sysIn || 0) - (sysOut || 0);
      const actualNet = (actIn || 0) - (actOut || 0);
      return {
        systemIn: sysIn || 0,
        systemOut: sysOut || 0,
        systemNet,
        actualIn: actIn,
        actualOut: actOut,
        actualNet,
        difference: actualNet - systemNet,
        note: '',
      };
    };

    const cashDetail     = computeDetail(systemData.cash.systemIn, systemData.cash.systemOut);
    const transferDetail = computeDetail(systemData.transfer.systemIn, systemData.transfer.systemOut);
    const cardDetail     = computeDetail(systemData.card.systemIn, systemData.card.systemOut);
    const otherDetail    = computeDetail(systemData.other.systemIn, systemData.other.systemOut);

    const totalSystemIn  = cashDetail.systemIn + transferDetail.systemIn + cardDetail.systemIn + otherDetail.systemIn;
    const totalSystemOut = cashDetail.systemOut + transferDetail.systemOut + cardDetail.systemOut + otherDetail.systemOut;
    const totalDifference = cashDetail.difference + transferDetail.difference + cardDetail.difference + otherDetail.difference;

    const doc = {
      reconciliationCode,
      label: autoLabel,
      branchId: new mongoose.Types.ObjectId(bId),
      period,
      fromDate: new Date(fromDate),
      toDate: new Date(toDate),
      notes,
      cash: cashDetail,
      transfer: transferDetail,
      card: cardDetail,
      other: otherDetail,
      shiftIds: shifts.map(s => s._id),
      shiftCount: shifts.length,
      totalSystemIn,
      totalSystemOut,
      totalActualIn: 0,
      totalActualOut: 0,
      totalDifference,
      status: 'draft',
      createdBy: new mongoose.Types.ObjectId(userId),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const insertResult = await Reconciliation.collection.insertOne(doc);
    const rec = { _id: insertResult.insertedId, ...doc };

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
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Đã tồn tại đối soát cho kỳ này' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

const update = async (req, res, next) => {
  try {
    if (!canCreate(req.user)) {
      return res.status(403).json({ success: false, message: 'Không có quyền sửa' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const rec = await Reconciliation.findById(req.params.id);
    if (!rec) return res.status(404).json({ success: false, message: 'Không tìm thấy' });

    const userBranchId = resolveBranchId(req.user.branchId);
    if (req.user.role === 'Manager' && String(rec.branchId) !== String(userBranchId)) {
      return res.status(403).json({ success: false, message: 'Manager chỉ sửa được đối soát của chi nhánh mình' });
    }

    if (!['draft', 'disputed'].includes(rec.status)) {
      return res.status(400).json({
        success: false,
        message: `Đối soát đã ${rec.status === 'approved' ? 'duyệt' : 'submit'} — không thể sửa`,
      });
    }

    const methods = ['cash', 'transfer', 'card', 'other'];
    for (const m of methods) {
      if (req.body[m] && typeof req.body[m] === 'object') {
        const detail = req.body[m];
        if (detail.actualIn  !== undefined) rec[m].actualIn  = Number(detail.actualIn)  || 0;
        if (detail.actualOut !== undefined) rec[m].actualOut = Number(detail.actualOut) || 0;
        if (detail.note      !== undefined) rec[m].note      = String(detail.note).slice(0, 500);
      }
    }

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

    // ⭐ WORKAROUND 15/05: Manually compute totals + updateOne raw (bypass pre-save hook)
    let totalSystemIn = 0, totalSystemOut = 0;
    let totalActualIn = 0, totalActualOut = 0, totalDifference = 0;
    for (const m of methods) {
      const d = rec[m] || {};
      const sysIn = d.systemIn || 0, sysOut = d.systemOut || 0;
      const actIn = d.actualIn || 0, actOut = d.actualOut || 0;
      const systemNet = sysIn - sysOut;
      const actualNet = actIn - actOut;
      d.systemNet = systemNet;
      d.actualNet = actualNet;
      d.difference = actualNet - systemNet;
      totalSystemIn  += sysIn;
      totalSystemOut += sysOut;
      totalActualIn  += actIn;
      totalActualOut += actOut;
      totalDifference += d.difference;
    }
    rec.totalSystemIn = totalSystemIn;
    rec.totalSystemOut = totalSystemOut;
    rec.totalActualIn = totalActualIn;
    rec.totalActualOut = totalActualOut;
    rec.totalDifference = totalDifference;

    // Update bằng raw collection — bypass hook
    await Reconciliation.collection.updateOne(
      { _id: rec._id },
      {
        $set: {
          cash: rec.cash,
          transfer: rec.transfer,
          card: rec.card,
          other: rec.other,
          notes: rec.notes,
          attachments: rec.attachments,
          discrepancyExplanations: rec.discrepancyExplanations,
          totalSystemIn,
          totalSystemOut,
          totalActualIn,
          totalActualOut,
          totalDifference,
          updatedAt: new Date(),
        },
      }
    );

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
    res.status(500).json({ success: false, message: err.message });
  }
};

const refresh = async (req, res, next) => {
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

    rec.cash.systemIn      = systemData.cash.systemIn;
    rec.cash.systemOut     = systemData.cash.systemOut;
    rec.transfer.systemIn  = systemData.transfer.systemIn;
    rec.transfer.systemOut = systemData.transfer.systemOut;
    rec.card.systemIn      = systemData.card.systemIn;
    rec.card.systemOut     = systemData.card.systemOut;
    rec.other.systemIn     = systemData.other.systemIn;
    rec.other.systemOut    = systemData.other.systemOut;
    rec.shiftIds           = shifts.map(s => s._id);

    // ⭐ WORKAROUND 15/05: Compute totals + updateOne raw (bypass hook)
    const ms = ['cash', 'transfer', 'card', 'other'];
    let tSysIn = 0, tSysOut = 0, tActIn = 0, tActOut = 0, tDiff = 0;
    for (const m of ms) {
      const d = rec[m];
      const sysIn = d.systemIn || 0, sysOut = d.systemOut || 0;
      const actIn = d.actualIn || 0, actOut = d.actualOut || 0;
      d.systemNet = sysIn - sysOut;
      d.actualNet = actIn - actOut;
      d.difference = d.actualNet - d.systemNet;
      tSysIn += sysIn; tSysOut += sysOut;
      tActIn += actIn; tActOut += actOut;
      tDiff += d.difference;
    }
    rec.totalSystemIn = tSysIn;
    rec.totalSystemOut = tSysOut;
    rec.totalActualIn = tActIn;
    rec.totalActualOut = tActOut;
    rec.totalDifference = tDiff;
    rec.shiftCount = shifts.length;

    await Reconciliation.collection.updateOne(
      { _id: rec._id },
      {
        $set: {
          cash: rec.cash,
          transfer: rec.transfer,
          card: rec.card,
          other: rec.other,
          shiftIds: rec.shiftIds,
          shiftCount: shifts.length,
          totalSystemIn: tSysIn,
          totalSystemOut: tSysOut,
          totalActualIn: tActIn,
          totalActualOut: tActOut,
          totalDifference: tDiff,
          updatedAt: new Date(),
        },
      }
    );

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
    res.status(500).json({ success: false, message: err.message });
  }
};

const submit = async (req, res, next) => {
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

    const userId = resolveUserId(req.user);
    rec.submittedBy = userId;
    rec.submittedAt = new Date();
    rec.status = 'submitted';
    await Reconciliation.collection.updateOne(
      { _id: rec._id },
      { $set: { submittedBy: new mongoose.Types.ObjectId(userId), submittedAt: rec.submittedAt, status: 'submitted', updatedAt: new Date() } }
    );

    res.json({
      success: true,
      message: 'Đã submit, chờ Admin duyệt',
      data: { reconciliation: rec.toObject() },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const approve = async (req, res, next) => {
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

    const userId = resolveUserId(req.user);
    rec.approvedBy = userId;
    rec.approvedAt = new Date();
    rec.status = 'approved';
    await Reconciliation.collection.updateOne(
      { _id: rec._id },
      { $set: { approvedBy: new mongoose.Types.ObjectId(userId), approvedAt: rec.approvedAt, status: 'approved', updatedAt: new Date() } }
    );

    res.json({
      success: true,
      message: 'Đã duyệt đối soát',
      data: { reconciliation: rec.toObject() },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const reject = async (req, res, next) => {
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

    const userId = resolveUserId(req.user);
    rec.status = 'disputed';
    rec.rejectedReason = reason;
    rec.approvedBy = userId;
    rec.approvedAt = new Date();
    await Reconciliation.collection.updateOne(
      { _id: rec._id },
      { $set: { status: 'disputed', rejectedReason: reason, approvedBy: new mongoose.Types.ObjectId(userId), approvedAt: rec.approvedAt, updatedAt: new Date() } }
    );

    res.json({
      success: true,
      message: 'Đã từ chối — chuyển về trạng thái tranh chấp để Manager sửa',
      data: { reconciliation: rec.toObject() },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const remove = async (req, res, next) => {
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
    const userBranchId = resolveBranchId(req.user.branchId);
    if (req.user.role === 'Manager' && String(rec.branchId) !== String(userBranchId)) {
      return res.status(403).json({ success: false, message: 'Manager chỉ xoá được trong branch' });
    }

    await rec.deleteOne();
    res.json({ success: true, message: 'Đã xoá' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────── Routes — đặt /preview/system-data TRƯỚC /:id ───────
router.get('/',                       authenticate, list);
router.get('/preview/system-data',    authenticate, previewSystem);
router.get('/:id',                    authenticate, getOne);
router.post('/',                      authenticate, create);
router.put('/:id',                    authenticate, update);
router.post('/:id/refresh',           authenticate, refresh);
router.post('/:id/submit',            authenticate, submit);
router.post('/:id/approve',           authenticate, approve);
router.post('/:id/reject',            authenticate, reject);
router.delete('/:id',                 authenticate, remove);

module.exports = router;