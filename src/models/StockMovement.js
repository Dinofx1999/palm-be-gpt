// backend/src/models/StockMovement.js
// ════════════════════════════════════════════════════════════════════
// Lịch sử nhập / xuất / điều chỉnh kho dịch vụ.
//   type 'in'     : nhập kho (mua hàng) — quantity > 0
//   type 'out'    : xuất (bán cho khách qua booking) — quantity > 0 (số lượng bán)
//   type 'adjust' : kiểm kê / điều chỉnh tay — quantity là DELTA (+/-)
// balanceAfter: số tồn SAU khi áp dụng movement này (để truy vết).
// ════════════════════════════════════════════════════════════════════
const mongoose = require('mongoose');

const stockMovementSchema = new mongoose.Schema({
  serviceId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true, index: true },
  branchId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  type:         { type: String, enum: ['in', 'out', 'adjust'], required: true },
  quantity:     { type: Number, required: true },   // 'in'/'out': số dương; 'adjust': delta (+/-)
  unitCost:     { type: Number, default: 0 },        // giá nhập (cho type 'in')
  supplier:     { type: String, default: '' },       // nhà cung cấp (cho type 'in')
  note:         { type: String, default: '' },
  bookingId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null }, // cho type 'out'
  receiptId:    { type: mongoose.Schema.Types.ObjectId, ref: 'StockReceipt', default: null }, // cho type 'in' qua phiếu
  balanceAfter: { type: Number, default: 0 },         // tồn sau movement
  createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

stockMovementSchema.index({ serviceId: 1, createdAt: -1 });
stockMovementSchema.index({ branchId: 1, createdAt: -1 });

module.exports = mongoose.model('StockMovement', stockMovementSchema);