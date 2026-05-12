// ⭐ NEW 12/05/2026: Routes quản lý hồ sơ ứng viên (Admin/Manager)
//
// Phân quyền:
// - Admin: xem/sửa/xoá tất cả branch
// - Manager: chỉ branch của mình
//
// Mount: app.use('/api/job-applications', require('./routes/jobApplicationRoutes'))

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const JobApplication = require('../models/JobApplication');
const JobPosting = require('../models/JobPosting');
const { authenticate } = require('../middleware/auth');

const requireAdminOrManager = (req, res, next) => {
  const role = req.user?.role;
  if (role !== 'Admin' && role !== 'Manager') {
    return res.status(403).json({
      success: false,
      message: 'Chỉ Admin hoặc Quản lý mới được phép truy cập',
      code: 'FORBIDDEN_ROLE',
    });
  }
  next();
};

const checkBranchAccess = (branchId, user) => {
  if (user.role === 'Admin') return true;
  if (user.role === 'Manager') return String(user.branchId) === String(branchId);
  return false;
};

// ── GET /api/job-applications?branchId=...&jobPostingId=...&status=...&search=... ──
// List ứng viên với filter + search
router.get('/', authenticate, requireAdminOrManager, async (req, res, next) => {
  try {
    const {
      branchId, jobPostingId, status, search,
      fromDate, toDate,
      page = 1, limit = 50,
    } = req.query;

    const filter = {};

    // Branch filter (Manager force về branch mình)
    if (req.user.role === 'Manager') {
      filter.branchId = req.user.branchId;
    } else if (branchId) {
      filter.branchId = branchId;
    }

    if (jobPostingId) filter.jobPostingId = jobPostingId;
    if (status && ['new', 'reviewing', 'interviewing', 'hired', 'rejected'].includes(status)) {
      filter.status = status;
    }

    if (fromDate || toDate) {
      filter.createdAt = {};
      if (fromDate) filter.createdAt.$gte = new Date(fromDate);
      if (toDate)   filter.createdAt.$lte = new Date(toDate);
    }

    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { fullName: { $regex: safe, $options: 'i' } },
        { phone:    { $regex: safe, $options: 'i' } },
        { email:    { $regex: safe, $options: 'i' } },
      ];
    }

    const total = await JobApplication.countDocuments(filter);
    const applications = await JobApplication.find(filter)
      .populate('jobPostingId', 'title position')
      .populate('branchId', 'name')
      .populate('reviewedBy', 'fullName username')
      .sort({ createdAt: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit)
      .lean();

    res.json({
      success: true,
      data: { data: applications, total, page: +page, limit: +limit },
    });
  } catch (err) { next(err); }
});

// ── GET /api/job-applications/:id ────────────────────────
router.get('/:id', authenticate, requireAdminOrManager, async (req, res, next) => {
  try {
    const app = await JobApplication.findById(req.params.id)
      .populate('jobPostingId', 'title position description requirements benefits')
      .populate('branchId', 'name address')
      .populate('reviewedBy', 'fullName username')
      .lean();

    if (!app) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy hồ sơ' });
    }

    if (!checkBranchAccess(app.branchId._id ?? app.branchId, req.user)) {
      return res.status(403).json({
        success: false,
        message: 'Không có quyền xem hồ sơ của chi nhánh khác',
        code: 'FORBIDDEN_BRANCH',
      });
    }

    res.json({ success: true, data: { application: app } });
  } catch (err) { next(err); }
});

// ── PATCH /api/job-applications/:id ──────────────────────
// Update status + reviewNote (Admin/Manager)
router.patch('/:id', authenticate, requireAdminOrManager, async (req, res, next) => {
  try {
    const app = await JobApplication.findById(req.params.id);
    if (!app) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy hồ sơ' });
    }

    if (!checkBranchAccess(app.branchId, req.user)) {
      return res.status(403).json({
        success: false,
        message: 'Không có quyền sửa hồ sơ của chi nhánh khác',
        code: 'FORBIDDEN_BRANCH',
      });
    }

    const { status, reviewNote } = req.body;

    if (status !== undefined) {
      if (!['new', 'reviewing', 'interviewing', 'hired', 'rejected'].includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Trạng thái không hợp lệ',
          code: 'INVALID_STATUS',
        });
      }
      app.status = status;
    }

    if (reviewNote !== undefined) {
      app.reviewNote = String(reviewNote).slice(0, 2000);
    }

    app.reviewedBy = req.user.id;
    app.reviewedAt = new Date();

    await app.save();
    res.json({ success: true, message: 'Cập nhật hồ sơ thành công', data: { application: app } });
  } catch (err) { next(err); }
});

// ── DELETE /api/job-applications/:id (Admin only) ────────
router.delete('/:id', authenticate, requireAdminOrManager, async (req, res, next) => {
  try {
    const app = await JobApplication.findById(req.params.id);
    if (!app) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy hồ sơ' });
    }

    // Chỉ Admin được xoá hẳn (Manager chỉ được sửa status)
    if (req.user.role !== 'Admin') {
      return res.status(403).json({
        success: false,
        message: 'Chỉ Admin mới được xoá hồ sơ',
        code: 'FORBIDDEN_ROLE',
      });
    }

    // Xoá ảnh trên disk nếu có
    if (app.photoUrl && app.photoUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '..', app.photoUrl);
      fs.unlink(filePath, (err) => {
        if (err && err.code !== 'ENOENT') {
          console.warn('[job-applications/delete] Không xoá được ảnh:', filePath, err.message);
        }
      });
    }

    await app.deleteOne();
    res.json({ success: true, message: 'Đã xoá hồ sơ ứng viên' });
  } catch (err) { next(err); }
});

// ── GET /api/job-applications/stats/summary ─────────────
// Thống kê tổng quan (số ứng viên theo status, theo branch)
router.get('/stats/summary', authenticate, requireAdminOrManager, async (req, res, next) => {
  try {
    const { branchId } = req.query;
    const matchFilter = {};

    if (req.user.role === 'Manager') {
      matchFilter.branchId = req.user.branchId;
    } else if (branchId) {
      const mongoose = require('mongoose');
      matchFilter.branchId = new mongoose.Types.ObjectId(branchId);
    }

    const stats = await JobApplication.aggregate([
      { $match: matchFilter },
      { $group: {
          _id: '$status',
          count: { $sum: 1 },
      }},
    ]);

    const summary = { total: 0, new: 0, reviewing: 0, interviewing: 0, hired: 0, rejected: 0 };
    for (const s of stats) {
      summary[s._id] = s.count;
      summary.total += s.count;
    }

    res.json({ success: true, data: { stats: summary } });
  } catch (err) { next(err); }
});

module.exports = router;