// backend/src/models/FeedbackBlock.js
// ════════════════════════════════════════════════════════════════════
// Chặn SĐT spam góp ý. Admin/Manager thêm — khi gửi feedback, server check
// nếu SĐT có trong danh sách này → từ chối (vẫn trả 200 để spammer không biết).
// ════════════════════════════════════════════════════════════════════
const mongoose = require('mongoose');

const feedbackBlockSchema = new mongoose.Schema({
  phone:     { type: String, required: true, unique: true, trim: true, maxlength: 20, index: true },
  reason:    { type: String, default: '', trim: true, maxlength: 500 },
  blockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

module.exports = mongoose.model('FeedbackBlock', feedbackBlockSchema);