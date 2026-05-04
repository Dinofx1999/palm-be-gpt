const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  amount:    { type: Number, required: true },   // dương = thu, âm = hoàn tiền
  method:    { type: String, default: 'cash' },  // 'cash', 'bank', 'card', 'momo'...
  note:      { type: String, default: '' },
  type:      { type: String, enum: ['payment', 'refund'], default: 'payment' },
  paidAt:    { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // ⭐ NEW: Room ưu tiên thanh toán (cho booking đoàn — phòng được trả tiền trước)
  targetRoomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
}, { _id: true });

const itemSchema = new mongoose.Schema({
  description: { type: String, required: true },
  quantity:    { type: Number, default: 1 },
  unitPrice:   { type: Number, default: 0 },
  amount:      { type: Number, default: 0 },
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  // ⭐ NEW: Mã HĐ tự sinh dạng HD000001 (auto-gen ở pre-save hook)
  invoiceCode:     { type: String, unique: true, sparse: true, index: true },

  bookingId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', required: true },
  customerId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  customerName:    { type: String, required: true },
  roomNumber:      { type: String, default: '' },
  roomAmount:      { type: Number, default: 0 },
  servicesAmount:  { type: Number, default: 0 },
  discount:        { type: Number, default: 0 },
  totalAmount:     { type: Number, required: true },
  paidAmount:      { type: Number, default: 0 },
  remainingAmount: { type: Number, default: 0 },
  paymentMethod:   { type: String, default: null },
  paymentStatus:   { type: String, enum: ['unpaid', 'partial', 'paid'], default: 'unpaid' },
  notes:           { type: String, default: '' },
  items:           [itemSchema],
  payments:        [paymentSchema],   // ⭐ Mảng giao dịch thanh toán
  issuedBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // ⭐ NEW: Ngày lập HĐ (set lần đầu khi tạo)
  issuedAt:        { type: Date, default: Date.now },

  // ⭐ NEW: Thời gian sửa đổi gần nhất (auto-update mỗi lần save)
  // Khác với updatedAt của timestamps ở chỗ: dùng cho UI dễ đọc & rõ nghĩa hơn
  lastModifiedAt:  { type: Date, default: Date.now },
}, { timestamps: true });

invoiceSchema.index({ bookingId: 1 });
invoiceSchema.index({ customerId: 1 });
invoiceSchema.index({ paymentStatus: 1 });

// ⭐ Pre-save hook: tự sinh invoiceCode + cập nhật lastModifiedAt
// LƯU Ý: với async function, Mongoose tự handle promise — KHÔNG gọi next() thủ công
invoiceSchema.pre('save', async function () {
  // Mỗi lần save → cập nhật lastModifiedAt
  this.lastModifiedAt = new Date()

  // Chỉ sinh mã khi tạo mới và chưa có code
  if (this.isNew && !this.invoiceCode) {
    try {
      const Invoice = mongoose.model('Invoice')

      // Tìm invoice có code lớn nhất để sinh số tiếp theo
      const last = await Invoice.findOne({ invoiceCode: /^HD\d{6}$/ })
        .sort({ invoiceCode: -1 })
        .select('invoiceCode')

      let nextNum = 1
      if (last?.invoiceCode) {
        const match = last.invoiceCode.match(/^HD(\d{6})$/)
        if (match) nextNum = parseInt(match[1], 10) + 1
      }
      this.invoiceCode = `HD${String(nextNum).padStart(6, '0')}`
    } catch (err) {
      // Fallback nếu có lỗi
      console.error('[Invoice] auto-gen code failed:', err.message)
      const ts = Date.now().toString().slice(-6)
      this.invoiceCode = `HD${ts}`
    }
  }
  // KHÔNG gọi next() — async function tự return Promise
})

module.exports = mongoose.model('Invoice', invoiceSchema);