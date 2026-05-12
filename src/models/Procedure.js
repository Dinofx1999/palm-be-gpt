// ⭐ NEW 13/05/2026: Procedure model v2
// THAY ĐỔI v1 → v2:
// - position: String  →  positions: [String]  (multi-position)
// - 1 quy trình có thể áp dụng cho NHIỀU vị trí (vd: Lễ tân + Buồng phòng + Manager)
// - Admin: bypass mọi filter
// - Manager: thấy tất cả quy trình trong branch
// - NV (Staff/Receptionist): chỉ thấy quy trình có positions chứa vị trí của mình

const mongoose = require('mongoose');

const StepSchema = new mongoose.Schema({
  order:    { type: Number, default: 0 },
  title:    { type: String, required: true, trim: true, maxlength: 200 },
  content:  { type: String, default: '', maxlength: 5000 },
  imageUrl: { type: String, default: '' },
}, { _id: true });

const ProcedureSchema = new mongoose.Schema({
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
    maxlength: 200,
  },
  // ⭐ CHANGED: positions thay vì position (array thay vì string)
  positions: {
    type: [String],
    default: [],
    validate: {
      validator: (arr) => Array.isArray(arr) && arr.length > 0,
      message: 'Cần ít nhất 1 vị trí áp dụng',
    },
    // VD: ['Lễ tân', 'Manager'] hoặc ['Lễ tân', 'Buồng phòng', 'Manager']
  },
  category: {
    type: String,
    enum: ['checklist', 'sop'],
    default: 'sop',
  },
  description: {
    type: String,
    default: '',
    maxlength: 2000,
  },
  steps: {
    type: [StepSchema],
    default: [],
  },
  status: {
    type: String,
    enum: ['active', 'archived'],
    default: 'active',
    index: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, {
  timestamps: true,
});

// Index để query theo branch + positions + status nhanh
ProcedureSchema.index({ branchId: 1, positions: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Procedure', ProcedureSchema);