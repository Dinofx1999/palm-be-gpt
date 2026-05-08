// backend/src/models/Penalty.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────
// 1) Severity tier — bậc mức độ nghiêm trọng (cho type "tiered")
// ─────────────────────────────────────────────────────────────────────────
const SeverityTierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true }, // "Nhẹ", "Vừa", "Nghiêm trọng"
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────
// 2) Penalty — danh mục các loại phạt (per branch)
// ─────────────────────────────────────────────────────────────────────────
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

    // 3 loại phạt
    type: {
      type: String,
      enum: ['fixed', 'per_minute', 'tiered'],
      required: true,
      default: 'fixed',
    },

    // Khi type = 'fixed' — số tiền cố định
    fixedAmount: { type: Number, default: 0, min: 0 },

    // Khi type = 'per_minute' — tính theo phút
    perMinuteAmount: { type: Number, default: 0, min: 0 },
    maxAmount: { type: Number, default: 0, min: 0 }, // 0 = không giới hạn

    // Khi type = 'tiered' — danh sách bậc mức độ
    severityTiers: { type: [SeverityTierSchema], default: [] },

    // Phân loại để gom nhóm (UI)
    category: {
      type: String,
      enum: ['punctuality', 'appearance', 'service', 'discipline', 'other'],
      default: 'other',
    },

    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

PenaltySchema.index({ branchId: 1, isActive: 1, name: 1 });

// ─────────────────────────────────────────────────────────────────────────
// 3) PenaltyRecord — lần phạt thực tế của 1 NV trong 1 tháng
// ─────────────────────────────────────────────────────────────────────────
const PenaltyRecordSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },

    // Kỳ áp dụng
    year: { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },

    // Tham chiếu đến danh mục phạt
    penaltyId: { type: Schema.Types.ObjectId, ref: 'Penalty' },

    // Snapshot info từ Penalty (lưu lại đề phòng penalty bị xóa)
    penaltyName: { type: String, required: true },
    penaltyType: { type: String, enum: ['fixed', 'per_minute', 'tiered'] },
    category: { type: String, default: 'other' },

    // Chi tiết tùy theo type
    minutes: { type: Number, default: 0 }, // dùng cho per_minute
    severityName: { type: String, default: '' }, // dùng cho tiered
    perMinuteAmount: { type: Number, default: 0 }, // snapshot rate khi tạo

    // Số tiền phạt cuối cùng
    amount: { type: Number, required: true, min: 0 },

    // Metadata
    occurredOn: { type: Date }, // ngày xảy ra (không bắt buộc)
    reason: { type: String, default: '' },
    note: { type: String, default: '' },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

PenaltyRecordSchema.index({ user: 1, year: 1, month: 1 });

const Penalty = mongoose.model('Penalty', PenaltySchema);
const PenaltyRecord = mongoose.model('PenaltyRecord', PenaltyRecordSchema);

module.exports = { Penalty, PenaltyRecord };