// ⭐ NEW 12/05/2026: Routes quản lý vị trí tuyển dụng (Admin/Manager)
//
// Phân quyền:
// - Admin: quản tất cả branch
// - Manager: chỉ branch của mình (req.user.branchId)
// - Khác: 403
//
// Mount: app.use('/api/job-postings', require('./routes/jobPostingRoutes'))

const express = require('express');
const router = express.Router();
const JobPosting = require('../models/JobPosting');
const JobApplication = require('../models/JobApplication');
const { authenticate } = require('../middleware/auth');

// ── Middleware: chỉ Admin / Manager ────────────────────
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

// ── Middleware: check quyền branch (Manager chỉ branch mình) ──
const checkBranchAccess = (branchId, user) => {
  if (user.role === 'Admin') return true;
  if (user.role === 'Manager') {
    return String(user.branchId) === String(branchId);
  }
  return false;
};

// ── GET /api/job-postings?branchId=...&status=active ─────
// List job postings (filter by branch + status)
router.get('/', authenticate, requireAdminOrManager, async (req, res, next) => {
  try {
    const { branchId, status, page = 1, limit = 50 } = req.query;
    const filter = {};

    if (branchId) {
      if (!checkBranchAccess(branchId, req.user)) {
        return res.status(403).json({
          success: false,
          message: 'Không có quyền xem chi nhánh này',
          code: 'FORBIDDEN_BRANCH',
        });
      }
      filter.branchId = branchId;
    } else if (req.user.role === 'Manager') {
      // Manager không truyền branchId → tự filter branch của họ
      filter.branchId = req.user.branchId;
    }

    if (status && ['active', 'closed'].includes(status)) {
      filter.status = status;
    }

    const total = await JobPosting.countDocuments(filter);
    const postings = await JobPosting.find(filter)
      .populate('branchId', 'name address')
      .populate('createdBy', 'fullName email username')
      .sort({ createdAt: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit)
      .lean();

    // Đếm số ứng viên cho mỗi job
    const postingIds = postings.map(p => p._id);
    const appCounts = await JobApplication.aggregate([
      { $match: { jobPostingId: { $in: postingIds } } },
      { $group: {
          _id: { jobPostingId: '$jobPostingId', status: '$status' },
          count: { $sum: 1 },
      }},
    ]);

    const countMap = {};
    for (const c of appCounts) {
      const pid = String(c._id.jobPostingId);
      if (!countMap[pid]) countMap[pid] = { total: 0, new: 0, reviewing: 0, interviewing: 0, hired: 0, rejected: 0 };
      countMap[pid].total += c.count;
      countMap[pid][c._id.status] = c.count;
    }

    const enriched = postings.map(p => ({
      ...p,
      applicationStats: countMap[String(p._id)] ?? { total: 0, new: 0, reviewing: 0, interviewing: 0, hired: 0, rejected: 0 },
    }));

    res.json({ success: true, data: { data: enriched, total, page: +page, limit: +limit } });
  } catch (err) { next(err); }
});

// ── GET /api/job-postings/:id ────────────────────────────
router.get('/:id', authenticate, requireAdminOrManager, async (req, res, next) => {
  try {
    const posting = await JobPosting.findById(req.params.id)
      .populate('branchId', 'name address phone')
      .populate('createdBy', 'fullName email username')
      .lean();

    if (!posting) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy vị trí' });
    }

    if (!checkBranchAccess(posting.branchId._id ?? posting.branchId, req.user)) {
      return res.status(403).json({
        success: false,
        message: 'Không có quyền xem vị trí của chi nhánh khác',
        code: 'FORBIDDEN_BRANCH',
      });
    }

    res.json({ success: true, data: { posting } });
  } catch (err) { next(err); }
});

// ── POST /api/job-postings ───────────────────────────────
// Body: { branchId, title, position, description, requirements, benefits, salaryMin, salaryMax, workType }
router.post('/', authenticate, requireAdminOrManager, async (req, res, next) => {
  try {
    const {
      branchId, title, position, description, requirements, benefits,
      salaryMin, salaryMax, workType, status,
    } = req.body;

    if (!branchId || !title || !position) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu thông tin: chi nhánh, tiêu đề, vị trí',
        code: 'MISSING_FIELDS',
      });
    }

    if (!checkBranchAccess(branchId, req.user)) {
      return res.status(403).json({
        success: false,
        message: 'Không có quyền tạo vị trí cho chi nhánh khác',
        code: 'FORBIDDEN_BRANCH',
      });
    }

    if (salaryMin && salaryMax && Number(salaryMin) > Number(salaryMax)) {
      return res.status(400).json({
        success: false,
        message: 'Lương tối thiểu không được lớn hơn lương tối đa',
        code: 'INVALID_SALARY',
      });
    }

    const posting = await JobPosting.create({
      branchId,
      title: title.trim(),
      position: position.trim(),
      description: description ?? '',
      requirements: requirements ?? '',
      benefits: benefits ?? '',
      salaryMin: Number(salaryMin) || 0,
      salaryMax: Number(salaryMax) || 0,
      workType: workType ?? 'fulltime',
      status: status ?? 'active',
      createdBy: req.user.id,
    });

    res.status(201).json({
      success: true,
      message: 'Tạo vị trí tuyển dụng thành công',
      data: { posting },
    });
  } catch (err) { next(err); }
});

// ── PUT /api/job-postings/:id ────────────────────────────
router.put('/:id', authenticate, requireAdminOrManager, async (req, res, next) => {
  try {
    const posting = await JobPosting.findById(req.params.id);
    if (!posting) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy vị trí' });
    }

    if (!checkBranchAccess(posting.branchId, req.user)) {
      return res.status(403).json({
        success: false,
        message: 'Không có quyền sửa vị trí của chi nhánh khác',
        code: 'FORBIDDEN_BRANCH',
      });
    }

    const allowed = ['title', 'position', 'description', 'requirements', 'benefits',
                     'salaryMin', 'salaryMax', 'workType', 'status'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) posting[k] = req.body[k];
    }

    if (posting.salaryMin && posting.salaryMax && posting.salaryMin > posting.salaryMax) {
      return res.status(400).json({
        success: false,
        message: 'Lương tối thiểu không được lớn hơn lương tối đa',
        code: 'INVALID_SALARY',
      });
    }

    await posting.save();
    res.json({ success: true, message: 'Cập nhật vị trí thành công', data: { posting } });
  } catch (err) { next(err); }
});

// ── DELETE /api/job-postings/:id ─────────────────────────
// Soft delete: chuyển status='closed' nếu có ứng viên, hard delete nếu chưa
router.delete('/:id', authenticate, requireAdminOrManager, async (req, res, next) => {
  try {
    const posting = await JobPosting.findById(req.params.id);
    if (!posting) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy vị trí' });
    }

    if (!checkBranchAccess(posting.branchId, req.user)) {
      return res.status(403).json({
        success: false,
        message: 'Không có quyền xoá vị trí của chi nhánh khác',
        code: 'FORBIDDEN_BRANCH',
      });
    }

    const appCount = await JobApplication.countDocuments({ jobPostingId: posting._id });
    if (appCount > 0) {
      // Có ứng viên → soft delete (chuyển closed)
      posting.status = 'closed';
      await posting.save();
      return res.json({
        success: true,
        message: `Đã đóng vị trí (có ${appCount} hồ sơ ứng viên, không xoá hẳn)`,
        data: { softDeleted: true, applicationCount: appCount },
      });
    }

    await posting.deleteOne();
    res.json({ success: true, message: 'Đã xoá vị trí tuyển dụng' });
  } catch (err) { next(err); }
});

module.exports = router;