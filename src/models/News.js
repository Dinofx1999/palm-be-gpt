// backend/src/models/News.js
const mongoose = require('mongoose');

const newsSchema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true },
  // slug duy nhất, tự sinh từ title nếu không truyền
  slug:        { type: String, trim: true, lowercase: true, index: true },
  excerpt:     { type: String, default: '' },      // tóm tắt ngắn (card + meta description)
  content:     { type: String, default: '' },      // nội dung đầy đủ (markdown nhẹ)
  coverImage:  { type: String, default: '' },       // URL ảnh bìa (từ /api/upload)
  category:    { type: String, default: '' },       // 'Ưu đãi' | 'Sự kiện' | 'Cẩm nang'...
  // null = tin CHUNG toàn hệ thống; có giá trị = tin riêng chi nhánh
  branchId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  author:      { type: String, default: 'Palm Hotel' },
  isPublished: { type: Boolean, default: true },
  publishedAt: { type: Date, default: Date.now },
  views:       { type: Number, default: 0 },
}, { timestamps: true });

newsSchema.index({ isPublished: 1, publishedAt: -1 });
newsSchema.index({ branchId: 1 });

// ── Tự sinh slug từ title (có dấu → không dấu, gạch ngang) ──
function slugify(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // bỏ dấu
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')                          // bỏ ký tự lạ
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

newsSchema.pre('validate', function () {
  if (!this.slug && this.title) {
    this.slug = slugify(this.title) + '-' + Date.now().toString(36).slice(-4);
  } else if (this.slug) {
    this.slug = slugify(this.slug);
  }
});

module.exports = mongoose.model('News', newsSchema);