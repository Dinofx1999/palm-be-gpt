// backend/src/models/SepayTransaction.js
// ════════════════════════════════════════════════════════════════════
// Lưu mọi giao dịch SePay đẩy về qua webhook.
//   - sepayId: ID giao dịch do SePay sinh (duy nhất) → unique index chống trùng.
//     Khi SePay retry gửi lại cùng giao dịch, create() ném E11000 → bỏ qua,
//     đảm bảo KHÔNG ghi nhận tiền hai lần.
//   - matchedInvoice: trỏ tới Invoice đã ghi nhận giao dịch này (null = chưa khớp).
//
// ⚠ FIX: field sepayId TRƯỚC ĐÂY bị comment nhưng index vẫn còn → mọi bản ghi
//   lưu với sepayId = null và đụng nhau ở unique index ("Already saved" từ bản
//   ghi thứ 2). Đã bỏ comment field + chỉ giữ MỘT khai báo index (qua unique:true).
// ════════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

const sepayTxSchema = new mongoose.Schema({
  sepayId:         { type: Number, required: true, unique: true },  // ID giao dịch SePay (chống trùng)
  gateway:         String,                                          // Tên ngân hàng (vd "TPBank")
  transactionDate: Date,                                            // Thời điểm giao dịch
  accountNumber:   String,                                          // Số TK nhận
  subAccount:      { type: String, default: null },
  code:            { type: String, default: null },                 // Mã SePay tách (nếu cấu hình prefix)
  content:         String,                                          // Nội dung CK (vd "BKD9CMKA 555888")
  transferType:    { type: String, enum: ['in', 'out'] },           // 'in' = tiền vào
  transferAmount:  Number,                                          // Số tiền giao dịch
  accumulated:     Number,                                          // Số dư sau giao dịch
  referenceCode:   String,                                          // Mã tham chiếu ngân hàng
  matchedInvoice:  { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
}, { timestamps: true });

// ⚠ KHÔNG khai báo lại sepayTxSchema.index({ sepayId: 1 }, { unique: true })
//    vì 'unique: true' ở field trên ĐÃ tạo index. Khai cả hai gây warning
//    "Duplicate schema index on {sepayId:1}".

// Index phụ giúp truy vấn nhanh khi /sepay/match lọc giao dịch chưa khớp
sepayTxSchema.index({ transferType: 1, matchedInvoice: 1, createdAt: 1 });

module.exports = mongoose.model('SepayTransaction', sepayTxSchema);