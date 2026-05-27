// backend/src/models/Feedback.js
// ════════════════════════════════════════════════════════════════════
// Góp ý của khách hàng — gửi public (không cần auth).
// Tự liên kết với Booking qua SĐT + số phòng + ngày lưu trú gần nhất (30 ngày).
// ════════════════════════════════════════════════════════════════════
const mongoose = require('mongoose');

// Điểm đánh giá cho 1 hạng mục: { categoryKey, score 1-5 }
const ratingItemSchema = new mongoose.Schema({
  categoryKey: { type: String, required: true, lowercase: true, trim: true },
  score:       { type: Number, required: true, min: 1, max: 5 },
}, { _id: false });

const feedbackSchema = new mongoose.Schema({
  branchId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },

  // Thông tin khách
  customerName:   { type: String, default: '', trim: true, maxlength: 100 },
  phone:          { type: String, required: true, trim: true, maxlength: 20, index: true },
  roomNumber:     { type: String, required: true, trim: true, maxlength: 20 },
  email:          { type: String, default: '', trim: true, lowercase: true, maxlength: 200 },

  // Liên kết booking (tự dò từ phone + roomNumber + stayDate)
  bookingCode:    { type: String, default: '', trim: true },                              // khách tự nhập (nếu có)
  bookingId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null }, // server tự link
  stayDate:       { type: Date, default: null },                                          // ngày lưu trú (khách nhập)

  // Đánh giá
  ratings:        { type: [ratingItemSchema], default: [] },          // 1-5* từng hạng mục
  overallRating:  { type: Number, min: 1, max: 5, default: null },    // 1-5* tổng (optional)
  wouldRecommend: { type: Boolean, default: null },                   // NPS — null/true/false
  content:        { type: String, default: '', trim: true, maxlength: 3000 },

  // Xử lý nội bộ
  status:         { type: String, enum: ['new', 'read', 'resolved', 'spam'], default: 'new', index: true },
  staffReply:     { type: String, default: '', trim: true, maxlength: 3000 }, // ghi chú nhân viên (nội bộ)
  repliedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  repliedAt:      { type: Date, default: null },

  // Audit
  sourceIp:       { type: String, default: '', maxlength: 64 },
  userAgent:      { type: String, default: '', maxlength: 500 },
}, { timestamps: true });

// Index cho list/filter nhanh
feedbackSchema.index({ branchId: 1, createdAt: -1 });
feedbackSchema.index({ branchId: 1, status: 1, createdAt: -1 });

// Helper: lấy điểm trung bình (dùng để gắn cờ rating thấp)
feedbackSchema.virtual('avgScore').get(function () {
  if (this.overallRating) return this.overallRating;
  if (!this.ratings?.length) return null;
  const sum = this.ratings.reduce((a, b) => a + (b.score || 0), 0);
  return Math.round((sum / this.ratings.length) * 10) / 10;
});

feedbackSchema.set('toJSON', { virtuals: true });
feedbackSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Feedback', feedbackSchema);