// backend/src/models/SystemSetting.js
// ════════════════════════════════════════════════════════════════════
// Cấu hình hệ thống THEO TỪNG CHI NHÁNH (mỗi chi nhánh 1 document).
//   - telegram: bot token + chat id để gửi thông báo
//   - email:    SMTP (Gmail App Password) để gửi mail xác nhận
//   - reports:  lịch gửi báo cáo doanh thu qua email
// Độc lập hoàn toàn: chi nhánh chưa cấu hình / chưa bật → không gửi gì.
// Token/email creds để trống → fallback .env (tuỳ chọn dùng chung).
// Bí mật (token/pass) lưu DB; controller che khi trả về FE.
// ════════════════════════════════════════════════════════════════════
const mongoose = require('mongoose');

const systemSettingSchema = new mongoose.Schema({
  // Mỗi chi nhánh 1 document cấu hình riêng
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, unique: true, index: true },

  telegram: {
    enabled:  { type: Boolean, default: false },
    botToken: { type: String, default: '' },
    chatId:   { type: String, default: '' },
  },

  email: {
    enabled:   { type: Boolean, default: false },
    host:      { type: String, default: 'smtp.gmail.com' },
    port:      { type: Number, default: 465 },
    secure:    { type: Boolean, default: true },
    user:      { type: String, default: '' },
    pass:      { type: String, default: '' },
    fromName:  { type: String, default: 'LuxHotel' },
    fromEmail: { type: String, default: '' },
  },

  reports: {
    recipients: { type: [String], default: [] },
    daily: {
      enabled:         { type: Boolean, default: false },
      time:            { type: String, default: '22:00' },
      coversYesterday: { type: Boolean, default: false },
    },
    monthly: {
      enabled:    { type: Boolean, default: false },
      dayOfMonth: { type: Number, default: 1 },
      time:       { type: String, default: '08:00' },
    },
  },

  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// Lấy (hoặc tạo) document cấu hình của 1 chi nhánh
systemSettingSchema.statics.getForBranch = async function (branchId) {
  if (!branchId) return null;
  let doc = await this.findOne({ branchId });
  if (!doc) doc = await this.create({ branchId });
  return doc;
};

module.exports = mongoose.model('SystemSetting', systemSettingSchema);