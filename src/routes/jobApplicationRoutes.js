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
router.get('/', authenticate, requireAdminOrManager, async (req, res, next) => {
  try {
    const {
      branchId, jobPostingId, status, search,
      fromDate, toDate,
      page = 1, limit = 50,
    } = req.query;

    const filter = {};

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

// ── GET /api/job-applications/upcoming-interviews?branchId=&days= ──
//   Lịch phỏng vấn sắp tới (cho tab Lịch phỏng vấn). Mặc định 14 ngày tới + quá khứ gần.
router.get('/upcoming-interviews', authenticate, requireAdminOrManager, async (req, res, next) => {
  try {
    const { branchId } = req.query;
    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);

    const filter = {
      status: 'interviewing',
      interviewAt: { $ne: null },
    };
    if (req.user.role === 'Manager') {
      filter.branchId = req.user.branchId;
    } else if (branchId) {
      filter.branchId = branchId;
    }

    // từ 7 ngày trước → `days` ngày tới (để xem cả lịch vừa qua)
    const now = new Date();
    filter.interviewAt = {
      $gte: new Date(now.getTime() - 7 * 24 * 3600 * 1000),
      $lte: new Date(now.getTime() + days * 24 * 3600 * 1000),
    };

    const list = await JobApplication.find(filter)
      .populate('jobPostingId', 'title position')
      .populate('branchId', 'name')
      .sort({ interviewAt: 1 })
      .lean();

    res.json({ success: true, data: { data: list, total: list.length } });
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
//   Update status + reviewNote + lịch phỏng vấn (interviewAt, interviewLocation)
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

    const { status, reviewNote, interviewAt, interviewLocation,
            interviewReminderMinutes, interviewNotifyTelegram } = req.body;

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

    // ⭐ Lịch phỏng vấn
    let interviewChanged = false;
    if (interviewAt !== undefined) {
      if (interviewAt === null || interviewAt === '') {
        app.interviewAt = null;
      } else {
        const d = new Date(interviewAt);
        if (isNaN(d.getTime())) {
          return res.status(400).json({
            success: false,
            message: 'Thời gian phỏng vấn không hợp lệ',
            code: 'INVALID_INTERVIEW_TIME',
          });
        }
        // ⭐ Chặn trùng lịch: cùng chi nhánh, cùng mốc giờ, đang ở trạng thái phỏng vấn,
        //   trừ chính hồ sơ này. (so khớp chính xác mốc thời gian)
        const clash = await JobApplication.findOne({
          _id: { $ne: app._id },
          branchId: app.branchId,
          status: 'interviewing',
          interviewAt: d,
        }).select('fullName').lean();
        if (clash) {
          return res.status(409).json({
            success: false,
            message: `Thời gian này đã hẹn phỏng vấn với ${clash.fullName}. Vui lòng chọn giờ khác.`,
            code: 'INTERVIEW_TIME_CONFLICT',
          });
        }
        app.interviewAt = d;
        interviewChanged = true;
      }
    }
    if (interviewLocation !== undefined) {
      app.interviewLocation = String(interviewLocation).slice(0, 500);
    }
    if (interviewReminderMinutes !== undefined) {
      const n = Number(interviewReminderMinutes);
      app.interviewReminderMinutes = Number.isFinite(n) && n >= 0 ? n : 60;
    }
    if (interviewNotifyTelegram !== undefined) {
      app.interviewNotifyTelegram = !!interviewNotifyTelegram;
    }
    // Nếu đổi thời gian hẹn → reset cờ đã-nhắc để được nhắc lại
    if (interviewChanged) {
      app.interviewReminderSent = false;
    }

    app.reviewedBy = req.user.id;
    app.reviewedAt = new Date();

    await app.save();

    // ⭐ Gửi xác nhận NGAY khi vừa lên/đổi lịch phỏng vấn (non-blocking).
    if (interviewChanged && app.interviewAt) {
      try {
        const { sendInterviewConfirmation } = require('../utils/interviewReminder');
        sendInterviewConfirmation(app._id);
      } catch (e) {
        console.error('[job-applications/patch] gửi xác nhận PV lỗi (non-fatal):', e.message);
      }
    }

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

    if (req.user.role !== 'Admin') {
      return res.status(403).json({
        success: false,
        message: 'Chỉ Admin mới được xoá hồ sơ',
        code: 'FORBIDDEN_ROLE',
      });
    }

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
      { $group: { _id: '$status', count: { $sum: 1 } } },
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