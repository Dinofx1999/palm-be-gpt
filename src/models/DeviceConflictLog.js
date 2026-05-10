// backend/src/models/DeviceConflictLog.js
//
// Log mọi hành động liên quan device binding:
//   - resolution: 'allowed' = pass (máy mới hoặc máy quen)
//   - resolution: 'blocked' = bị chặn vì conflict với user khác
//   - resolution: 'pending' = chờ Admin xử lý thủ công (chưa dùng tới)
//
const mongoose = require('mongoose');

const deviceConflictLogSchema = new mongoose.Schema({
  // User đang cố gắng dùng device
  attemptedUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },

  // Device ID gây conflict
  deviceId: { type: String, required: true, index: true },
  userAgent: { type: String, default: '' },

  // User đang owning device này (đã có trong knownDevices)
  // null = máy mới chưa ai dùng
  conflictWithUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },

  // Hành động xảy ra ở đâu
  action: {
    type: String,
    enum: ['login', 'checkin'],
    required: true,
  },

  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    index: true,
  },

  ip: { type: String, default: '' },

  // Admin xử lý
  resolved: { type: Boolean, default: false, index: true },
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  resolvedAt: { type: Date, default: null },
  resolvedNote: { type: String, default: '' },
  resolution: {
    type: String,
    enum: ['allowed', 'blocked', 'pending'],
    default: 'pending',
  },
}, { timestamps: true });

// Index compound cho query phổ biến
deviceConflictLogSchema.index({ attemptedUser: 1, createdAt: -1 });
deviceConflictLogSchema.index({ branchId: 1, resolved: 1, createdAt: -1 });

module.exports = mongoose.model('DeviceConflictLog', deviceConflictLogSchema);