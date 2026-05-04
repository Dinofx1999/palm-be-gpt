const mongoose = require('mongoose');

const amenitySchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  icon:        { type: String, default: '' },        // emoji hoặc icon name
  category:    { type: String, required: true },     // Phòng ngủ, Phòng tắm, Tiện ích...
  description: { type: String, default: '' },
  isActive:    { type: Boolean, default: true },
}, { timestamps: true });

amenitySchema.index({ category: 1 });

module.exports = mongoose.model('Amenity', amenitySchema);