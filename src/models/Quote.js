const mongoose = require('mongoose');
const crypto = require('crypto');

// ⭐ Subdoc: 1 dòng breakdown
const breakdownSchema = new mongoose.Schema({
  label:  { type: String },
  amount: { type: Number, default: 0 },
  type:   { type: String, default: 'base' },     // base | surcharge
  meta:   { type: mongoose.Schema.Types.Mixed }, // chứa startTime/endTime tùy ý
}, { _id: false });

// ⭐ Subdoc: 1 phòng trong báo giá
const quoteRoomSchema = new mongoose.Schema({
  roomId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
  roomNumber:     { type: String },
  typeId:         { type: mongoose.Schema.Types.ObjectId, ref: 'RoomType' },
  typeName:       { type: String },
  capacity:       { type: Number, default: 2 },
  adults:         { type: Number, default: 1 },
  children:       { type: Number, default: 0 },

  // Snapshot từ Room/RoomType
  images:         [{ type: String }],
  amenities:      [{ type: String }],
  description:    { type: String, default: '' },

  // Snapshot policy info (giờ check-in/out + phụ thu) từ PricePolicy
  policyInfo: {
    checkInTime:    { type: String, default: '' },
    checkOutTime:   { type: String, default: '' },
    adultSurcharge: { type: Number, default: 0 },
    childSurcharge: { type: Number, default: 0 },
    extraAdults:    { type: Number, default: 0 },
    extraChildren:  { type: Number, default: 0 },
  },

  // Pricing
  policyId:           { type: mongoose.Schema.Types.ObjectId },
  policyName:         { type: String },
  requestedPriceType: { type: String },
  finalPriceType:     { type: String },
  converted:          { type: Boolean, default: false },
  notice:             { type: String, default: '' },
  roomAmount:         { type: Number, default: 0 },
  nights:             { type: Number, default: 1 },

  // ⭐ NEW: Số lượng phòng (chỉ dùng cho mode 'by_type' khi merge các phòng cùng loại)
  quantity:           { type: Number, default: 1 },

  breakdown:          [breakdownSchema],

  // ⭐ NEW: Display mode cho line này (snapshot)
  displayMode: {
    type: String,
    enum: ['selected', 'with_alternatives', 'by_type'],
    default: 'selected',
  },

  // ⭐ NEW: Aggregated images cho mode 'by_type'
  aggregatedImages: [{ type: String }],

  // ⭐ Phòng thay thế cùng loại đang trống
  alternativeRooms: [{
    roomId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
    roomNumber: { type: String },
    floorName:  { type: String, default: '' },
    images:     [{ type: String }],
  }],
}, { _id: false });

// ⭐ Schema chính
const quoteSchema = new mongoose.Schema({
  token: {
    type: String,
    required: true,
    unique: true,
    default: () => crypto.randomBytes(16).toString('hex'),
  },

  branchId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  branchName: { type: String, default: '' },

  customerName:  { type: String, default: '' },
  customerPhone: { type: String, default: '' },
  groupName:     { type: String, default: '' },

  checkIn:  { type: Date, required: true },
  checkOut: { type: Date, required: true },
  nights:   { type: Number, default: 1 },

  rooms: [quoteRoomSchema],

  totalAmount: { type: Number, default: 0 },

  // Snapshot quy định CHUNG của chi nhánh
  branchPolicies: {
    cancellationPolicy: { type: String, default: '' },
    requiredDocuments:  { type: String, default: '' },
    hotelRules:         { type: String, default: '' },
    includedServices: [{
      icon:        String,
      name:        String,
      description: String,
      isFree:      Boolean,
      price:       Number,
    }],
    // ⭐ Snapshot contact info từ Branch
    contact: {
      phone:   { type: String, default: '' },
      email:   { type: String, default: '' },
      address: { type: String, default: '' },
      city:    { type: String, default: '' },
      zalo:    { type: String, default: '' },
    },
  },

  // ⭐ NEW: Display mode top-level (cho frontend public page render đúng)
  displayMode: {
    type: String,
    enum: ['selected', 'with_alternatives', 'by_type'],
    default: 'selected',
  },

  // ⭐ UPDATED: Mở rộng status enum để hỗ trợ workflow phê duyệt
  //   draft     → mới tạo, chưa gửi cho khách
  //   sent      → đã gửi link cho khách
  //   viewed    → khách đã xem (auto-set khi truy cập public URL)
  //   confirmed → nhân viên xác nhận (lock thông tin, sẵn sàng convert thành booking)
  //   accepted  → khách đã đồng ý (có thể tự khách click hoặc nv set)
  //   rejected  → khách từ chối
  //   expired   → quá hạn (auto khi expiresAt < now)
  //   converted → đã tạo booking từ quote này
  //   cancelled → huỷ
  status: {
    type: String,
    enum: ['draft', 'sent', 'viewed', 'confirmed', 'accepted', 'rejected', 'expired', 'converted', 'cancelled'],
    default: 'draft',
  },

  convertedBookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },

  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 ngày
  },

  // ⭐ Người báo giá (đã có)
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // ⭐ NEW: Người xác nhận báo giá
  //   Set khi status đổi sang 'confirmed' (qua endpoint PATCH /:id/status)
  confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  confirmedAt: { type: Date, default: null },

  // ⭐ NEW: History đổi status — dùng cho audit log (optional, có thể tắt nếu không cần)
  statusHistory: [{
    status:    { type: String },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changedAt: { type: Date, default: Date.now },
    note:      { type: String, default: '' },
  }],

  notes:     { type: String, default: '' },
}, { timestamps: true });

quoteSchema.index({ token: 1 }, { unique: true });
quoteSchema.index({ branchId: 1, createdAt: -1 });
quoteSchema.index({ status: 1 });
quoteSchema.index({ confirmedBy: 1 });

module.exports = mongoose.model('Quote', quoteSchema);