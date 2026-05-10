// backend/src/models/Attendance.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const AttendanceSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    shift: { type: Schema.Types.ObjectId, ref: 'WorkShift', required: true },
    shiftName: { type: String },

    // Ngày làm việc (YYYY-MM-DD)
    workDate: { type: String, required: true, index: true },

    // Giờ shift theo lịch (snapshot)
    shiftStartTime: { type: String, required: true },
    shiftEndTime: { type: String },

    // ─── Checkin ────────────────────────────────────────────────
    checkInAt: { type: Date, required: true, default: Date.now },
    lateMinutes: { type: Number, default: 0, min: 0 },

    // GPS audit cho checkin
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    distanceMeters: { type: Number, default: null },
    ipAddress: { type: String, default: '' },
    userAgent: { type: String, default: '' },

    // ─── Checkout ───────────────────────────────────────────────
    checkOutAt: { type: Date, default: null },

    // ⭐ THÊM: GPS audit cho checkout
    checkOutLatitude: { type: Number, default: null },
    checkOutLongitude: { type: Number, default: null },
    checkOutDistanceMeters: { type: Number, default: null },
    checkOutIpAddress: { type: String, default: '' },
    checkOutUserAgent: { type: String, default: '' },

    // ⭐ THÊM: Số phút làm việc (computed khi checkout)
    workedMinutes: { type: Number, default: 0 },

    // ─── Phạt trễ ───────────────────────────────────────────────
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

// 1 NV chỉ được checkin 1 ca/ngày
AttendanceSchema.index({ user: 1, workDate: 1 }, { unique: true });
// 1 ca / 1 NV / ngày
AttendanceSchema.index({ shift: 1, workDate: 1 });

module.exports = mongoose.model('Attendance', AttendanceSchema);