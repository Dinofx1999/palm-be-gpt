// backend/src/models/Reconciliation.js
//
// ⭐ NEW 14/05/2026: Đối soát thu chi (Reconciliation)
//
// Mục đích:
//   So sánh số liệu HỆ THỐNG (auto từ Transaction + Invoice payments)
//   với số liệu THỰC TẾ (Manager đếm tiền + sao kê banking + POS settlement).
//   Phát hiện chênh lệch để truy vết.
//
// Khác với Shift:
//   - Shift: 1 ca trực (vài tiếng), 1 NV chịu trách nhiệm
//   - Reconciliation: Theo ngày/tuần/tháng, Manager/Admin chốt toàn cảnh
//
// Workflow:
//   1. Manager mở "Đối soát ngày 14/05"
//   2. Hệ thống auto-fill systemCashIn, systemTransferIn từ Transaction collection
//   3. Manager nhập:
//      - actualCash (tiền mặt thật trong két)
//      - bankStatementIn (từ app banking)
//      - cardSettlement (từ máy POS)
//   4. Hệ thống tính chênh lệch từng loại
//   5. Manager submit → Admin duyệt → status='approved'
//   6. Nếu có disputed → log + alert
//
const mongoose = require('mongoose');
const { Schema } = mongoose;

// ─── Sub-schema: Detail breakdown theo paymentMethod ────────────────
//   Cho mỗi loại thanh toán: hệ thống vs thực tế + chênh lệch
const PaymentMethodDetailSchema = new Schema(
  {
    // Số liệu hệ thống (auto-fetch)
    systemIn:  { type: Number, default: 0 },     // Thu (income)
    systemOut: { type: Number, default: 0 },     // Chi (expense)
    systemNet: { type: Number, default: 0 },     // Net = In - Out

    // Số liệu thực tế (Manager nhập)
    actualIn:  { type: Number, default: 0 },
    actualOut: { type: Number, default: 0 },
    actualNet: { type: Number, default: 0 },

    // Chênh lệch
    difference: { type: Number, default: 0 },    // actualNet - systemNet
    note: { type: String, default: '', maxlength: 500 },
  },
  { _id: false }
);

// ─── Sub-schema: Attachment (file evidence) ──────────────────────────
const AttachmentSchema = new Schema(
  {
    url: { type: String, required: true },
    name: { type: String, default: '' },
    type: { type: String, default: '' },         // 'bank_statement', 'pos_settlement', 'cash_count_photo'
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

// ─── Main schema ────────────────────────────────────────────────────
const ReconciliationSchema = new Schema(
  {
    branchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      index: true,
    },
    reconciliationCode: {
      type: String,
      unique: true,
      sparse: true,
    },

    // ─── Kỳ đối soát ────────────────────────────────────────────────
    period: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'custom'],
      default: 'daily',
      required: true,
    },
    fromDate: {
      type: Date,
      required: true,
      index: true,
    },
    toDate: {
      type: Date,
      required: true,
      index: true,
    },
    label: {                                      // VD: "Đối soát 14/05/2026"
      type: String,
      default: '',
      maxlength: 200,
    },

    // ─── Số liệu chi tiết theo paymentMethod ───────────────────────
    //   Lưu cả cash/transfer/card riêng → đối soát chính xác từng kênh
    cash:     { type: PaymentMethodDetailSchema, default: () => ({}) },
    transfer: { type: PaymentMethodDetailSchema, default: () => ({}) },
    card:     { type: PaymentMethodDetailSchema, default: () => ({}) },
    other:    { type: PaymentMethodDetailSchema, default: () => ({}) },

    // ─── Tổng hợp ───────────────────────────────────────────────────
    totalSystemIn:  { type: Number, default: 0 },
    totalSystemOut: { type: Number, default: 0 },
    totalActualIn:  { type: Number, default: 0 },
    totalActualOut: { type: Number, default: 0 },
    totalDifference: { type: Number, default: 0 },

    // ─── Liên kết shifts đã đóng trong kỳ ───────────────────────────
    //   Để Manager xem chi tiết: kỳ này gồm bao nhiêu ca, ai trực
    shiftIds: [{
      type: Schema.Types.ObjectId,
      ref: 'Shift',
    }],
    shiftCount: { type: Number, default: 0 },

    // ─── Approval workflow ──────────────────────────────────────────
    status: {
      type: String,
      enum: ['draft', 'submitted', 'approved', 'disputed', 'archived'],
      default: 'draft',
      index: true,
    },

    // ─── Audit + signatures ─────────────────────────────────────────
    createdBy: {                                  // Người tạo (Manager)
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    submittedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    submittedAt: Date,
    approvedBy: {                                 // Admin duyệt
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    approvedAt: Date,
    rejectedReason: {
      type: String,
      default: '',
      maxlength: 1000,
    },

    // ─── Attachments (sao kê, ảnh đếm tiền, settlement) ──────────────
    attachments: { type: [AttachmentSchema], default: [] },

    // ─── Notes ──────────────────────────────────────────────────────
    notes: {
      type: String,
      default: '',
      maxlength: 2000,
    },
    // Lý do giải trình từng chênh lệch (Manager phải nhập nếu có chênh lệch)
    discrepancyExplanations: [{
      paymentMethod: { type: String, enum: ['cash', 'transfer', 'card', 'other'] },
      amount: Number,
      reason: String,
      _id: false,
    }],
  },
  { timestamps: true }
);

// ─── Indexes ────────────────────────────────────────────────────────
ReconciliationSchema.index({ branchId: 1, fromDate: -1 });
ReconciliationSchema.index({ branchId: 1, status: 1, fromDate: -1 });
ReconciliationSchema.index({ branchId: 1, period: 1, fromDate: -1 });
// Tránh tạo 2 đối soát trùng kỳ cho 1 branch
ReconciliationSchema.index(
  { branchId: 1, period: 1, fromDate: 1, toDate: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['draft', 'submitted', 'approved'] } } }
);

// ─── Pre-save: auto-generate code + label ──────────────────────────
// ⭐ FIX 15/05: Dùng callback-style với next() — chắc chắn tương thích
//   mọi version Mongoose, tránh confusion với async function
ReconciliationSchema.pre('save', function (next) {
  try {
    if (this.isNew && !this.reconciliationCode) {
      const d = this.fromDate || new Date();
      const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
      this.reconciliationCode = `REC_${dateStr}_${rand}`;
    }
    if (!this.label) {
      const fromStr = this.fromDate?.toLocaleDateString('vi-VN');
      const toStr = this.toDate?.toLocaleDateString('vi-VN');
      if (this.period === 'daily') {
        this.label = `Đối soát ngày ${fromStr}`;
      } else if (this.period === 'weekly') {
        this.label = `Đối soát tuần ${fromStr} - ${toStr}`;
      } else if (this.period === 'monthly') {
        const m = this.fromDate?.getMonth() + 1;
        const y = this.fromDate?.getFullYear();
        this.label = `Đối soát tháng ${m}/${y}`;
      } else {
        this.label = `Đối soát ${fromStr} - ${toStr}`;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
});

// ─── Pre-save: auto-tính totals từ chi tiết ────────────────────────
ReconciliationSchema.pre('save', function (next) {
  try {
    const methods = ['cash', 'transfer', 'card', 'other'];

    let totalSystemIn = 0;
    let totalSystemOut = 0;
    let totalActualIn = 0;
    let totalActualOut = 0;
    let totalDifference = 0;

    for (const m of methods) {
      const detail = this[m] || {};
      detail.systemNet = (detail.systemIn || 0) - (detail.systemOut || 0);
      detail.actualNet = (detail.actualIn || 0) - (detail.actualOut || 0);
      detail.difference = detail.actualNet - detail.systemNet;

      totalSystemIn  += detail.systemIn || 0;
      totalSystemOut += detail.systemOut || 0;
      totalActualIn  += detail.actualIn || 0;
      totalActualOut += detail.actualOut || 0;
      totalDifference += detail.difference;
    }

    this.totalSystemIn = totalSystemIn;
    this.totalSystemOut = totalSystemOut;
    this.totalActualIn = totalActualIn;
    this.totalActualOut = totalActualOut;
    this.totalDifference = totalDifference;
    this.shiftCount = (this.shiftIds || []).length;

    next();
  } catch (err) {
    next(err);
  }
});

// ─── Static helpers ─────────────────────────────────────────────────

/**
 * Auto-fetch số liệu hệ thống từ Transaction collection theo kỳ
 * Trả về object có thể plug thẳng vào Reconciliation document
 */
ReconciliationSchema.statics.fetchSystemData = async function (branchId, fromDate, toDate) {
  const Transaction = require('./Transaction');

  const match = {
    occurredOn: { $gte: new Date(fromDate), $lte: new Date(toDate) },
  };
  if (branchId) match.branchId = new mongoose.Types.ObjectId(branchId);

  const agg = await Transaction.aggregate([
    { $match: match },
    {
      $group: {
        _id: { type: '$type', paymentMethod: '$paymentMethod' },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
  ]);

  // Initialize structure
  const result = {
    cash:     { systemIn: 0, systemOut: 0 },
    transfer: { systemIn: 0, systemOut: 0 },
    card:     { systemIn: 0, systemOut: 0 },
    other:    { systemIn: 0, systemOut: 0 },
    transactionCount: 0,
  };

  for (const row of agg) {
    const { type, paymentMethod } = row._id;
    const pm = ['cash', 'transfer', 'card'].includes(paymentMethod)
      ? paymentMethod
      : 'other';
    const direction = type === 'income' ? 'systemIn' : 'systemOut';
    result[pm][direction] += row.total;
    result.transactionCount += row.count;
  }

  return result;
};

/**
 * Lấy danh sách shift đã closed trong kỳ — để link vào reconciliation
 */
ReconciliationSchema.statics.fetchShiftsInPeriod = async function (branchId, fromDate, toDate) {
  const Shift = require('./Shift');
  return Shift.find({
    branchId,
    closedAt: { $gte: new Date(fromDate), $lte: new Date(toDate) },
    status: { $in: ['closed', 'handed_over', 'reconciled'] },
  })
    .select('_id user shiftCode openedAt closedAt cashDifference bankDifference status')
    .populate('user', 'fullName username')
    .sort({ openedAt: 1 })
    .lean();
};

module.exports = mongoose.model('Reconciliation', ReconciliationSchema);