// backend/src/models/Invoice.js
//
// ⭐ UPDATED 15/05/2026: Thêm audit fields cho payment sub-document
//   - isEdited / editHistory[]: track sửa đổi (Số tiền + Method + Note)
//   - isDeleted / deletedAt / deletedBy / deletedReason: soft delete
//
const mongoose = require('mongoose');

// ⭐ NEW: Schema cho 1 lần sửa đổi payment
const paymentEditEntrySchema = new mongoose.Schema({
  editedAt:     { type: Date, default: Date.now },
  editedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  editedByName: { type: String, default: '' },          // snapshot tên (audit-safe)
  reason:       { type: String, required: true },
  changes: {
    amount: { from: Number, to: Number },
    method: { from: String, to: String },
    note:   { from: String, to: String },
  },
}, { _id: false });

const paymentSchema = new mongoose.Schema({
  amount:    { type: Number, required: true },
  method:    { type: String, default: 'cash' },
  note:      { type: String, default: '' },
  type:      { type: String, enum: ['payment', 'refund'], default: 'payment' },
  paidAt:    { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  targetRoomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },

  // ⭐ NEW 15/05: Audit fields
  isEdited:     { type: Boolean, default: false },
  editHistory:  { type: [paymentEditEntrySchema], default: [] },

  // ⭐ NEW 15/05: Soft delete
  isDeleted:      { type: Boolean, default: false },
  deletedAt:      { type: Date, default: null },
  deletedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  deletedByName:  { type: String, default: '' },
  deletedReason:  { type: String, default: '' },
}, { _id: true });

const itemSchema = new mongoose.Schema({
  description: { type: String, required: true },
  quantity:    { type: Number, default: 1 },
  unitPrice:   { type: Number, default: 0 },
  amount:      { type: Number, default: 0 },
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
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
  payments:        [paymentSchema],
  issuedBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  branchId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  issuedAt:        { type: Date, default: Date.now },
  lastModifiedAt:  { type: Date, default: Date.now },
}, { timestamps: true });

invoiceSchema.index({ bookingId: 1 });
invoiceSchema.index({ customerId: 1 });
invoiceSchema.index({ paymentStatus: 1 });
invoiceSchema.index({ branchId: 1, createdAt: -1 });

invoiceSchema.pre('save', async function () {
  this.lastModifiedAt = new Date()

  if (this.isNew && !this.invoiceCode) {
    try {
      const Invoice = mongoose.model('Invoice')
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
      console.error('[Invoice] auto-gen code failed:', err.message)
      const ts = Date.now().toString().slice(-6)
      this.invoiceCode = `HD${ts}`
    }
  }
})

module.exports = mongoose.model('Invoice', invoiceSchema);