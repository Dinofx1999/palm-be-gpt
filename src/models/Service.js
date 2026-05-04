const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  category:    { type: String, default: 'Khác', trim: true },
  price:       { type: Number, required: true, min: 0 },
  unit:        { type: String, default: 'lần', trim: true },
  description: { type: String, default: '' },
  status:      { type: String, enum: ['active', 'inactive'], default: 'active' },

  // Optional: nếu sau này muốn tách dịch vụ theo branch
  branchId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },

  // Audit
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

serviceSchema.index({ status: 1 });
serviceSchema.index({ category: 1 });
serviceSchema.index({ name: 'text', category: 'text' });   // text search

module.exports = mongoose.model('Service', serviceSchema);