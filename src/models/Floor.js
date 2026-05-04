const mongoose = require('mongoose');

const floorSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  number:   { type: Number, required: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  status:   { type: String, enum: ['active', 'inactive'], default: 'active' },
}, { timestamps: true });

module.exports = mongoose.model('Floor', floorSchema);