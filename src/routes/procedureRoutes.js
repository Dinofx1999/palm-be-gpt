// ⭐ NEW 13/05/2026: Procedure routes v4
// FINAL: Position = role name (1:1 mapping)
//   Admin role         → position 'Admin'
//   Manager role       → position 'Manager'
//   Receptionist role  → position 'Receptionist'
//   Staff role         → position 'Staff'
// → User chỉ thấy quy trình có positions chứa role của mình
// → Admin/Manager KHÔNG bypass — phải có 'Admin' hoặc 'Manager' trong positions thì mới thấy

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const router = express.Router();
const Procedure = require('../models/Procedure');
const { authenticate } = require('../middleware/auth');

const extractBranchId = (val) => {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return val._id?.toString() ?? val.id ?? null;
  return null;
};

// ⭐ Chuẩn hoá ảnh của 1 step: ưu tiên imageUrls (mảng mới), fallback imageUrl (chuỗi cũ).
//   Trả mảng string đã trim, loại rỗng, tối đa 20 ảnh.
const normalizeImageUrls = (s) => {
  let arr = [];
  if (Array.isArray(s.imageUrls)) arr = s.imageUrls;
  else if (s.imageUrl) arr = [s.imageUrl];
  return arr
    .map(u => String(u || '').trim())
    .filter(Boolean)
    .slice(0, 20);
};

// ───────────── Position mapping (role → position name) ─────────────
// Position name TRÙNG với role name → mapping 1:1 trực tiếp
const VALID_POSITIONS = ['Admin', 'Manager', 'Receptionist', 'Staff'];

// ───────────── Multer ─────────────
const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'procedures');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
console.log('[procedures] Upload directory:', uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
    const uniqueId = crypto.randomBytes(8).toString('hex');
    cb(null, `step-${Date.now()}-${uniqueId}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Chỉ chấp nhận ảnh JPG, PNG, WEBP'));
  },
});

const requireAdminOrManager = (req, res, next) => {
  if (!['Admin', 'Manager'].includes(req.user?.role)) {
    return res.status(403).json({
      success: false,
      message: 'Chỉ Admin/Manager mới có quyền thao tác',
      code: 'FORBIDDEN',
    });
  }
  next();
};

// ═══════════════════════════════════════════════════════════
// GET /api/procedures - List
// User chỉ thấy quy trình có positions chứa role của mình
// ═══════════════════════════════════════════════════════════
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { branchId, position, category, status, search } = req.query;
    const filter = {};

    // ─── Branch isolation ───
    if (req.user.role === 'Admin') {
      // Admin: filter theo branchId từ query (FE gửi từ selectedBranchId)
      if (branchId) filter.branchId = branchId;
    } else {
      // Các role khác: bắt buộc theo branch của user
      const userBranchId = extractBranchId(req.user.branchId);
      if (!userBranchId) {
        return res.status(400).json({
          success: false,
          message: 'Tài khoản chưa được gán chi nhánh',
        });
      }
      filter.branchId = userBranchId;
    }

    // ─── Position filter — chỉ thấy quy trình có role mình trong positions ───
    // Position name = role name (1:1)
    if (position) {
      // Admin/Manager có thể filter manual theo position cụ thể
      filter.positions = { $in: [position] };
    } else {
      filter.positions = { $in: [req.user.role] };
    }

    if (category) filter.category = category;
    if (status) filter.status = status;
    else filter.status = 'active';

    if (search) {
      const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { title:       { $regex: safe, $options: 'i' } },
        { description: { $regex: safe, $options: 'i' } },
      ];
    }

    const items = await Procedure.find(filter)
      .populate('branchId', 'name')
      .populate('createdBy', 'fullName')
      .populate('updatedBy', 'fullName')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      data: { data: items, total: items.length },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// GET /api/procedures/:id
// ═══════════════════════════════════════════════════════════
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const procedure = await Procedure.findById(req.params.id)
      .populate('branchId', 'name address city')
      .populate('createdBy', 'fullName')
      .populate('updatedBy', 'fullName')
      .lean();

    if (!procedure) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy quy trình',
      });
    }

    // Branch isolation
    if (req.user.role !== 'Admin') {
      const userBranchId = extractBranchId(req.user.branchId);
      const procBranchId = procedure.branchId?._id?.toString() ?? procedure.branchId?.toString();
      if (userBranchId !== procBranchId) {
        return res.status(403).json({
          success: false,
          message: 'Không có quyền xem quy trình của chi nhánh khác',
        });
      }
    }

    // Position check — phải có role mình trong positions
    const procPositions = Array.isArray(procedure.positions) ? procedure.positions : [];
    if (!procPositions.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Quy trình này không áp dụng cho vị trí của bạn',
      });
    }

    res.json({ success: true, data: { procedure } });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// POST /api/procedures - Create
// ═══════════════════════════════════════════════════════════
router.post('/', authenticate, requireAdminOrManager, async (req, res, next) => {
  try {
    const {
      branchId,
      title,
      positions,
      category,
      description,
      steps,
      status,
    } = req.body;

    let finalBranchId = branchId;
    if (req.user.role === 'Manager') {
      const userBranchId = extractBranchId(req.user.branchId);
      if (!userBranchId) {
        return res.status(400).json({
          success: false,
          message: 'Tài khoản chưa được gán chi nhánh',
        });
      }
      finalBranchId = userBranchId;
    }

    const positionsArray = Array.isArray(positions)
      ? positions.map(p => String(p).trim()).filter(Boolean)
      : (positions ? [String(positions).trim()] : []);

    // Validate position values
    const invalidPositions = positionsArray.filter(p => !VALID_POSITIONS.includes(p));
    if (invalidPositions.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Vị trí không hợp lệ: ${invalidPositions.join(', ')}. Chỉ chấp nhận: ${VALID_POSITIONS.join(', ')}`,
      });
    }

    if (!finalBranchId || !title || positionsArray.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu thông tin bắt buộc (branchId, title, ít nhất 1 vị trí)',
      });
    }

    const normalizedSteps = Array.isArray(steps)
      ? steps.map((s, i) => ({
          order: i + 1,
          title: String(s.title || '').trim().slice(0, 200),
          content: String(s.content || '').trim().slice(0, 5000),
          // ⭐ nhiều ảnh: ưu tiên imageUrls (mảng), fallback imageUrl cũ (1 ảnh)
          imageUrls: normalizeImageUrls(s),
        })).filter(s => s.title.length > 0)
      : [];

    const procedure = await Procedure.create({
      branchId: finalBranchId,
      title: String(title).trim(),
      positions: positionsArray,
      category: ['checklist', 'sop'].includes(category) ? category : 'sop',
      description: String(description || '').trim(),
      steps: normalizedSteps,
      status: status === 'archived' ? 'archived' : 'active',
      createdBy: req.user.id,
      updatedBy: req.user.id,
    });

    res.status(201).json({
      success: true,
      message: 'Tạo quy trình thành công',
      data: { procedure },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// PUT /api/procedures/:id
// ═══════════════════════════════════════════════════════════
router.put('/:id', authenticate, requireAdminOrManager, async (req, res, next) => {
  try {
    const procedure = await Procedure.findById(req.params.id);
    if (!procedure) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy quy trình',
      });
    }

    if (req.user.role === 'Manager') {
      const userBranchId = extractBranchId(req.user.branchId);
      if (procedure.branchId.toString() !== userBranchId) {
        return res.status(403).json({
          success: false,
          message: 'Không có quyền sửa quy trình của chi nhánh khác',
        });
      }
    }

    const { title, positions, category, description, steps, status } = req.body;

    if (title !== undefined) procedure.title = String(title).trim();

    if (positions !== undefined) {
      const positionsArray = Array.isArray(positions)
        ? positions.map(p => String(p).trim()).filter(Boolean)
        : [];
      // Validate
      const invalidPositions = positionsArray.filter(p => !VALID_POSITIONS.includes(p));
      if (invalidPositions.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Vị trí không hợp lệ: ${invalidPositions.join(', ')}`,
        });
      }
      if (positionsArray.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Cần ít nhất 1 vị trí áp dụng',
        });
      }
      procedure.positions = positionsArray;
    }

    if (category !== undefined && ['checklist', 'sop'].includes(category)) {
      procedure.category = category;
    }
    if (description !== undefined) procedure.description = String(description).trim();
    if (status !== undefined && ['active', 'archived'].includes(status)) {
      procedure.status = status;
    }
    if (Array.isArray(steps)) {
      procedure.steps = steps.map((s, i) => ({
        order: i + 1,
        title: String(s.title || '').trim().slice(0, 200),
        content: String(s.content || '').trim().slice(0, 5000),
        imageUrls: normalizeImageUrls(s),
      })).filter(s => s.title.length > 0);
    }
    procedure.updatedBy = req.user.id;

    await procedure.save();

    res.json({
      success: true,
      message: 'Cập nhật quy trình thành công',
      data: { procedure },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// DELETE /api/procedures/:id - Admin only
// ═══════════════════════════════════════════════════════════
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'Admin') {
      return res.status(403).json({
        success: false,
        message: 'Chỉ Admin mới được xoá. Manager có thể chuyển sang trạng thái Lưu trữ.',
      });
    }

    const procedure = await Procedure.findByIdAndDelete(req.params.id);
    if (!procedure) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy quy trình',
      });
    }

    if (Array.isArray(procedure.steps)) {
      procedure.steps.forEach(s => {
        // gom cả imageUrls (mới) + imageUrl (cũ) để xóa file
        const urls = [
          ...(Array.isArray(s.imageUrls) ? s.imageUrls : []),
          ...(s.imageUrl ? [s.imageUrl] : []),
        ];
        urls.forEach(u => {
          if (u && u.startsWith('/uploads/procedures/')) {
            const filePath = path.join(uploadDir, path.basename(u));
            fs.unlink(filePath, () => {});
          }
        });
      });
    }

    res.json({ success: true, message: 'Đã xoá quy trình' });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════
// POST /api/procedures/upload-step-image
// ═══════════════════════════════════════════════════════════
router.post('/upload-step-image', authenticate, requireAdminOrManager, (req, res) => {
  upload.single('image')(req, res, (err) => {
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
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng chọn ảnh',
      });
    }

    const relativeUrl = `/uploads/procedures/${req.file.filename}`;
    console.log('[procedures] Uploaded step image:', {
      filename: req.file.filename,
      publicUrl: relativeUrl,
    });

    res.json({
      success: true,
      message: 'Upload ảnh thành công',
      data: {
        imageUrl: relativeUrl,
        filename: req.file.filename,
        size: req.file.size,
      },
    });
  });
});

// ═══════════════════════════════════════════════════════════
// GET /api/procedures/positions/list - Trả về 4 position valid
// ═══════════════════════════════════════════════════════════
router.get('/positions/list', authenticate, async (req, res) => {
  res.json({
    success: true,
    data: {
      positions: VALID_POSITIONS,
    },
  });
});

// ═══════════════════════════════════════════════════════════
// POST /api/procedures/:id/copy - Copy sang chi nhánh khác (Admin only)
// Body: { targetBranchIds: ['branch1Id', 'branch2Id', ...], titlePrefix?: '[Copy] ' }
// Tạo bản sao độc lập (không sync với bản gốc)
// ═══════════════════════════════════════════════════════════
router.post('/:id/copy', authenticate, async (req, res, next) => {
  try {
    // Chỉ Admin
    if (req.user.role !== 'Admin') {
      return res.status(403).json({
        success: false,
        message: 'Chỉ Admin mới được copy quy trình sang chi nhánh khác',
      });
    }

    const { targetBranchIds, titlePrefix } = req.body;
    if (!Array.isArray(targetBranchIds) || targetBranchIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Chọn ít nhất 1 chi nhánh đích',
      });
    }

    const source = await Procedure.findById(req.params.id).lean();
    if (!source) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy quy trình gốc',
      });
    }

    const sourceBranchId = source.branchId?.toString();
    // Bỏ branch gốc khỏi danh sách đích (nếu có nhầm)
    const validTargets = targetBranchIds
      .map(id => String(id).trim())
      .filter(id => id && id !== sourceBranchId);

    if (validTargets.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Không có chi nhánh đích hợp lệ (không thể copy về chính chi nhánh gốc)',
      });
    }

    // Tạo nhiều bản sao song song
    const prefix = String(titlePrefix || '').trim();
    const newTitle = prefix
      ? `${prefix}${source.title}`.slice(0, 200)
      : source.title;

    const copies = await Promise.all(
      validTargets.map(branchId =>
        Procedure.create({
          branchId,
          title: newTitle,
          positions: source.positions,
          category: source.category,
          description: source.description,
          // Clone steps (bỏ _id để Mongo tự tạo mới)
          steps: (source.steps || []).map(s => ({
            order: s.order,
            title: s.title,
            content: s.content,
            imageUrls: normalizeImageUrls(s),
          })),
          status: 'active',  // bản copy mặc định active
          createdBy: req.user.id,
          updatedBy: req.user.id,
        })
      )
    );

    res.status(201).json({
      success: true,
      message: `Đã copy quy trình sang ${copies.length} chi nhánh`,
      data: {
        copies: copies.map(c => ({
          _id: c._id,
          branchId: c.branchId,
          title: c.title,
        })),
        count: copies.length,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;