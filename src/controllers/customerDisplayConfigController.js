// backend/src/controllers/customerDisplayConfigController.js
// CRUD cấu hình màn hình khách theo chi nhánh.
//  - getPublicByBranch: PUBLIC (màn /customer-display không đăng nhập) — chỉ trả nội dung hiển thị.
//  - getByBranch:       cho trang quản trị (đã đăng nhập).
//  - updateByBranch:    Admin/Manager cập nhật.
const CustomerDisplayConfig = require('../models/CustomerDisplayConfig');

// Chuẩn hoá branchId từ query/param/body
const pickBranchId = (req) =>
  req.params.branchId || req.query.branchId || req.body?.branchId || null;

// Chỉ trả các field cần cho màn hình khách (không lộ metadata thừa)
const toPublic = (doc) => ({
  brand:           doc.brand ?? {},
  media:           doc.media ?? [],
  qrItems:         doc.qrItems ?? [],
  notices:         doc.notices ?? [],
  slideIntervalMs: doc.slideIntervalMs ?? 6000,
  enabled:         doc.enabled !== false,
});

// GET /api/customer-display-config/public?branchId=...  (PUBLIC)
exports.getPublicByBranch = async (req, res) => {
  try {
    const branchId = pickBranchId(req);
    if (!branchId) return res.status(400).json({ message: 'Thiếu branchId' });
    const doc = await CustomerDisplayConfig.getByBranch(branchId);
    return res.json({ data: toPublic(doc) });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi tải cấu hình màn hình khách' });
  }
};

// GET /api/customer-display-config?branchId=...  (auth — cho trang quản trị)
exports.getByBranch = async (req, res) => {
  try {
    const branchId = pickBranchId(req);
    if (!branchId) return res.status(400).json({ message: 'Thiếu branchId' });
    const doc = await CustomerDisplayConfig.getByBranch(branchId);
    return res.json({ data: doc });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi tải cấu hình' });
  }
};

// PUT /api/customer-display-config?branchId=...  (Admin/Manager)
exports.updateByBranch = async (req, res) => {
  try {
    const branchId = pickBranchId(req);
    if (!branchId) return res.status(400).json({ message: 'Thiếu branchId' });

    const { brand, media, qrItems, notices, slideIntervalMs, enabled } = req.body || {};
    const update = {};
    if (brand !== undefined)           update.brand = brand;
    if (Array.isArray(media))          update.media = media;
    if (Array.isArray(qrItems))        update.qrItems = qrItems;
    if (Array.isArray(notices))        update.notices = notices.filter((s) => typeof s === 'string');
    if (slideIntervalMs !== undefined) update.slideIntervalMs = Number(slideIntervalMs) || 6000;
    if (enabled !== undefined)         update.enabled = !!enabled;

    const doc = await CustomerDisplayConfig.findOneAndUpdate(
      { branchId },
      { $set: update, $setOnInsert: { branchId } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return res.json({ data: doc, message: 'Đã lưu cấu hình màn hình khách' });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi lưu cấu hình' });
  }
};