const TaxProfile = require('../models/TaxProfile');

// Chuẩn hoá MST: bỏ khoảng trắng.
const normalizeTaxCode = (s) => String(s ?? '').replace(/\s+/g, '').trim();

// Escape regex để search an toàn (tránh user nhập ký tự đặc biệt làm vỡ regex).
const escapeRegex = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ════════════════════════════════════════════════════════════════════════════
// GET /tax-profiles/search?q=...&branchId=...&limit=...
//   Autocomplete: gõ TÊN công ty HOẶC MST → gợi ý.
//   - Match taxCode (prefix) OR companyName (contains), không phân biệt hoa thường.
//   - Ưu tiên record dùng nhiều (usageCount desc), rồi mới dùng gần đây.
// ════════════════════════════════════════════════════════════════════════════
const search = async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 8));
    const branchId = req.query.branchId || null;

    if (!q) {
      return res.json({ success: true, data: { data: [] } });
    }

    const rx = new RegExp(escapeRegex(q), 'i');
    const filter = {
      $or: [
        { taxCode:     rx },
        { companyName: rx },
      ],
    };
    // Lọc theo branch nếu truyền (bao gồm cả record dùng chung branchId=null).
    if (branchId) {
      filter.$and = [{ $or: [{ branchId }, { branchId: null }] }];
    }

    const list = await TaxProfile.find(filter)
      .sort({ usageCount: -1, lastUsedAt: -1, updatedAt: -1 })
      .limit(limit)
      .lean();

    res.json({ success: true, data: { data: list } });
  } catch (err) {
    console.error('[taxProfile.search] error:', err);
    next(err);
  }
};

// ════════════════════════════════════════════════════════════════════════════
// GET /tax-profiles/by-code/:taxCode
//   Lấy chính xác 1 record theo MST (dùng khi cần điền lại lúc xuất HĐĐT).
// ════════════════════════════════════════════════════════════════════════════
const getByCode = async (req, res, next) => {
  try {
    const taxCode = normalizeTaxCode(req.params.taxCode);
    if (!taxCode) {
      return res.status(400).json({ success: false, message: 'Thiếu mã số thuế' });
    }
    const doc = await TaxProfile.findOne({ taxCode }).lean();
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy hồ sơ thuế' });
    }
    res.json({ success: true, data: { taxProfile: doc } });
  } catch (err) {
    console.error('[taxProfile.getByCode] error:', err);
    next(err);
  }
};

// ════════════════════════════════════════════════════════════════════════════
// POST /tax-profiles  (upsert theo taxCode)
//   Body: { taxCode, companyName, address?, email?, phone?, buyerName?, note?, branchId? }
//   - Nếu MST đã tồn tại → cập nhật thông tin + tăng usageCount.
//   - Nếu chưa → tạo mới.
// ════════════════════════════════════════════════════════════════════════════
const upsert = async (req, res, next) => {
  try {
    const taxCode = normalizeTaxCode(req.body?.taxCode);
    const companyName = String(req.body?.companyName ?? '').trim();

    if (!taxCode) {
      return res.status(400).json({ success: false, code: 'NO_TAX_CODE', message: 'Vui lòng nhập mã số thuế' });
    }
    if (!companyName) {
      return res.status(400).json({ success: false, code: 'NO_COMPANY_NAME', message: 'Vui lòng nhập tên công ty' });
    }

    const update = {
      companyName,
      address:   String(req.body?.address ?? '').trim(),
      email:     String(req.body?.email ?? '').trim(),
      phone:     String(req.body?.phone ?? '').trim(),
      buyerName: String(req.body?.buyerName ?? '').trim(),
      note:      String(req.body?.note ?? '').trim(),
      lastUsedAt: new Date(),
    };
    if (req.body?.branchId) update.branchId = req.body.branchId;

    const doc = await TaxProfile.findOneAndUpdate(
      { taxCode },
      { $set: update, $setOnInsert: { taxCode }, $inc: { usageCount: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({ success: true, message: 'Đã lưu hồ sơ thuế', data: { taxProfile: doc } });
  } catch (err) {
    // Trùng MST do race condition → trả 409 rõ ràng
    if (err?.code === 11000) {
      return res.status(409).json({ success: false, code: 'DUPLICATE_TAX_CODE', message: 'Mã số thuế đã tồn tại' });
    }
    console.error('[taxProfile.upsert] error:', err);
    next(err);
  }
};

// ════════════════════════════════════════════════════════════════════════════
// PATCH /tax-profiles/:id/touch — tăng usageCount khi 1 record được CHỌN sử dụng.
//   (Tùy chọn — FE có thể gọi khi user chọn gợi ý để cải thiện thứ tự lần sau.)
// ════════════════════════════════════════════════════════════════════════════
const touch = async (req, res, next) => {
  try {
    const doc = await TaxProfile.findByIdAndUpdate(
      req.params.id,
      { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } },
      { new: true }
    ).lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Không tìm thấy hồ sơ thuế' });
    res.json({ success: true, data: { taxProfile: doc } });
  } catch (err) {
    console.error('[taxProfile.touch] error:', err);
    next(err);
  }
};

module.exports = { search, getByCode, upsert, touch };