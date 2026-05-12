// src/models/ServiceCategory.js
// Danh mục dịch vụ — theo từng chi nhánh
// Có thể copy sang chi nhánh khác (xem endpoint /service-categories/:id/copy-to-branch)

const mongoose = require('mongoose')

const serviceCategorySchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true },
  icon:      { type: String, default: '📦', trim: true },
  sortOrder: { type: Number, default: 0 },
  status:    { type: String, enum: ['active', 'inactive'], default: 'active' },

  // ⭐ Bắt buộc: category theo từng chi nhánh
  branchId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },

  // Audit
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

// ⭐ Unique trong cùng chi nhánh: 1 chi nhánh không thể có 2 category cùng tên
serviceCategorySchema.index({ branchId: 1, name: 1 }, { unique: true })
serviceCategorySchema.index({ branchId: 1, status: 1 })
serviceCategorySchema.index({ branchId: 1, sortOrder: 1 })

module.exports = mongoose.model('ServiceCategory', serviceCategorySchema)