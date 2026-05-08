// backend/src/models/WorkShift.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const WorkShiftSchema = new Schema(
  {
    branchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true }, // "Ca 1", "Ca sáng"...

    // Giờ bắt đầu/kết thúc dạng HH:mm (string để dễ làm việc)
    startTime: { type: String, required: true }, // "07:00"
    endTime: { type: String, required: true },   // "15:00"

    // Ca qua đêm (vd 23:00 → 07:00 hôm sau)
    crossesMidnight: { type: Boolean, default: false },

    // ⭐ Penalty áp dụng khi NV checkin trễ ca này
    // (tham chiếu Penalty với autoApplyOnLate=true)
    latePenaltyId: {
      type: Schema.Types.ObjectId,
      ref: 'Penalty',
      default: null,
    },

    // Cho phép trễ X phút mà không phạt (ân hạn)
    graceMinutes: { type: Number, default: 0, min: 0 },

    // Order khi hiển thị (Ca 1 trước Ca 2)
    sortOrder: { type: Number, default: 0 },

    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

WorkShiftSchema.index({ branchId: 1, isActive: 1, sortOrder: 1 });

module.exports = mongoose.model('WorkShift', WorkShiftSchema);