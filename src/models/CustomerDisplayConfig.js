// backend/src/models/CustomerDisplayConfig.js
// Cấu hình MÀN HÌNH KHÁCH (customer-facing display) — RIÊNG theo từng chi nhánh.
// Mỗi branch có 1 document (singleton theo branchId). Dùng getByBranch(branchId).
//
// Hiển thị ở màn chờ "/customer-display": slideshow ảnh/video nền, các QR (sinh từ link
// trong app), và các dòng thông báo/khuyến mãi cố định. Logo + tên hiển thị RIÊNG của branch.
const mongoose = require('mongoose');

// Một slide nền: ảnh hoặc video
const mediaSlideSchema = new mongoose.Schema({
  type: { type: String, enum: ['image', 'video'], default: 'image' },
  url:  { type: String, default: '' },   // URL ảnh/video (từ /api/upload)
}, { _id: false });

// Một mục QR: app tự sinh ảnh QR từ `link`
const qrItemSchema = new mongoose.Schema({
  link:        { type: String, required: true },  // URL đích (Google review, fanpage, form góp ý...)
  title:       { type: String, default: '' },     // vd 'Đánh giá Google'
  description: { type: String, default: '' },     // vd 'Quét để đánh giá chúng tôi'
}, { _id: false });

// Logo + tên hiển thị RIÊNG của chi nhánh trên màn hình khách
const brandSchema = new mongoose.Schema({
  logoType:   { type: String, enum: ['icon', 'image'], default: 'icon' },
  logoUrl:    { type: String, default: '' },        // dùng khi logoType='image'
  nameMain:   { type: String, default: 'LuxHotel' },// phần chữ chính (trắng)
  nameAccent: { type: String, default: '' },        // phần chữ nhấn (vàng) — vd tên chi nhánh
}, { _id: false });

const customerDisplayConfigSchema = new mongoose.Schema({
  branchId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, unique: true, index: true },
  brand:     { type: brandSchema, default: () => ({}) },
  media:     { type: [mediaSlideSchema], default: [] },   // slideshow nền (ảnh/video)
  qrItems:   { type: [qrItemSchema], default: [] },        // các QR (tối đa 2-3 hiển thị đẹp)
  notices:   { type: [String], default: [] },              // các dòng thông báo/khuyến mãi (cố định)
  slideIntervalMs: { type: Number, default: 6000 },        // thời gian mỗi ảnh (video tự hết là chuyển)
  enabled:   { type: Boolean, default: true },             // bật/tắt màn quảng bá (tắt → màn chờ mặc định)
}, { timestamps: true });

// Lấy (hoặc tạo) cấu hình của một chi nhánh
customerDisplayConfigSchema.statics.getByBranch = async function (branchId) {
  let doc = await this.findOne({ branchId });
  if (!doc) doc = await this.create({ branchId });
  return doc;
};

module.exports = mongoose.model('CustomerDisplayConfig', customerDisplayConfigSchema);