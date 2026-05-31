// src/models/LockConfig.js
// ════════════════════════════════════════════════════════════════════
// Cấu hình khóa cửa theo CHI NHÁNH (giống GetLockConfig của ezCloud, rút gọn cho DLOCK).
// Mỗi chi nhánh 1 bản ghi. Map số phòng → mã khóa lưu trên model Room (xem patch Room).
// ════════════════════════════════════════════════════════════════════
const mongoose = require('mongoose');

const lockConfigSchema = new mongoose.Schema({
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    unique: true,        // mỗi chi nhánh 1 config
    index: true,
  },

  // Có bật tích hợp khóa cho chi nhánh này không
  enabled: { type: Boolean, default: false },

  // Loại khóa — hiện chỉ DLOCK (bộ SDK LockSDK.dll)
  lockBrand: { type: String, enum: ['DLOCK'], default: 'DLOCK' },

  // Loại đầu đọc: 4 = RF57, 5 = RF50. null = để agent tự dò.
  lockType: { type: Number, enum: [4, 5, null], default: null },

  // Cổng agent localhost trên máy quầy (ezCloud DLock dùng 2000)
  agentPort: { type: Number, default: 2000 },

  // Tùy chọn checkout (giống ezCloud)
  isInputCardToCheckout: { type: Boolean, default: false }, // bắt quẹt thẻ khi trả phòng
  addCheckoutMinute: { type: Number, default: 0 },          // cộng thêm phút vào giờ trả
  minusCheckinMinute: { type: Number, default: 0 },         // trừ phút vào giờ nhận

  // Ghi chú nội bộ
  note: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('LockConfig', lockConfigSchema);