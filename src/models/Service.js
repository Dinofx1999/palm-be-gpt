// src/models/Service.js
// ⭐ UPDATE 11/05/2026:
//   - Thêm field `categoryId` (ref ServiceCategory)
//   - Giữ field `category` (string) làm snapshot — không mất info khi category bị xóa
//   - Khi create/update: BE auto-fill `category` từ `categoryId.name`

const mongoose = require('mongoose')

const serviceSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },

  // ⭐ NEW: ref tới ServiceCategory — null nếu chưa phân loại hoặc category đã bị xóa
  categoryId:  { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCategory', default: null },

  // Snapshot tên category — vẫn dùng cho display khi categoryId=null (đã bị xóa)
  // hoặc cho legacy data chưa migrate
  category:    { type: String, default: 'Khác', trim: true },

  price:       { type: Number, required: true, min: 0 },
  unit:        { type: String, default: 'lần', trim: true },
  description: { type: String, default: '' },
  status:      { type: String, enum: ['active', 'inactive'], default: 'active' },

  branchId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  // ⭐ NEW 29/05/2026: quản lý kho
    trackInventory:    { type: Boolean, default: false },
    stock:             { type: Number,  default: 0 },
    lowStockThreshold: { type: Number,  default: 0 },

  // Audit
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

serviceSchema.index({ status: 1 })
serviceSchema.index({ category: 1 })
serviceSchema.index({ categoryId: 1 })            // ⭐ NEW
serviceSchema.index({ branchId: 1, status: 1 })   // ⭐ NEW (filter theo branch nhanh hơn)
serviceSchema.index({ name: 'text', category: 'text' })

module.exports = mongoose.model('Service', serviceSchema)