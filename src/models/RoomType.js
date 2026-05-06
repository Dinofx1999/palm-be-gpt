const mongoose = require('mongoose');

const roomTypeSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  description: { type: String, default: '' },

  // ⭐ NEW: Tách capacity thành maxAdults + maxChildren để mô tả chính xác hơn
  //   Vd: "tối đa 2 người lớn + 1 trẻ em"
  //   Logic phụ thu (priceCalculator):
  //     - Phụ thu NL: nếu adults > maxAdults (ưu tiên rule này)
  //     - Phụ thu TE: nếu tổng (adults+children) > (maxAdults+maxChildren), trừ phần NL đã phụ thu
  //   Vd: maxA=2, maxC=1
  //     A=2, C=2 (tổng 4) → 0 NL, 1 TE
  //     A=3, C=0 (tổng 3) → 1 NL, 0 TE
  //     A=3, C=2 (tổng 5) → 1 NL, 1 TE
  //     A=4, C=0 (tổng 4) → 2 NL, 0 TE
  maxAdults:   { type: Number, default: 2 },
  maxChildren: { type: Number, default: 0 },

  area:        { type: Number, default: 25 },
  amenities:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'Amenity' }],
  branchId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
}, { timestamps: true });

// ⭐ Virtual `capacity` để code cũ vẫn đọc được (= maxAdults + maxChildren)
//   Backward-compat khi UI/API cũ còn xài `capacity`
roomTypeSchema.virtual('capacity').get(function () {
  return (this.maxAdults ?? 0) + (this.maxChildren ?? 0);
});

// Đảm bảo virtual được serialize khi gọi .toJSON() / .toObject()
roomTypeSchema.set('toJSON',   { virtuals: true });
roomTypeSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('RoomType', roomTypeSchema);