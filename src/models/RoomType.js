const mongoose = require('mongoose');

const roomTypeSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  description: { type: String, default: '' },

  // ⭐ Số NL/TE chuẩn (đã có) — dùng để TÍNH GIÁ CHUẨN
  //   Vd: maxA=2, maxC=1 → giá chuẩn cho 2NL + 1TE = giá listing
  //   Logic phụ thu (priceCalculator):
  //     - Phụ thu NL: nếu adults > maxAdults (ưu tiên rule này)
  //     - Phụ thu TE: nếu tổng (adults+children) > (maxAdults+maxChildren), trừ phần NL đã phụ thu
  //   Vd: maxA=2, maxC=1
  //     A=2, C=2 (tổng 4) → 0 NL, 1 TE
  //     A=3, C=0 (tổng 3) → 1 NL, 0 TE
  //     A=3, C=2 (tổng 5) → 1 NL, 1 TE
  maxAdults:   { type: Number, default: 2 },
  maxChildren: { type: Number, default: 0 },

  // ⭐ MỚI 14/05/2026: Số giường vật lý trong phòng
  //   - 1 giường: phòng đôi tiêu chuẩn / phòng đơn
  //   - 2 giường: phòng twin / family
  //   - 3+ giường: phòng VIP / villa
  beds: {
    type: Number,
    default: 1,
    min: 1,
    max: 10,
  },

  // ⭐ MỚI 14/05/2026: Số NGƯỜI TỐI ĐA cho phép (cứng — không cho vượt)
  //   Linh hoạt với số giường: 2 giường có thể maxOccupancy = 2/3/4 tùy khách sạn
  //   Logic:
  //     - Nếu adults + children <= maxOccupancy → CHO ĐẶT (có thể phụ thu nếu vượt maxAdults+maxChildren)
  //     - Nếu adults + children > maxOccupancy → TỪ CHỐI ("phòng không đủ chỗ")
  //   Auto-default khi tạo mới (nếu không nhập): maxAdults + maxChildren + 1 (cho phép +1 extra)
  maxOccupancy: {
    type: Number,
    default: 3,
    min: 1,
  },

  area:        { type: Number, default: 25 },
  amenities:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'Amenity' }],
  branchId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
}, { timestamps: true });

// ⭐ Virtual `capacity` để code cũ vẫn đọc được (= maxAdults + maxChildren)
//   Backward-compat khi UI/API cũ còn xài `capacity`
roomTypeSchema.virtual('capacity').get(function () {
  return (this.maxAdults ?? 0) + (this.maxChildren ?? 0);
});

// ⭐ Virtual `extraSlots` — số slot extra có thể nhồi (phụ thu)
//   = maxOccupancy - (maxAdults + maxChildren)
roomTypeSchema.virtual('extraSlots').get(function () {
  return Math.max(0, (this.maxOccupancy ?? 0) - ((this.maxAdults ?? 0) + (this.maxChildren ?? 0)));
});

// Đảm bảo virtual được serialize khi gọi .toJSON() / .toObject()
roomTypeSchema.set('toJSON',   { virtuals: true });
roomTypeSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('RoomType', roomTypeSchema);