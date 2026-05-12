const mongoose = require('mongoose');

// ⭐ NEW 12/05/2026: Vị trí tuyển dụng — Admin/Manager tạo per chi nhánh
const jobPostingSchema = new mongoose.Schema({
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 150,
  },
  position: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80,
    // Vd: "Lễ tân", "Buồng phòng", "Bếp", "Quản lý", "Bảo vệ", ...
  },
  description: {
    type: String,
    default: '',
    maxlength: 5000,
  },
  requirements: {
    type: String,
    default: '',
    maxlength: 3000,
  },
  benefits: {
    type: String,
    default: '',
    maxlength: 3000,
  },
  salaryMin: {
    type: Number,
    default: 0,
    min: 0,
  },
  salaryMax: {
    type: Number,
    default: 0,
    min: 0,
  },
  workType: {
    type: String,
    enum: ['fulltime', 'parttime', 'shift', 'contract'],
    default: 'fulltime',
  },
  status: {
    type: String,
    enum: ['active', 'closed'],
    default: 'active',
    index: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, {
  timestamps: true,
});

// Index để query nhanh per branch + status
jobPostingSchema.index({ branchId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('JobPosting', jobPostingSchema);