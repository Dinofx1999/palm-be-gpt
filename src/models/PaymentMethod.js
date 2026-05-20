const mongoose = require('mongoose');

const paymentMethodSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  type:     { type: String, required: true },
  note:     { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  bankInfo: {
  bankName:      { type: String, default: '' },
  bankBin:       { type: String, default: '' },   // ← phải có dòng này
  accountNumber: { type: String, default: '' },
  accountHolder: { type: String, default: '' },
},
}, { timestamps: true });

module.exports = mongoose.model('PaymentMethod', paymentMethodSchema);