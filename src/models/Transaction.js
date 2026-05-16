// backend/src/models/Transaction.js
//
// ⭐ NEW 14/05/2026: Module Thu/Chi (Income/Expense)
//   - Một collection cho cả thu và chi (phân biệt qua `type`)
//   - Tích hợp với phân tích lợi nhuận (Profit) và AI chat
//
const mongoose = require('mongoose');
const { Schema } = mongoose;

// Một số category preset — UI auto-suggest khi nhập
const COMMON_INCOME_CATEGORIES = [
  'Cho thuê hội nghị',
  'Dịch vụ giặt là',
  'Bán đồ minibar',
  'Bán đồ lưu niệm',
  'Tiền phạt khách',
  'Bồi thường',
  'Thu khác',
];

const COMMON_EXPENSE_CATEGORIES = [
  'Tiền điện',
  'Tiền nước',
  'Tiền internet',
  'Marketing & quảng cáo',
  'OTA commission',
  'Sửa chữa & bảo trì',
  'Mua sắm vật tư',
  'Văn phòng phẩm',
  'Vệ sinh & tẩy rửa',
  'Tiền thuê mặt bằng',
  'Phí giao dịch ngân hàng',
  'Phí phần mềm',
  'Tiếp khách',
  'Thuế & lệ phí',
  'Chi khác',
];

const TransactionSchema = new Schema(
  {
    type: {
      type: String,
      enum: ['income', 'expense'],
      required: true,
      index: true,
    },
    category: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    description: {
      type: String,
      default: '',
      maxlength: 1000,
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      index: true,
    },
    occurredOn: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: ['cash', 'transfer', 'card', 'other'],
      default: 'cash',
    },
    // Liên kết với entity gốc (nếu có)
    //   - 'invoice_payment': auto-tạo khi POST /invoices/:id/payment
    //   - 'salary': auto-tạo khi trả lương (TODO)
    //   - 'manual': nhập tay (default)
    relatedType: {
      type: String,
      enum: ['invoice_payment', 'salary', 'manual', null],
      default: 'manual',
    },
    relatedId: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    // ⭐ NEW 14/05/2026: Link với Shift (ca trực) đang mở của user khi tạo
    //   - Auto-set bởi middleware trong routes (tìm Shift open của recordedBy)
    //   - null nếu user không có ca đang mở (vd: Admin nhập từ máy tính khác)
    //   - Dùng cho: báo cáo ca trực, đối soát, tìm chênh lệch
    shiftId: {
      type: Schema.Types.ObjectId,
      ref: 'Shift',
      default: null,
      index: true,
    },
    // Hoá đơn / chứng từ
    attachments: {
      type: [String],
      default: [],
    },
    // Audit
    recordedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    note: {
      type: String,
      default: '',
      maxlength: 500,
    },

    // ⭐ NEW 15/05/2026: Audit khi payment liên kết bị sửa/huỷ
    isEdited: { type: Boolean, default: false },
    lastEditedAt: { type: Date, default: null },

    // ⭐ Soft cancel khi user huỷ payment liên kết
    isCancelled: { type: Boolean, default: false },
    cancelledAt: { type: Date, default: null },
    cancelledReason: { type: String, default: '', maxlength: 500 },

    // ⭐ NEW 15/05/2026: Đối soát chuyển khoản với sao kê NH
    //   Manager tick checkbox khi đã xác nhận gd này có trong sao kê NH
    isReconciled: { type: Boolean, default: false, index: true },
    reconciledAt: { type: Date, default: null },
    reconciledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reconciledByName: { type: String, default: '' },
  },
  { timestamps: true }
);

// ⭐ Index cho query đối soát
TransactionSchema.index({ branchId: 1, paymentMethod: 1, occurredOn: -1, isReconciled: 1 });

// Index combo cho query thường dùng: list theo branch + tháng + type
TransactionSchema.index({ branchId: 1, occurredOn: -1, type: 1 });
TransactionSchema.index({ branchId: 1, category: 1, occurredOn: -1 });
// ⭐ NEW: Index cho query theo shift + paymentMethod (đối soát)
TransactionSchema.index({ shiftId: 1, type: 1, paymentMethod: 1 });
TransactionSchema.index({ branchId: 1, paymentMethod: 1, occurredOn: -1 });
TransactionSchema.index({ recordedBy: 1, occurredOn: -1 });

// Helper static: tính tổng theo tháng
TransactionSchema.statics.totalForMonth = async function (branchId, year, month, type = null) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  const match = {
    occurredOn: { $gte: start, $lt: end },
  };
  if (branchId) match.branchId = new mongoose.Types.ObjectId(branchId);
  if (type) match.type = type;

  const result = await this.aggregate([
    { $match: match },
    { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);

  // Format kết quả thành object dễ dùng
  const summary = { income: 0, expense: 0, incomeCount: 0, expenseCount: 0 };
  for (const r of result) {
    if (r._id === 'income') {
      summary.income = r.total;
      summary.incomeCount = r.count;
    } else if (r._id === 'expense') {
      summary.expense = r.total;
      summary.expenseCount = r.count;
    }
  }
  return summary;
};

// Helper static: breakdown theo category
TransactionSchema.statics.breakdownByCategory = async function (branchId, year, month, type) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  const match = {
    type,
    occurredOn: { $gte: start, $lt: end },
  };
  if (branchId) match.branchId = new mongoose.Types.ObjectId(branchId);

  return this.aggregate([
    { $match: match },
    { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]).then(results => results.map(r => ({
    category: r._id,
    total: r.total,
    count: r.count,
  })));
};

const Transaction = mongoose.model('Transaction', TransactionSchema);

module.exports = Transaction;
module.exports.COMMON_INCOME_CATEGORIES = COMMON_INCOME_CATEGORIES;
module.exports.COMMON_EXPENSE_CATEGORIES = COMMON_EXPENSE_CATEGORIES;