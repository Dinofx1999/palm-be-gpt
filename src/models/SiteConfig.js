// backend/src/models/SiteConfig.js
// Cấu hình NỘI DUNG WEB khách hàng — chung toàn hệ thống.
// Chỉ tồn tại 1 document duy nhất (singleton); dùng SiteConfig.getSingleton().
const mongoose = require('mongoose');

const heroSlideSchema = new mongoose.Schema({
  type:     { type: String, enum: ['image', 'video'], default: 'image' },
  src:      { type: String, default: '' },     // URL ảnh/video (từ /api/upload)
  title:    { type: String, default: '' },
  subtitle: { type: String, default: '' },
}, { _id: false });

const amenitySchema = new mongoose.Schema({
  icon:  { type: String, default: '✨' },
  label: { type: String, required: true },     // vd 'Wifi 1Gbps'
  desc:  { type: String, default: '' },        // vd 'Tốc độ cao toàn khu'
}, { _id: false });

// Logo + tên thương hiệu hiển thị ở thanh điều hướng / footer
const brandSchema = new mongoose.Schema({
  logoType:  { type: String, enum: ['icon', 'image'], default: 'icon' }, // icon sao mặc định hoặc ảnh upload
  logoUrl:   { type: String, default: '' },     // URL ảnh logo (khi logoType='image')
  nameMain:  { type: String, default: 'palm' }, // phần chữ thường (màu trắng)
  nameAccent:{ type: String, default: 'hotel' },// phần chữ nhấn (màu vàng)
}, { _id: false });

const siteConfigSchema = new mongoose.Schema({
  // khoá cố định để đảm bảo chỉ 1 document
  key:        { type: String, default: 'default', unique: true },
  brand:      { type: brandSchema, default: () => ({}) },
  heroSlides: { type: [heroSlideSchema], default: [] },
  amenities:  { type: [amenitySchema], default: [] },
}, { timestamps: true });

// Lấy (hoặc tạo) document cấu hình duy nhất
siteConfigSchema.statics.getSingleton = async function () {
  let doc = await this.findOne({ key: 'default' });
  if (!doc) doc = await this.create({ key: 'default' });
  return doc;
};

module.exports = mongoose.model('SiteConfig', siteConfigSchema);