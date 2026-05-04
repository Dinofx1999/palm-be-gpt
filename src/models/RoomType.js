const mongoose = require('mongoose');

const roomTypeSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  capacity:    { type: Number, default: 2 },
  area:        { type: Number, default: 25 },
  amenities:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'Amenity' }],  // ← đổi sang ref
  branchId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
}, { timestamps: true });

module.exports = mongoose.model('RoomType', roomTypeSchema);