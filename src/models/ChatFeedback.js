// backend/src/models/ChatFeedback.js
// ============================================================
// Schema lưu feedback 👍/👎 từ user về câu trả lời của AI
// ============================================================

const mongoose = require('mongoose');

const chatFeedbackSchema = new mongoose.Schema({
  // ID của session chat (từ localStorage)
  sessionId:   { type: String, required: true, index: true },

  // ID của message AI bị feedback (frontend tự generate)
  messageId:   { type: String, required: true },

  // Câu hỏi của user dẫn tới câu trả lời này
  userQuestion: { type: String, required: true },

  // Câu trả lời của AI
  aiAnswer:    { type: String, required: true },

  // Rating: 1 = 👍, -1 = 👎
  rating:      { type: Number, required: true, enum: [1, -1], index: true },

  // Lý do (optional, user gõ nếu muốn)
  reason:      { type: String, default: '' },

  // Context tại thời điểm feedback
  userRole:    { type: String, default: 'Receptionist' },
  branchId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  branchName:  { type: String, default: '' },
  modelUsed:   { type: String, default: '' },

  // ⭐ Trạng thái xử lý của Admin
  status: {
    type: String,
    enum: ['pending', 'reviewed', 'converted', 'dismissed'],
    default: 'pending',
    index: true,
  },

  // Nếu đã convert thành few-shot, link tới ID
  convertedToFewShotId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatFewShot',
    default: null,
  },

  // Admin note
  adminNote:   { type: String, default: '' },
  reviewedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt:  { type: Date, default: null },

  // User submit (lấy từ JWT nếu có)
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

chatFeedbackSchema.index({ rating: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ChatFeedback', chatFeedbackSchema);