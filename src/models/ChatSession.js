// backend/src/models/ChatSession.js
// ============================================================
// Phiên chat (1 user có nhiều phiên)
// Mỗi phiên là 1 cuộc trò chuyện với AI Palm PMS
// ============================================================

const mongoose = require('mongoose');

const ChatSessionSchema = new mongoose.Schema({
  // ⭐ User sở hữu phiên này (nhân viên khách sạn)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  // ⭐ Lưu tên + role thời điểm chat (để admin xem không cần join)
  userName: { type: String, default: '' },
  userRole: { type: String, default: '' },

  // ⭐ Chi nhánh
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    index: true,
  },
  branchName: { type: String, default: '' },

  // ⭐ Tiêu đề (auto từ tin nhắn đầu hoặc user đổi tên)
  title: {
    type: String,
    default: 'Cuộc trò chuyện mới',
    maxlength: 200,
  },

  // ⭐ Thống kê
  messageCount: { type: Number, default: 0 },
  totalTokensUsed: { type: Number, default: 0 },
  estimatedCostVND: { type: Number, default: 0 },

  // ⭐ Tin nhắn cuối (preview cho list)
  lastMessageText: { type: String, default: '', maxlength: 300 },
  lastMessageAt: { type: Date, default: Date.now },

  // ⭐ Flag
  isArchived: { type: Boolean, default: false },
  isPinned: { type: Boolean, default: false },
}, {
  timestamps: true,    // createdAt, updatedAt tự động
});

// ⭐ Indexes cho query nhanh
ChatSessionSchema.index({ userId: 1, lastMessageAt: -1 });
ChatSessionSchema.index({ branchId: 1, lastMessageAt: -1 });
ChatSessionSchema.index({ lastMessageAt: -1 });
// ⭐ TTL index: tự xoá sau 90 ngày kể từ lastMessageAt
//   (mongoose chỉ scan mỗi 60s, không cần lo perf)
//   Có thể tắt bằng cách comment dòng dưới
ChatSessionSchema.index({ lastMessageAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('ChatSession', ChatSessionSchema);