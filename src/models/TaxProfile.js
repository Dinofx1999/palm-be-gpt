const mongoose = require('mongoose');

// ════════════════════════════════════════════════════════════════════════════
// ⭐ NEW 30/05/2026: TaxProfile — Hồ sơ thuế / thông tin xuất Hoá Đơn Điện Tử.
//   Lưu RIÊNG (không nhúng vào Customer) để:
//     - 1 MST có thể gắn nhiều khách/booking khác nhau
//     - Tái sử dụng khi xuất HĐĐT: gõ tên/MST → gợi ý → chọn → tự điền
//   Index text trên taxCode + companyName phục vụ autocomplete.
// ════════════════════════════════════════════════════════════════════════════
const taxProfileSchema = new mongoose.Schema({
  // Mã số thuế — chuẩn hoá: bỏ khoảng trắng, dấu gạch. Unique để tránh trùng.
  taxCode:      { type: String, required: true, unique: true, trim: true, index: true },
  companyName:  { type: String, required: true, trim: true },
  address:      { type: String, default: '' },
  // Email nhận hoá đơn điện tử (có thể khác email khách)
  email:        { type: String, default: '' },
  phone:        { type: String, default: '' },
  // Người liên hệ / người mua hàng (tên cá nhân trên hoá đơn nếu cần)
  buyerName:    { type: String, default: '' },
  note:         { type: String, default: '' },

  // Branch sở hữu record (cho phép tách dữ liệu theo chi nhánh nếu cần).
  //   Để null = dùng chung toàn hệ thống.
  branchId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

  // Đếm số lần dùng để gợi ý ưu tiên record hay dùng lên đầu.
  usageCount:   { type: Number, default: 0 },
  lastUsedAt:   { type: Date, default: null },
}, { timestamps: true });

// Index hỗ trợ autocomplete theo tên công ty (prefix/contains qua regex).
taxProfileSchema.index({ companyName: 1 });

// Chuẩn hoá MST trước khi lưu: bỏ space + ký tự không phải số/gạch.
//   MST VN: 10 số, hoặc 13 số dạng "xxxxxxxxxx-xxx".
taxProfileSchema.pre('save', function () {
  if (this.taxCode) {
    this.taxCode = String(this.taxCode).replace(/\s+/g, '').trim();
  }
});

module.exports = mongoose.model('TaxProfile', taxProfileSchema);