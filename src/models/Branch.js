const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema({
  name:    { type: String, required: true },
  address: { type: String, default: '' },
  city:    { type: String, default: '' },
  phone:   { type: String, default: '' },
  email:   { type: String, default: '' },
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // ── Giờ chuẩn ──
  checkInTime:  { type: String, default: '14:00' },   // "HH:mm"
  checkOutTime: { type: String, default: '12:00' },

  // ⭐ Cấu hình làm tròn / auto-convert giá ──
  // Ví dụ: tolerance 15 phút trước/sau giờ chuẩn → không tính phụ thu
  toleranceMinutes:    { type: Number, default: 15 },

  // Ngưỡng (giờ) để tự chuyển giữa giá Giờ ↔ giá Ngày
  // Nếu user chọn giá Ngày mà ở < ngưỡng này → auto chuyển sang giá Giờ
  // Nếu user chọn giá Giờ mà ở >= ngưỡng này (cùng ngày) → đề xuất giá Ngày
  hourToDayThreshold:  { type: Number, default: 3 },

  // Khi auto-convert sang giá Ngày, chú thích "đã tính tròn 1 ngày"
  // Vd: dayEquivalentHours = 23 → khách trả phòng vượt 23:00 sẽ tự cộng thêm 1 đêm
  dayEquivalentHours:  { type: Number, default: 23 },

  // ⭐ Ngưỡng "Nhận phòng đêm sớm"
  //   Khách CI từ 00:00 đến giờ này (vd 05:00) → tự tính 1 đêm trọn (không phụ thu CI sớm)
  //   CI từ giờ này → giờ chuẩn checkInTime → tính phụ thu nhận phòng sớm như cũ
  earlyCheckinUntil:   { type: Number, default: 5, min: 0, max: 11 },

  // ⭐ Bật/tắt tính năng auto-convert
  autoConvertPriceType: { type: Boolean, default: true },
  // ⭐ NEW: Cấu hình cutoff giá giờ
  hourBookingCutoffEnabled: { type: Boolean, default: false },
  hourBookingCutoffStart:   { type: String,  default: '20:00' },   // giờ bắt đầu cấm
  hourBookingCutoffEnd:     { type: String,  default: '06:00' },   // giờ kết thúc cấm (exclusive)

  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  // ⭐ NEW: Config cho báo giá - chỉ chứa quy định CHUNG của chi nhánh
  // ⭐ NEW: Config cho báo giá - chỉ chứa quy định CHUNG của chi nhánh
  // (Giờ check-in/out + phụ thu vượt người được lấy từ PricePolicy của từng loại phòng)
  latitude: { type: Number, default: null },         // ⭐ THÊM
  longitude: { type: Number, default: null },        // ⭐ THÊM
  geofenceRadius: { type: Number, default: 100 },    // ⭐ THÊM (mét)
  quotePolicy: {
    cancellationPolicy: { type: String, default: '' },
    requiredDocuments:  { type: String, default: '' },
    hotelRules:         { type: String, default: '' },
    includedServices: [{
      icon:        { type: String, default: '✓' },
      name:        { type: String, required: true },
      description: { type: String, default: '' },
      isFree:      { type: Boolean, default: true },
      price:       { type: Number, default: 0 },
    }],
  },

  // ⭐ NEW: Cấu hình bảo mật chấm công (Device Binding)
  //   - deviceBindingEnabled: bật/tắt feature cho branch này
  //   - autoApproveNewDevice: máy mới chưa ai dùng → cho pass tự động
  //   - enforceAtLogin / enforceAtCheckin: áp dụng tại điểm nào
  attendanceSecurity: {
    deviceBindingEnabled: { type: Boolean, default: false },
    autoApproveNewDevice: { type: Boolean, default: true },
    enforceAtLogin:       { type: Boolean, default: true },
    enforceAtCheckin:     { type: Boolean, default: true },
  },
}, { timestamps: true });

branchSchema.index({ status: 1 });

module.exports = mongoose.model('Branch', branchSchema);