const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
  number:           { type: String, required: true },
  typeId:           { type: mongoose.Schema.Types.ObjectId, ref: 'RoomType', required: true },
  typeName:         { type: String, required: true },
  floorId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Floor', required: true },
  floorNumber:      { type: Number, required: true },
  branchId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  roomStatus:       { type: String, enum: ['active', 'maintenance', 'inactive'], default: 'active' },
  status:           { type: String, enum: ['available','occupied','checkout','cleaning','maintenance','reserved'], default: 'available' },
  currentBookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
  currentGuestName: { type: String, default: null },
  checkIn:          { type: Date, default: null },
  checkOut:         { type: Date, default: null },
  notes:            { type: String, default: null },
  images:           [{ type: String }],
}, { timestamps: true });

roomSchema.index({ branchId: 1, status: 1 });
roomSchema.index({ number: 1, branchId: 1 }, { unique: true });

module.exports = mongoose.model('Room', roomSchema);