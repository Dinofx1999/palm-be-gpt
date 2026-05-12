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

module.exports = mongoose.model('JobApplication', jobApplicationSchema);