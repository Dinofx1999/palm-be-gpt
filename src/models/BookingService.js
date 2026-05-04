const mongoose = require('mongoose');

const bookingServiceSchema = new mongoose.Schema({
  bookingId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
  // ⭐ NEW: subRoomId — gắn dịch vụ với 1 phòng cụ thể trong đoàn
  //   - null = dịch vụ DÙNG CHUNG cho cả booking (vd booking đơn, hoặc dịch vụ chung của đoàn)
  //   - có value = dịch vụ của phòng đó (vd phòng 202 gọi nước lọc → subRoomId = 202.roomId)
  subRoomId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null, index: true },
  // ⭐ Lưu thêm roomNumber để hiển thị nhanh không phải populate
  subRoomNumber:{ type: String, default: '' },
  serviceId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
  serviceName:  { type: String, required: true },
  unit:         { type: String, default: '' },
  unitPrice:    { type: Number, required: true },
  quantity:     { type: Number, default: 1 },
  totalPrice:   { type: Number, required: true },
  notes:        { type: String, default: '' },
  addedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  addedAt:      { type: Date, default: Date.now },
}, { timestamps: true });

bookingServiceSchema.index({ bookingId: 1, addedAt: 1 });
// ⭐ Index để query nhanh dịch vụ của 1 phòng
bookingServiceSchema.index({ bookingId: 1, subRoomId: 1 });

module.exports = mongoose.model('BookingService', bookingServiceSchema);