// backend/src/models/Penalty.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

// ═════════════════════════════════════════════════════════════════════════
// Bậc cho khung giờ trễ — vd: trễ ≤5p → 50k, ≤10p → 100k, ≤15p → 200k
// ═════════════════════════════════════════════════════════════════════════
const TimeWindowTierSchema = new Schema(
  {
    upToMinutes: { type: Number, required: true, min: 0 }, // trễ đến X phút
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

// ═════════════════════════════════════════════════════════════════════════
// Bậc cho số lần vi phạm — vd: Lần 1: 0k, Lần 2: 20k, Lần 3: 50k
// ═════════════════════════════════════════════════════════════════════════
const RepeatCountTierSchema = new Schema(
  {
    occurrence: { type: Number, required: true, min: 1 }, // lần thứ N
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

// ═════════════════════════════════════════════════════════════════════════
// Penalty (catalog) — định nghĩa loại phạt
// ═════════════════════════════════════════════════════════════════════════
const PenaltySchema = new Schema(
  {
    branchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },

    // 3 khung phạt
    type: {
      type: String,
      enum: ['fixed', 'time_window', 'repeat_count'],
      required: true,
      default: 'fixed',
    },

    // type='fixed' — số tiền cố định
    fixedAmount: { type: Number, default: 0, min: 0 },

    // type='time_window' — bậc theo phút trễ
    timeWindowTiers: { type: [TimeWindowTierSchema], default: [] },

    // type='repeat_count' — bậc theo số lần
    repeatCountTiers: { type: [RepeatCountTierSchema], default: [] },

    // Mức độ nghiêm trọng — để GOM NHÓM HIỂN THỊ (không ảnh hưởng tiền)
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },

    // ⭐ Tự động áp dụng khi NV checkin trễ?
    // Nếu true → khi NV checkin với lateMinutes > 0, hệ thống tự tạo PenaltyRecord
    autoApplyOnLate: { type: Boolean, default: false },

    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

PenaltySchema.index({ branchId: 1, isActive: 1, severity: 1 });
PenaltySchema.index({ branchId: 1, autoApplyOnLate: 1 });

// ═════════════════════════════════════════════════════════════════════════
// PenaltyRecord — lần phạt thực tế
// ═════════════════════════════════════════════════════════════════════════
const PenaltyRecordSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

    year: { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },

    penaltyId: { type: Schema.Types.ObjectId, ref: 'Penalty' },
    penaltyName: { type: String, required: true },
    penaltyType: { type: String, enum: ['fixed', 'time_window', 'repeat_count'] },
    severity: { type: String, default: 'medium' },

    // Chi tiết
    minutes: { type: Number, default: 0 }, // dùng cho time_window
    occurrence: { type: Number, default: 0 }, // dùng cho repeat_count
    appliedTier: {
      upToMinutes: Number,
      occurrence: Number,
      amount: Number,
    },

    amount: { type: Number, required: true, min: 0 },

    occurredOn: { type: Date },
    reason: { type: String, default: '' },
    note: { type: String, default: '' },

    // ⭐ Liên kết Attendance (nếu phạt do auto từ checkin)
    attendanceId: { type: Schema.Types.ObjectId, ref: 'Attendance', default: null },
    autoCreated: { type: Boolean, default: false },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

PenaltyRecordSchema.index({ user: 1, year: 1, month: 1 });
PenaltyRecordSchema.index({ attendanceId: 1 });

const Penalty = mongoose.model('Penalty', PenaltySchema);
const PenaltyRecord = mongoose.model('PenaltyRecord', PenaltyRecordSchema);

module.exports = { Penalty, PenaltyRecord };