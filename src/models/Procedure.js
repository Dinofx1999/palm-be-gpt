// ⭐ NEW 13/05/2026: Procedure model v2
// ⭐ UPDATED 30/05/2026: v3 — mỗi STEP hỗ trợ NHIỀU ẢNH (imageUrls[]).
// THAY ĐỔI v2 → v3:
// - StepSchema: imageUrl: String  →  imageUrls: [String]  (nhiều ảnh/bước)
// - Giữ TƯƠNG THÍCH NGƯỢC: vẫn đọc/ghi được imageUrl cũ (virtual + migrate mềm)
//
// THAY ĐỔI v1 → v2:
// - position: String  →  positions: [String]  (multi-position)
// - 1 quy trình có thể áp dụng cho NHIỀU vị trí
// - Admin: bypass mọi filter; Manager: thấy tất cả trong branch;
//   NV: chỉ thấy quy trình có positions chứa vị trí của mình

const mongoose = require('mongoose');

const StepSchema = new mongoose.Schema({
  order:    { type: Number, default: 0 },
  title:    { type: String, required: true, trim: true, maxlength: 200 },
  content:  { type: String, default: '', maxlength: 5000 },
  // ⭐ CHANGED v3: nhiều ảnh mỗi bước. Giới hạn mềm 20 ảnh/bước.
  imageUrls: {
    type: [String],
    default: [],
    validate: {
      validator: (arr) => Array.isArray(arr) && arr.length <= 20,
      message: 'Tối đa 20 ảnh mỗi bước',
    },
  },
}, { _id: true });

// ── Tương thích ngược với field cũ "imageUrl" (1 ảnh) ──────────────────
// Khi đọc: imageUrl = ảnh đầu tiên trong imageUrls.
StepSchema.virtual('imageUrl').get(function () {
  return this.imageUrls && this.imageUrls.length ? this.imageUrls[0] : '';
});
// Khi ghi: nếu code/dữ liệu cũ set imageUrl (1 chuỗi) → đẩy vào imageUrls.
StepSchema.virtual('imageUrl').set(function (v) {
  if (typeof v === 'string' && v.trim()) {
    if (!Array.isArray(this.imageUrls)) this.imageUrls = [];
    if (!this.imageUrls.includes(v)) this.imageUrls.unshift(v);
  }
});
StepSchema.set('toJSON', { virtuals: true });
StepSchema.set('toObject', { virtuals: true });

const ProcedureSchema = new mongoose.Schema({
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200,
  },
  // ⭐ v2: positions (array thay vì string)
  positions: {
    type: [String],
    default: [],
    validate: {
      validator: (arr) => Array.isArray(arr) && arr.length > 0,
      message: 'Cần ít nhất 1 vị trí áp dụng',
    },
  },
  category: {
    type: String,
    enum: ['checklist', 'sop'],
    default: 'sop',
  },
  description: {
    type: String,
    default: '',
    maxlength: 2000,
  },
  steps: {
    type: [StepSchema],
    default: [],
  },
  status: {
    type: String,
    enum: ['active', 'archived'],
    default: 'active',
    index: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, {
  timestamps: true,
});

ProcedureSchema.index({ branchId: 1, positions: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Procedure', ProcedureSchema);