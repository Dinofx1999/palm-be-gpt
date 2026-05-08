// backend/src/models/Attendance.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const AttendanceSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    shift: { type: Schema.Types.ObjectId, ref: 'WorkShift', required: true },
    shiftName: { type: String }, // snapshot tên ca

    // Ngày làm việc (YYYY-MM-DD lưu dạng string để index dễ)
    workDate: { type: String, required: true, index: true }, // "2026-05-08"

    // Giờ shift theo lịch (snapshot)
    shiftStartTime: { type: String, required: true }, // "07:00"
    shiftEndTime: { type: String },                    // "15:00"

    // Checkin
    checkInAt: { type: Date, required: true, default: Date.now },
    lateMinutes: { type: Number, default: 0, min: 0 },

    // Checkout (optional, có thể bổ sung sau)
    checkOutAt: { type: Date, default: null },

    // ⭐ GPS audit
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    distanceMeters: { type: Number, default: null }, // khoảng cách đến branch
    ipAddress: { type: String, default: '' },
    userAgent: { type: String, default: '' },

    // ⭐ Liên kết PenaltyRecord nếu auto tạo phạt trễ
    penaltyRecordId: { type: Schema.Types.ObjectId, ref: 'PenaltyRecord', default: null },

    // Manager có thể xóa phạt nếu có lý do
    waiveLatePenalty: { type: Boolean, default: false },
    waivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    waivedReason: { type: String, default: '' },
    waivedAt: { type: Date, default: null },

    note: { type: String, default: '' },
  },
  { timestamps: true }
);

// 1 NV chỉ được checkin 1 ca/ngày → unique constraint
AttendanceSchema.index({ user: 1, workDate: 1 }, { unique: true });
// 1 ca chỉ có 1 NV → cũng unique theo workDate + shift (nếu policy 1 NV / ca)
AttendanceSchema.index({ shift: 1, workDate: 1 });

module.exports = mongoose.model('Attendance', AttendanceSchema);