// backend/src/models/StockReceipt.js
// ════════════════════════════════════════════════════════════════════
// Phiếu nhập kho — 1 phiếu nhập NHIỀU mặt hàng cùng lúc.
// Mỗi dòng (items) khi tạo phiếu → tăng Service.stock + sinh 1 StockMovement
// (type 'in', receiptId trỏ về phiếu này) để truy vết.
// ════════════════════════════════════════════════════════════════════
const mongoose = require('mongoose');

const receiptItemSchema = new mongoose.Schema({
  serviceId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
  serviceName: { type: String, default: '' },   // snapshot tên (phòng khi dịch vụ đổi tên/xoá)
  unit:        { type: String, default: '' },
  quantity:    { type: Number, required: true, min: 1 },
  unitCost:    { type: Number, default: 0 },     // giá nhập / đơn vị
  lineTotal:   { type: Number, default: 0 },     // = quantity * unitCost
}, { _id: false });

const stockReceiptSchema = new mongoose.Schema({
  receiptCode: { type: String, unique: true, index: true },   // tự sinh PN-YYYYMMDD-xxxx
  branchId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  supplier:    { type: String, default: '', trim: true },
  note:        { type: String, default: '', trim: true },
  items:       { type: [receiptItemSchema], default: [] },
  totalQuantity: { type: Number, default: 0 },   // tổng số lượng các dòng
  totalAmount:   { type: Number, default: 0 },   // tổng tiền nhập (sum lineTotal)

  // ⭐ Quy trình duyệt
  status:       { type: String, enum: ['draft', 'approved', 'rejected', 'cancelled'], default: 'draft', index: true },
  paymentMethod:{ type: String, enum: ['cash', 'transfer', 'card', 'other'], default: 'cash' }, // để tạo phiếu chi khi duyệt
  approvedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  approvedAt:   { type: Date, default: null },
  rejectedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  rejectedAt:   { type: Date, default: null },
  rejectReason: { type: String, default: '', trim: true },
  cancelledBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  cancelledAt:   { type: Date, default: null },
  cancelReason:  { type: String, default: '', trim: true },
  expenseTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null }, // phiếu chi đã tạo

  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

stockReceiptSchema.index({ branchId: 1, createdAt: -1 });

module.exports = mongoose.model('StockReceipt', stockReceiptSchema);