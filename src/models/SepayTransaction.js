const mongoose = require('mongoose');   // ← thêm dòng này

const sepayTxSchema = new mongoose.Schema({
  sepayId:        { type: Number, required: true, unique: true },
  gateway:        String,
  transactionDate:Date,
  accountNumber:  String,
  subAccount:     { type: String, default: null },
  code:           { type: String, default: null },
  content:        String,
  transferType:   { type: String, enum: ['in', 'out'] },
  transferAmount: Number,
  accumulated:    Number,
  referenceCode:  String,
  matchedInvoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
}, { timestamps: true });

sepayTxSchema.index({ sepayId: 1 }, { unique: true });

module.exports = mongoose.model('SepayTransaction', sepayTxSchema);