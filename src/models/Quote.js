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

  breakdown:          [breakdownSchema],

  // ⭐ NEW: Phòng thay thế cùng loại đang trống
  // Snapshot tại thời điểm tạo quote — để khách xem có thêm lựa chọn
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
  },

  status: {
    type: String,
    enum: ['active', 'converted', 'expired', 'cancelled'],
    default: 'active',
  },
  convertedBookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },

  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 ngày
  },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  notes:     { type: String, default: '' },
}, { timestamps: true });

quoteSchema.index({ token: 1 }, { unique: true });
quoteSchema.index({ branchId: 1, createdAt: -1 });

module.exports = mongoose.model('Quote', quoteSchema);