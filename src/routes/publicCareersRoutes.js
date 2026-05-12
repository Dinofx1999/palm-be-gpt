// ⭐ NEW 12/05/2026: Routes public careers — KHÔNG AUTH
//
// ⭐ FIX 12/05/2026 v2: Sửa path uploadDir
//   Static serve `/uploads` ở index.js trỏ đến `backend/uploads/` (lên 1 cấp từ src/)
//   Trước đó uploadDir trỏ sai đến `backend/src/uploads/careers/` → file save xong KHÔNG access được
//   Đã đổi sang `backend/uploads/careers/` để match
//
// Endpoints public cho ứng viên ngoài:
// - GET  /api/public/careers/:branchId
// - GET  /api/public/careers/job/:jobId
// - POST /api/public/careers/upload-photo
// - POST /api/public/careers/apply

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const router = express.Router();
const JobPosting = require('../models/JobPosting');
const JobApplication = require('../models/JobApplication');
const Branch = require('../models/Branch');

// ───────────────── In-memory rate limit ─────────────────
const rateLimitMap = new Map();

const checkRateLimit = (key, maxRequests, windowMs) => {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1 };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count };
};

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}, 10 * 60 * 1000);

const getClientIp = (req) => {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || req.ip
    || 'unknown';
};

// ───────────────── Multer config cho upload ảnh ─────────────────
// ⭐ FIX: path.join với '..' '..' để lên 2 cấp:
//   __dirname = backend/src/routes/
//   '..'      = backend/src/
//   '..'      = backend/
//   'uploads/careers' → backend/uploads/careers/ ✓
//   Khớp với static serve ở index.js: express.static(path.join(__dirname, '../uploads'))
//   (Tại index.js, __dirname = backend/src/, '../uploads' = backend/uploads/)
const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'careers');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log('[publicCareers] Created upload dir:', uploadDir);
}
console.log('[publicCareers] Upload directory:', uploadDir);   // ⭐ Log để verify khi server start

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
    const uniqueId = crypto.randomBytes(8).toString('hex');
    cb(null, `photo-${Date.now()}-${uniqueId}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 3 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Chỉ chấp nhận ảnh JPG, PNG hoặc WEBP'));
  },
});

// ───────────────── Helpers ─────────────────
const sanitizeText = (str, maxLen = 1000) => {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
};

const isValidEmail = (email) => {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

const isValidPhone = (phone) => {
  if (!phone) return false;
  const digitsOnly = phone.replace(/[\s+\-()]/g, '');
  return /^\d{9,15}$/.test(digitsOnly);
};

// ═════════════════════════════════════════════════════════
// ── GET /api/public/careers/:branchId ────────────────────
// ═════════════════════════════════════════════════════════
router.get('/:branchId', async (req, res, next) => {
  try {
    const { branchId } = req.params;

    const branch = await Branch.findById(branchId)
      .select('name address city')
      .lean();

    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy chi nhánh',
        code: 'BRANCH_NOT_FOUND',
      });
    }

    const jobs = await JobPosting.find({
      branchId,
      status: 'active',
    })
      .select('title position description requirements benefits salaryMin salaryMax workType createdAt')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      data: {
        branch,
        jobs,
        totalJobs: jobs.length,
      },
    });
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════
// ── GET /api/public/careers/job/:jobId ───────────────────
// ═════════════════════════════════════════════════════════
router.get('/job/:jobId', async (req, res, next) => {
  try {
    const job = await JobPosting.findById(req.params.jobId)
      .populate('branchId', 'name address city')
      .select('-createdBy -updatedAt')
      .lean();

    if (!job || job.status !== 'active') {
      return res.status(404).json({
        success: false,
        message: 'Vị trí này đã đóng hoặc không tồn tại',
        code: 'JOB_NOT_FOUND',
      });
    }

    res.json({ success: true, data: { job } });
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════
// ── POST /api/public/careers/upload-photo ────────────────
// ═════════════════════════════════════════════════════════
router.post('/upload-photo', (req, res, next) => {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`upload:${ip}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return res.status(429).json({
      success: false,
      message: `Bạn đã upload quá nhiều ảnh. Thử lại sau ${Math.ceil(rl.retryAfter / 60)} phút.`,
      code: 'RATE_LIMIT_EXCEEDED',
    });
  }
  next();
}, (req, res) => {
  upload.single('photo')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'Ảnh quá lớn (tối đa 3MB)',
          code: 'FILE_TOO_LARGE',
        });
      }
      return res.status(400).json({
        success: false,
        message: err.message ?? 'Lỗi upload',
        code: 'UPLOAD_ERROR',
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng chọn ảnh',
        code: 'NO_FILE',
      });
    }

    // ⭐ FIX: relativeUrl = /uploads/careers/photo-xxx.jpg
    //   Static serve `/uploads` ở index.js đã trỏ vào backend/uploads/
    //   Nên FE access qua: http://localhost:4000/uploads/careers/photo-xxx.jpg ✓
    const relativeUrl = `/uploads/careers/${req.file.filename}`;
    console.log('[publicCareers] Uploaded:', {
      filename: req.file.filename,
      diskPath: req.file.path,
      publicUrl: relativeUrl,
    });

    res.json({
      success: true,
      message: 'Upload ảnh thành công',
      data: {
        photoUrl: relativeUrl,
        filename: req.file.filename,
        size: req.file.size,
      },
    });
  });
});

// ═════════════════════════════════════════════════════════
// ── POST /api/public/careers/apply ───────────────────────
// ═════════════════════════════════════════════════════════
router.post('/apply', (req, res, next) => {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`apply:${ip}`, 3, 60 * 60 * 1000);
  if (!rl.allowed) {
    return res.status(429).json({
      success: false,
      message: `Bạn đã ứng tuyển quá nhiều lần. Thử lại sau ${Math.ceil(rl.retryAfter / 60)} phút.`,
      code: 'RATE_LIMIT_EXCEEDED',
    });
  }
  next();
}, async (req, res, next) => {
  try {
    const {
      jobPostingId,
      fullName,
      birthDate,
      phone,
      email,
      currentAddress,
      photoUrl,
      notes,
      _hp,
    } = req.body;

    if (_hp && String(_hp).trim().length > 0) {
      console.warn('[publicCareers/apply] Honeypot triggered, IP:', getClientIp(req));
      return res.status(200).json({
        success: true,
        message: 'Đã nhận hồ sơ. Chúng tôi sẽ liên hệ trong 3-5 ngày.',
        data: { applicationId: 'spam-blocked' },
      });
    }

    if (!jobPostingId || !fullName || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng điền họ tên và số điện thoại',
        code: 'MISSING_REQUIRED',
      });
    }

    const cleanName = sanitizeText(fullName, 100);
    if (cleanName.length < 2) {
      return res.status(400).json({
        success: false,
        message: 'Họ tên không hợp lệ',
        code: 'INVALID_NAME',
      });
    }

    if (!isValidPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Số điện thoại không hợp lệ',
        code: 'INVALID_PHONE',
      });
    }

    if (email && !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Email không hợp lệ',
        code: 'INVALID_EMAIL',
      });
    }

    const job = await JobPosting.findById(jobPostingId).select('branchId status').lean();
    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Vị trí tuyển dụng không tồn tại',
        code: 'JOB_NOT_FOUND',
      });
    }
    if (job.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'Vị trí này đã đóng tuyển dụng',
        code: 'JOB_CLOSED',
      });
    }

    const recentDuplicate = await JobApplication.findOne({
      jobPostingId,
      phone: phone.trim(),
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    }).select('_id').lean();

    if (recentDuplicate) {
      return res.status(400).json({
        success: false,
        message: 'Bạn đã ứng tuyển vị trí này gần đây. Vui lòng đợi nhân viên liên hệ.',
        code: 'DUPLICATE_APPLICATION',
      });
    }

    let safePhotoUrl = '';
    if (photoUrl && typeof photoUrl === 'string') {
      if (/^\/uploads\/careers\/photo-[\w.-]+$/.test(photoUrl)) {
        safePhotoUrl = photoUrl;
      }
    }

    let parsedBirthDate = null;
    if (birthDate) {
      const d = new Date(birthDate);
      if (!isNaN(d.getTime())) {
        const now = new Date();
        const minAge = 16, maxAge = 70;
        const age = (now - d) / (1000 * 60 * 60 * 24 * 365);
        if (age >= minAge && age <= maxAge) {
          parsedBirthDate = d;
        } else {
          return res.status(400).json({
            success: false,
            message: `Tuổi phải từ ${minAge} đến ${maxAge}`,
            code: 'INVALID_AGE',
          });
        }
      }
    }

    const application = await JobApplication.create({
      jobPostingId,
      branchId: job.branchId,
      fullName: cleanName,
      birthDate: parsedBirthDate,
      phone: phone.trim(),
      email: email ? email.trim().toLowerCase() : '',
      currentAddress: sanitizeText(currentAddress, 300),
      photoUrl: safePhotoUrl,
      notes: sanitizeText(notes, 1000),
      status: 'new',
      sourceIp: getClientIp(req),
      userAgent: (req.headers['user-agent'] ?? '').slice(0, 500),
    });

    res.status(201).json({
      success: true,
      message: 'Đã nhận hồ sơ. Chúng tôi sẽ liên hệ trong 3-5 ngày.',
      data: { applicationId: application._id },
    });
  } catch (err) {
    console.error('[publicCareers/apply] Error:', err);
    next(err);
  }
});

module.exports = router;