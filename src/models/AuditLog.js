const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  // Đối tượng được tác động
  entityType: {
    type: String,
    enum: ['Booking', 'Invoice', 'Service', 'BookingService', 'Customer', 'Room', 'PricePolicy', 'Branch', 'User'],
    required: true,
    index: true,
  },
  entityId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

  // Hành động
  action:     { type: String, required: true },     // VD: 'create', 'update', 'checkin', 'checkout', 'cancel', 'add_service', 'remove_service', 'apply_discount', 'payment', 'refund'
  description: { type: String, default: '' },        // Mô tả ngắn cho user đọc

  // User thực hiện
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  userName:   { type: String, default: '' },         // Cache để tránh phải populate mỗi lần đọc
  userEmail:  { type: String, default: '' },

  // Context bổ sung (vd phòng số, mã HĐ, số tiền...)
  metadata:   { type: mongoose.Schema.Types.Mixed, default: {} },

  // Snapshot before/after (optional, chỉ lưu cho thao tác quan trọng)
  before:     { type: mongoose.Schema.Types.Mixed, default: null },
  after:      { type: mongoose.Schema.Types.Mixed, default: null },

  // Branch để filter
  branchId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
}, { timestamps: true });

// Index compound để tìm logs theo entity nhanh
auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ branchId: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);