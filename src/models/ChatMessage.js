// backend/src/models/ChatMessage.js
// ============================================================
// Từng tin nhắn trong 1 phiên chat
// Mỗi tin nhắn 1 record để dễ phân tích + xoá selective
// ============================================================

const mongoose = require('mongoose');

const ToolCallSchema = new mongoose.Schema({
  name:   { type: String, required: true },     // vd 'check_specific_room'
  args:   { type: mongoose.Schema.Types.Mixed }, // params truyền vào tool
  result: { type: mongoose.Schema.Types.Mixed }, // kết quả tool trả về (truncate nếu lớn)
  error:  { type: String, default: null },
  durationMs: { type: Number, default: 0 },
}, { _id: false });

const ChatMessageSchema = new mongoose.Schema({
  // ⭐ Reference
  sessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatSession',
    required: true,
    index: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    index: true,
  },

  // ⭐ Vai trò: user gửi hoặc assistant trả
  role: {
    type: String,
    enum: ['user', 'assistant', 'system'],
    required: true,
  },

  // ⭐ Nội dung tin nhắn
  text: {
    type: String,
    required: true,
    maxlength: 10000,        // Cắt nếu > 10k chars để tránh phình DB
  },

  // ⭐ Tools (chỉ assistant message mới có)
  toolCalls: { type: [ToolCallSchema], default: [] },

  // ⭐ Token usage (cost tracking)
  tokensUsed: {
    prompt:        { type: Number, default: 0 },
    cached:        { type: Number, default: 0 },
    output:        { type: Number, default: 0 },
    total:         { type: Number, default: 0 },
    cacheHitRate:  { type: Number, default: 0 },   // % cached / prompt
    estimatedCostVND: { type: Number, default: 0 },
  },

  // ⭐ Meta
  modelUsed: { type: String, default: '' },        // vd 'gemini-2.5-flash'
  iterations: { type: Number, default: 0 },        // số vòng tool calling

  // ⭐ Feedback từ user (thumbs up/down)
  feedback: {
    type: String,
    enum: [null, 'up', 'down'],
    default: null,
  },
  feedbackNote: { type: String, default: '' },

  // ⭐ Cho frontend tham chiếu (UUID generate ở backend khi response)
  messageId: { type: String, unique: true, sparse: true, index: true },

}, {
  timestamps: true,
});

// ⭐ Indexes
ChatMessageSchema.index({ sessionId: 1, createdAt: 1 });   // Load messages của 1 session theo thứ tự
ChatMessageSchema.index({ userId: 1, createdAt: -1 });
ChatMessageSchema.index({ createdAt: -1 });
// ⭐ TTL: auto-xoá sau 90 ngày
ChatMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// ⭐ Helper: tính cost ước tính từ token (Gemini 2.5 Flash pricing)
//   Input: $0.30/1M = ~7.5đ/1k token
//   Output: $2.50/1M = ~62.5đ/1k token
//   Cached input: $0.075/1M = ~1.9đ/1k token
ChatMessageSchema.statics.calcCostVND = function(usage) {
  const nonCachedPrompt = (usage.prompt || 0) - (usage.cached || 0);
  const cached = usage.cached || 0;
  const output = usage.output || 0;

  const cost = (nonCachedPrompt * 7.5 / 1000)
             + (cached * 1.9 / 1000)
             + (output * 62.5 / 1000);
  return Math.round(cost);
};

module.exports = mongoose.model('ChatMessage', ChatMessageSchema);