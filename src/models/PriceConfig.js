const mongoose = require('mongoose');

const priceConfigSchema = new mongoose.Schema({
  roomTypeId:   { type: mongoose.Schema.Types.ObjectId, ref: 'RoomType', required: true },
  roomTypeName: { type: String, required: true },
  priceType:    { type: String, enum: ['day', 'overnight', 'hour', 'holiday'], required: true },
  price:        { type: Number, required: true },
  unit:         { type: String, default: 'đêm' },
  branchId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  note:         { type: String, default: '' },
}, { timestamps: true });

priceConfigSchema.index({ roomTypeId: 1, priceType: 1, branchId: 1 }, { unique: true });

module.exports = mongoose.model('PriceConfig', priceConfigSchema);