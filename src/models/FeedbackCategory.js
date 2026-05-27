// backend/src/models/FeedbackCategory.js
// ════════════════════════════════════════════════════════════════════
// Hạng mục đánh giá (Nhân viên / Phòng / Giá cả / Vệ sinh / Buffet ...).
// Admin/Manager CRUD. Mỗi category có `key` (định danh) + `label` (hiển thị).
// Khách đánh giá 1-5* cho từng category được active.
// ════════════════════════════════════════════════════════════════════
const mongoose = require('mongoose');

const feedbackCategorySchema = new mongoose.Schema({
  key:    { type: String, required: true, unique: true, trim: true, lowercase: true },
  label:  { type: String, required: true, trim: true },
  order:  { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

feedbackCategorySchema.index({ active: 1, order: 1 });

module.exports = mongoose.model('FeedbackCategory', feedbackCategorySchema);