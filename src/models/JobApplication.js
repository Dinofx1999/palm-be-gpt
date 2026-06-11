const mongoose = require('mongoose');

// ⭐ NEW 12/05/2026: Hồ sơ ứng viên ứng tuyển công việc
const jobApplicationSchema = new mongoose.Schema({
  jobPostingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'JobPosting',
    required: true,
    index: true,
  },
  // Denormalize branchId để filter nhanh không cần $lookup
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    index: true,
  },
  fullName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
  },
  birthDate: {
    type: Date,
  },
  phone: {
    type: String,
    required: true,
    trim: true,
    maxlength: 20,
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    maxlength: 100,
  },
  currentAddress: {
    type: String,
    trim: true,
    maxlength: 300,
  },
  photoUrl: {
    type: String,
    default: '',
    // Path tương đối: /uploads/careers/photo-xxx.jpg
  },
  notes: {
    type: String,
    default: '',
    maxlength: 1000,
    // Ứng viên tự nhập (vd: "Có kinh nghiệm 2 năm")
  },
  status: {
    type: String,
    enum: ['new', 'reviewing', 'interviewing', 'hired', 'rejected'],
    default: 'new',
    index: true,
  },
  reviewNote: {
    type: String,
    default: '',
    maxlength: 2000,
    // Admin/Manager ghi chú nội bộ (vd: "Đã gọi hẹn pv 14h thứ 3")
  },
  // ⭐ NEW 30/05/2026: Lịch hẹn phỏng vấn
  //   - interviewAt: thời điểm hẹn (Date). null = chưa lên lịch.
  //   - interviewLocation: địa điểm / ghi chú phỏng vấn (vd "Văn phòng tầng 2" / "Online qua Zoom")
  //   - interviewReminderSent: đã gửi nhắc trước giờ chưa (chống gửi trùng — dùng ở Phần 4)
  interviewAt: {
    type: Date,
    default: null,
  },
  interviewLocation: {
    type: String,
    default: '',
    maxlength: 500,
  },
  interviewReminderSent: {
    type: Boolean,
    default: false,
  },
  // ⭐ Cấu hình nhắc trước giờ phỏng vấn
  //   - reminderMinutesBefore: số phút trước giờ để nhắc (null/0 = tắt nhắc)
  //   - notifyTelegram: có gửi Telegram cho nhà tuyển dụng không
  interviewReminderMinutes: {
    type: Number,
    default: 60,   // mặc định nhắc trước 1 tiếng
  },
  interviewNotifyTelegram: {
    type: Boolean,
    default: true,
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  reviewedAt: {
    type: Date,
  },
  // Anti-spam: IP để rate-limit + tra cứu
  sourceIp: {
    type: String,
    default: '',
    maxlength: 64,
  },
  userAgent: {
    type: String,
    default: '',
    maxlength: 500,
  },
}, {
  timestamps: true,
});

// Index compound để query list nhanh (filter + sort theo createdAt desc)
jobApplicationSchema.index({ branchId: 1, status: 1, createdAt: -1 });
jobApplicationSchema.index({ jobPostingId: 1, createdAt: -1 });
// ⭐ Index quét lịch phỏng vấn sắp tới (nhắc trước giờ)
jobApplicationSchema.index({ interviewAt: 1, interviewReminderSent: 1 });

module.exports = mongoose.model('JobApplication', jobApplicationSchema);