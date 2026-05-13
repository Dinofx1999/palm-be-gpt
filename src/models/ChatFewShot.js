// backend/src/models/ChatFewShot.js
// ============================================================
// Schema lưu các ví dụ few-shot để inject vào system prompt
// Mỗi example dạy AI cách trả lời 1 kiểu câu hỏi
// ============================================================

const mongoose = require('mongoose');

const chatFewShotSchema = new mongoose.Schema({
  // Category để filter (vd "booking", "pricing", "image", "general")
  category: {
    type: String,
    required: true,
    enum: ['booking', 'pricing', 'image', 'revenue', 'customer', 'general'],
    default: 'general',
    index: true,
  },

  // Tiêu đề ngắn để admin dễ tìm (vd "Tư vấn đoàn 15+ người")
  title:        { type: String, required: true },

  // Pattern câu hỏi (mô tả ngắn, dùng để match keyword)
  // Vd "đoàn đông người", "phụ thu CI sớm"
  pattern:      { type: String, default: '' },

  // Mẫu câu user gõ
  userInput:    { type: String, required: true },

  // Câu trả lời mẫu mong muốn
  assistantOutput: { type: String, required: true },

  // ⭐ Priority: ví dụ quan trọng hơn được ưu tiên load
  //   0 = thường, 10 = critical (luôn load)
  priority:     { type: Number, default: 5, index: true },

  // Active hay không
  isActive:     { type: Boolean, default: true, index: true },

  // Áp dụng cho branch nào (null = tất cả)
  branchId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },

  // Source: tạo thủ công hay từ feedback
  source: {
    type: String,
    enum: ['manual', 'from_feedback', 'seed'],
    default: 'manual',
  },

  // Nếu được tạo từ feedback → link
  sourceFeedbackId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatFeedback',
    default: null,
  },

  // Thống kê: bao nhiêu lần đã được dùng (để biết example nào quan trọng)
  usageCount:   { type: Number, default: 0 },

  // Admin tạo
  createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

chatFewShotSchema.index({ category: 1, isActive: 1, priority: -1 });

module.exports = mongoose.model('ChatFewShot', chatFewShotSchema);