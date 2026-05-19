const mongoose = require('mongoose');

const { BookingSegmentSchema } = require('./BookingSegment');
// ⭐ Sub-schema cho breakdown từng dòng giá
const breakdownItemSchema = new mongoose.Schema({
  label:  { type: String, required: true },
  amount: { type: Number, required: true },
  type:   { type: String, enum: ['base', 'surcharge'], default: 'base' },
  // Optional metadata để FE render đẹp hơn
  meta:   { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

const bookingSchema = new mongoose.Schema({
  customerId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  customerName:    { type: String, required: true },
  customerPhone:   { type: String, default: '' },   // ⭐ Không bắt buộc
  // ⭐ Phòng PRIMARY (giữ tương thích với code cũ — phòng đầu tiên của đoàn)
  roomId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  roomNumber:      { type: String, required: true },
  roomType:        { type: String, required: true },
  branchId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  checkIn:         { type: Date, required: true },
  checkOut:        { type: Date, required: true },
  actualCheckIn:   { type: Date, default: null },
  actualCheckOut:  { type: Date, default: null },
  nights:          { type: Number, required: true },
  priceType:       { type: String, enum: ['day', 'overnight', 'hour', 'holiday', 'night', 'week', 'month'], default: 'day' },
  adults:          { type: Number, default: 2 },
  children:        { type: Number, default: 0 },
  roomAmount:      { type: Number, required: true },
  servicesAmount:  { type: Number, default: 0 },

  // ⭐ NEW: Đoàn (group booking) — array các phòng KHI isGroup=true
  // Phòng đầu tiên trong rooms[] = chính `roomId` ở trên (cho tương thích)
  groupName:       { type: String, default: '' },
  rooms: [{
    roomId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
    roomNumber:      { type: String, required: true },
    roomType:        { type: String, default: '' },
    typeId:          { type: mongoose.Schema.Types.ObjectId, ref: 'RoomType' },
    // ⭐ NEW: checkIn/checkOut RIÊNG cho từng phòng trong đoàn
    //   - Nếu null → fallback về booking.checkIn/checkOut (backward compatible)
    //   - Nếu set → cho phép đổi ngày 1 phòng độc lập
    checkIn:         { type: Date, default: null },
    checkOut:        { type: Date, default: null },
    nights:          { type: Number, default: 0 },
    priceType:       { type: String, default: 'day' },
    adults:          { type: Number, default: 2 },
    children:        { type: Number, default: 0 },
    policyId:        { type: mongoose.Schema.Types.ObjectId, ref: 'PricePolicy' },
    policyName:      { type: String, default: '' },
    roomAmount:      { type: Number, default: 0 },
    priceBreakdown:  [breakdownItemSchema],   // ⭐ dùng cùng schema với root
    // ⭐ NEW: Per-room payment tracking
    paidAmount:      { type: Number, default: 0 },    // đã thanh toán riêng cho phòng này
    servicesAmount:  { type: Number, default: 0 },    // dịch vụ riêng (nếu có)
    discountAmount:  { type: Number, default: 0 },    // giảm giá riêng phòng (nếu có)
    // Trạng thái RIÊNG cho từng phòng — cho phép checkin/checkout từng phòng
    status:          { type: String, enum: ['reserved', 'checked_in', 'checked_out', 'cancelled'], default: 'reserved' },
    actualCheckIn:   { type: Date, default: null },
    actualCheckOut:  { type: Date, default: null },
    // Mỗi phòng có invoice riêng (theo yêu cầu)
    invoiceId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
    notes:           { type: String, default: '' },
    _id: false,
  }],

  // ⭐ Chiết khấu: lưu cả 3 trường
  discountPercent: { type: Number, default: 0 },   // 0-100
  discountAmount:  { type: Number, default: 0 },   // số tiền giảm cố định
  isFreeRoom:      { type: Boolean, default: false }, // miễn phí tiền phòng
  discount:        { type: Number, default: 0 },   // tổng giảm thực tế (computed)

  // ⭐ NEW 19/05/2026: Discount tracking — ai chịu trách nhiệm + lý do
  //   - discountReason: bắt buộc nếu có discount > 0 (>= 5 ký tự)
  //   - discountChargedTo: null = KS chịu, có giá trị = NV chịu (trừ lương cuối tháng)
  //   - Cache name+role để hiển thị nhanh + report aggregate không cần $lookup
  //   - appliedAt/By: audit trail cho thao tác cuối cùng
  discountReason:           { type: String, default: '' },
  discountChargedTo:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  discountChargedToName:    { type: String, default: null },
  discountChargedToRole:    { type: String, default: null },
  discountAppliedAt:        { type: Date, default: null },
  discountAppliedBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  discountAppliedByName:    { type: String, default: null },

  totalAmount:     { type: Number, required: true },

  // ⭐ Breakdown chi tiết — lưu để hiển thị lại y hệt khi xem booking
  priceBreakdown:  [breakdownItemSchema],

  status: {
    type: String,
    enum: ['pending', 'confirmed', 'reserved', 'checked_in', 'checked_out', 'cancelled'],
    default: 'reserved',
  },
  paymentStatus:   { type: String, enum: ['unpaid','partial','paid'], default: 'unpaid' },
  source:          { type: String, default: 'Trực tiếp' },
  isGroup:         { type: Boolean, default: false },
  notes:           { type: String, default: '' },
  cancelReason:    { type: String, default: null },
  cancelledAt:     { type: Date, default: null },
  cancelledBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  undoReason:      { type: String, default: null },
  policyId:        { type: mongoose.Schema.Types.ObjectId, ref: 'PricePolicy', default: null },
  policyName:      { type: String, default: '' },

  // ⭐ NEW: Snapshot policy lúc tạo booking (immutable)
  // Dùng khi cần tính lại giá đoạn đã ở (segment 1 khi chuyển phòng) —
  // KHÔNG phụ thuộc vào policy hiện tại trong DB (vì admin có thể đã sửa/xoá)
  policySnapshot: {
    name:                { type: String },
    roomTypeId:          { type: mongoose.Schema.Types.ObjectId, ref: 'RoomType' },
    roomTypeName:        { type: String },
    capacity:            { type: Number },
    hourEnabled:         { type: Boolean },
    hourSlots:           [{ time: String, price: Number, _id: false }],
    dayEnabled:          { type: Boolean },
    dayPrice:            { type: Number },
    dayCheckInTime:      { type: String },
    dayCheckOutTime:     { type: String },
    dayEarlyCheckIn:     [{ time: String, price: Number, _id: false }],
    dayLateCheckOut:     [{ time: String, price: Number, _id: false }],
    dayAdultSurcharge:   { type: Number },
    dayChildSurcharge:   { type: Number },
    nightEnabled:        { type: Boolean },
    nightPrice:          { type: Number },
    nightCheckInTime:    { type: String },
    nightCheckOutTime:   { type: String },
    weekEnabled:         { type: Boolean },
    weekPrice:           { type: Number },
    monthEnabled:        { type: Boolean },
    monthPrice:          { type: Number },
  },

  // ⭐ NEW: Phí chuyển phòng (cộng dồn nhiều lần chuyển)
  transferFee:     { type: Number, default: 0 },

  // ⭐ NEW: Lịch sử chuyển phòng — mỗi entry là 1 lần chuyển
  transferHistory: [{
    fromRoomId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
    fromRoomNumber: String,
    toRoomId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
    toRoomNumber:   String,
    transferAt:     Date,                  // mốc chia segment (mặc định now)
    fee:            { type: Number, default: 0 },
    oldPolicyId:    { type: mongoose.Schema.Types.ObjectId, ref: 'PricePolicy' },
    newPolicyId:    { type: mongoose.Schema.Types.ObjectId, ref: 'PricePolicy' },
    reason:         String,
    by:             { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    _id: false,
  }],

  segments: { type: [BookingSegmentSchema], default: [] },

  // ⭐ NEW: Mã đặt phòng — format BK_XXXXXX (6 ký tự alphanumeric uppercase, random)
  //   Auto-generate ở pre-save hook nếu chưa có. Unique + sparse (cho phép null tạm thời).
  bookingCode:     { type: String, unique: true, sparse: true, index: true },
}, { timestamps: true });

bookingSchema.index({ status: 1, branchId: 1 });
bookingSchema.index({ customerId: 1 });
bookingSchema.index({ roomId: 1 });

// ⭐ NEW 19/05/2026: Index cho report discount cuối tháng
//   Query: tổng discount theo NV trong khoảng thời gian → cần index compound
bookingSchema.index({ discountChargedTo: 1, discountAppliedAt: -1 });
bookingSchema.index({ branchId: 1, discountChargedTo: 1, discountAppliedAt: -1 });

// ⭐ Pre-save hook: tự sinh bookingCode nếu chưa có
//   Format: BK_XXXXXX (6 ký tự alphanumeric uppercase)
//   Loại bỏ các ký tự dễ nhầm lẫn: 0/O, 1/I/L để tránh nhầm khi đọc/nhập
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'   // bỏ I, L, O, 0, 1
const generateBookingCode = () => {
  let code = 'BK_'
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  return code
}

bookingSchema.pre('save', async function () {
  if (this.isNew && !this.bookingCode) {
    // Loop để tránh trùng (rất hiếm với 31^6 ≈ 887 triệu tổ hợp)
    const Booking = this.constructor
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = generateBookingCode()
      const exists = await Booking.findOne({ bookingCode: candidate }).select('_id').lean()
      if (!exists) {
        this.bookingCode = candidate
        break
      }
    }
    // Nếu sau 10 lần vẫn trùng (rất bất thường) → fallback timestamp
    if (!this.bookingCode) {
      this.bookingCode = `BK_${Date.now().toString(36).toUpperCase().slice(-6)}`
    }
  }
})

module.exports = mongoose.model('Booking', bookingSchema);