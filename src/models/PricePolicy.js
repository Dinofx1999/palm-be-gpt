const mongoose = require('mongoose');

// ── Sub-schema: Giá theo mốc giờ ─────────────────────
const hourSlotSchema = new mongoose.Schema({
  time:  { type: String, required: true }, // "02:00", "03:00"...
  price: { type: Number, required: true, min: 0 },
}, { _id: false });

// ── Sub-schema: Phụ thu (checkin sớm / checkout muộn) ─
const surchargeSchema = new mongoose.Schema({
  time:  { type: String, required: true }, // số giờ tính từ mốc
  price: { type: Number, required: true, min: 0 },
}, { _id: false });

// ── Main schema ───────────────────────────────────────
const pricePolicySchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },  // "Giá nghỉ giờ", "GIÁ KHÁCH ĐOÀN"
  roomTypeId:  { type: mongoose.Schema.Types.ObjectId, ref: 'RoomType', required: true },
  roomTypeName:{ type: String, default: '' },
  branchId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
  isActive:    { type: Boolean, default: true },

  // ⭐ NEW: Thứ tự hiển thị (kéo-thả sắp xếp)
  //  - displayOrder nhỏ = hiện lên trước
  //  - Mặc định 0 — auto-assign khi tạo mới = max + 1 trong cùng roomType
  displayOrder: { type: Number, default: 0, index: true },

  // ── Giá giờ ─────────────────────────────────────
  hourEnabled: { type: Boolean, default: false },
  hourSlots:   [hourSlotSchema],  // [{ time: "02:00", price: 100000 }, ...]

  // ── Giá ngày ────────────────────────────────────
  dayEnabled:          { type: Boolean, default: false },
  dayPrice:            { type: Number, default: 0 },
  dayCheckInTime:      { type: String, default: '12:00' },   // mốc checkin để tính giá ngày
  dayCheckOutTime:     { type: String, default: '12:00' },
  dayEarlyCheckIn:     [surchargeSchema],  // phí checkin sớm
  dayLateCheckOut:     [surchargeSchema],  // phí checkout muộn
  dayAdultSurcharge:   { type: Number, default: 0 },
  dayChildSurcharge:   { type: Number, default: 0 },

  // ── Giá đêm ─────────────────────────────────────
  nightEnabled:        { type: Boolean, default: false },
  nightPrice:          { type: Number, default: 0 },
  nightCheckInTime:    { type: String, default: '22:00' },
  nightCheckOutTime:   { type: String, default: '11:00' },

  // ── Giá tuần ────────────────────────────────────
  weekEnabled:         { type: Boolean, default: false },
  weekPrice:           { type: Number, default: 0 },

  // ── Giá tháng ───────────────────────────────────
  monthEnabled:        { type: Boolean, default: false },
  monthPrice:          { type: Number, default: 0 },

  notes:       { type: String, default: '' },
}, { timestamps: true });

pricePolicySchema.index({ roomTypeId: 1, branchId: 1 });
pricePolicySchema.index({ isActive: 1 });
// ⭐ NEW: Index để sort nhanh
pricePolicySchema.index({ roomTypeId: 1, displayOrder: 1 });

module.exports = mongoose.model('PricePolicy', pricePolicySchema);