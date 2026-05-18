const mongoose = require('mongoose');

const roomTypeSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  description: { type: String, default: '' },

  // ⭐ Số NL/TE chuẩn (đã có) — dùng để TÍNH GIÁ CHUẨN
  //   Vd: maxA=2, maxC=1 → giá chuẩn cho 2NL + 1TE = giá listing
  //
  //   ⭐ LOGIC PHỤ THU v2 (spec 18/05/2026):
  //     - extraAdults  = max(0, adults - maxAdults)
  //     - childFreeSlots = maxChildren + max(0, maxAdults - adults)
  //                        (TE có thể "thế chỗ" NL chuẩn còn dư)
  //     - extraChildren = max(0, children - childFreeSlots)
  //
  //   Examples (maxA=2, maxC=1):
  //     2NL+1TE = 0 phụ thu (chuẩn)
  //     3NL+0TE = 1NL phụ thu (NL > maxA)
  //     1NL+1TE = 0 phụ thu
  //
  //   Examples (maxA=4, maxC=0):
  //     4NL = 0 phụ thu
  //     3NL+1TE = 0 phụ thu (1TE thế chỗ NL chuẩn dư)
  //     0NL+4TE = 0 phụ thu
  //     5NL = 1NL phụ thu
  //     4NL+1TE = 1TE phụ thu
  //     5NL+1TE = 1NL+1TE phụ thu
  maxAdults:   { type: Number, default: 2 },
  maxChildren: { type: Number, default: 0 },

  // ⭐ MỚI 14/05/2026: Số giường vật lý trong phòng
  beds: {
    type: Number,
    default: 1,
    min: 1,
    max: 10,
  },

  // ⭐ MỚI 14/05/2026: Số NGƯỜI TỐI ĐA cho phép (cứng — không cho vượt)
  //   Logic:
  //     - Nếu adults + children <= maxOccupancy → CHO ĐẶT
  //     - Nếu adults + children > maxOccupancy → TỪ CHỐI ("phòng không đủ chỗ")
  //   ⭐ VALIDATE: maxOccupancy PHẢI >= maxAdults + maxChildren (ngăn config sai)
  maxOccupancy: {
    type: Number,
    default: 3,
    min: 1,
    validate: {
      validator: function (v) {
        const maxA = this.maxAdults ?? 0
        const maxC = this.maxChildren ?? 0
        return v >= maxA + maxC
      },
      message: function (props) {
        return `maxOccupancy (${props.value}) phải >= maxAdults + maxChildren. Vui lòng kiểm tra lại cấu hình loại phòng.`
      },
    },
  },

  area:        { type: Number, default: 25 },
  amenities:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'Amenity' }],
  branchId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
}, { timestamps: true });

// ⭐ Pre-save hook: validate cross-field (cover cả findOneAndUpdate qua runValidators)
roomTypeSchema.pre('save', function (next) {
  const maxA = this.maxAdults ?? 0
  const maxC = this.maxChildren ?? 0
  const maxO = this.maxOccupancy ?? 0
  if (maxO < maxA + maxC) {
    return next(new Error(`maxOccupancy (${maxO}) phải >= maxAdults (${maxA}) + maxChildren (${maxC}) = ${maxA + maxC}.`))
  }
  next()
})

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