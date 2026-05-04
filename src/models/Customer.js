const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  phone: {
  type: String,
  // unique: true,
  sparse: true,    // ⭐ bỏ qua null/undefined trong unique check
  default: undefined,  // ⭐ KHÔNG dùng default '' — phải là undefined
},
  email:       { type: String, default: '' },
  idNumber:    { type: String, default: '' },
  idType:      { type: String, enum: ['cccd', 'passport', 'other'], default: 'cccd' },
  nationality: { type: String, default: 'Việt Nam' },
  dob:         { type: Date, default: null },
  gender:      { type: String, enum: ['male', 'female', 'other'], default: 'male' },
  address:     { type: String, default: '' },
  type:        { type: String, enum: ['regular', 'vip', 'corporate'], default: 'regular' },
  notes:       { type: String, default: '' },
  totalVisits: { type: Number, default: 0 },
  totalSpent:  { type: Number, default: 0 },
}, { timestamps: true });

customerSchema.index({ phone: 1 });
customerSchema.index({ name: 'text', phone: 'text', email: 'text' });

module.exports = mongoose.model('Customer', customerSchema);