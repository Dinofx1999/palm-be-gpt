// backend/src/models/ShiftCounter.js
//
// ⭐ NEW 15/05/2026: Counter ca theo branch
//   Mỗi branch tự đánh số tăng dần: #1, #2, #3, ...
//   Atomic increment qua findOneAndUpdate(... $inc, upsert)
//
const mongoose = require('mongoose');

const ShiftCounterSchema = new mongoose.Schema({
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    unique: true,
    index: true,
  },
  // Số ca cuối cùng đã cấp (next = lastNumber + 1)
  lastNumber: {
    type: Number,
    default: 0,
    min: 0,
  },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

/**
 * Lấy số tiếp theo cho branch — atomic
 * @param {ObjectId|String} branchId
 * @returns {Promise<Number>} Số ca mới (#N)
 */
ShiftCounterSchema.statics.getNext = async function (branchId) {
  const doc = await this.findOneAndUpdate(
    { branchId },
    { $inc: { lastNumber: 1 }, $set: { updatedAt: new Date() } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return doc.lastNumber;
};

module.exports = mongoose.model('ShiftCounter', ShiftCounterSchema);