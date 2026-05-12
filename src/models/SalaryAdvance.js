// backend/src/models/SalaryAdvance.js
//
// ⭐ NEW 11/05/2026: Model lương ứng
//   - Mỗi NV ứng nhiều lần trong tháng
//   - Giới hạn theo % tổng cố định (config ở Branch.advanceMaxPercent)
//   - Trừ vào "Tổng nhận" khi tính lương
//
// Convention: dùng `user` (giống SalaryConfig/SalaryRecord/PenaltyRecord)
//
const mongoose = require('mongoose');

const salaryAdvanceSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    index: true,
  },
  year:  { type: Number, required: true },
  month: { type: Number, required: true, min: 1, max: 12 },

  amount: { type: Number, required: true, min: 0 },
  reason: { type: String, default: '', maxlength: 500 },

  paymentMethod: {
    type: String,
    enum: ['cash', 'transfer'],
    default: 'cash',
  },
  note: { type: String, default: '', maxlength: 500 },

  advancedAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, {
  timestamps: true,
});

// Compound index: query nhanh theo NV + tháng
salaryAdvanceSchema.index({ user: 1, year: 1, month: 1 });
salaryAdvanceSchema.index({ branchId: 1, year: 1, month: 1 });

// Helper: tính tổng ứng của 1 NV trong 1 tháng
salaryAdvanceSchema.statics.totalForMonth = async function (userId, year, month) {
  const result = await this.aggregate([
    { $match: {
      user: new mongoose.Types.ObjectId(userId),
      year: Number(year),
      month: Number(month),
    } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return result[0]?.total ?? 0;
};

module.exports = mongoose.model('SalaryAdvance', salaryAdvanceSchema);