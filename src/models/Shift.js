// backend/src/models/Shift.js
//
// ⭐ UPDATED 14/05/2026: Multi-user shift + auto-chain
//   Workflow mới:
//   1. NV mở ca → cash đầu ca + bank đầu ca
//   2. Có thể thêm "lễ tân phụ" (assistants) làm cùng ca
//   3. Mọi Transaction tự gắn shiftId trong khoảng thời gian ca
//   4. Khi đóng ca: MỖI user kiểm đếm riêng (closingCounts[])
//      → Tổng phải khớp két thực tế
//   5. Hệ thống tự tính chênh lệch, tự CHAIN ca mới:
//      - Người đóng ca tự động được mở ca mới (status='open')
//      - openingCash của ca mới = actualCash của ca cũ
//      - previousShiftId/nextShiftId link 2 ca với nhau
//
// Phạm vi:
//   - 1 branch chỉ có TỐI ĐA 1 ca 'open' tại 1 thời điểm (két chung)
//   - Nhiều user có thể cùng làm trong 1 ca (1 primary + N assistants)
//
const mongoose = require('mongoose');
const { Schema } = mongoose;

// ═══════════════════════════════════════════════════════════════════════
// Sub-schema: ClosingCount — Mỗi user trong ca kiểm đếm riêng khi đóng
// ═══════════════════════════════════════════════════════════════════════
const ClosingCountSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    userFullName: String,         // snapshot tên user (audit, tránh lookup)
    cashCounted: {                // Tiền mặt user này đếm được
      type: Number,
      default: 0,
      min: 0,
    },
    note: { type: String, default: '', maxlength: 300 },
    countedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

// ═══════════════════════════════════════════════════════════════════════
// Sub-schema: Assistant — Lễ tân phụ trong ca
// ═══════════════════════════════════════════════════════════════════════
const AssistantSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    userFullName: String,        // snapshot
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    leftAt: {                    // Khi assistant rời ca (optional)
      type: Date,
      default: null,
    },
    note: { type: String, default: '', maxlength: 200 },
  },
  { _id: true }
);

// ═══════════════════════════════════════════════════════════════════════
// Main Shift Schema
// ═══════════════════════════════════════════════════════════════════════
const ShiftSchema = new Schema(
  {
    // ─── Identification ────────────────────────────────────────────
    // Primary user (mở ca, chịu trách nhiệm chính)
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      index: true,
    },
    shiftCode: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    label: {
      type: String,
      default: '',
      maxlength: 100,
    },

    // ─── ⭐ NEW: Multi-user — Lễ tân phụ ─────────────────────────────
    assistants: {
      type: [AssistantSchema],
      default: [],
    },

    // ─── ⭐ NEW: Auto-chain — Link 2 ca liên tiếp ────────────────────
    previousShiftId: {            // Ca trước (set khi mở ca này từ đóng ca cũ)
      type: Schema.Types.ObjectId,
      ref: 'Shift',
      default: null,
      index: true,
    },
    nextShiftId: {                // Ca sau (set khi đóng ca này + mở ca mới)
      type: Schema.Types.ObjectId,
      ref: 'Shift',
      default: null,
    },

    // ─── Mở ca ─────────────────────────────────────────────────────
    openedAt: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    openingCash: {
      type: Number,
      default: 0,
      min: 0,
    },
    openingBankBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    openingNote: {
      type: String,
      default: '',
      maxlength: 500,
    },

    // ─── Đóng ca ───────────────────────────────────────────────────
    closedAt: {
      type: Date,
      default: null,
      index: true,
    },
    // ⭐ Tổng tiền thực tế trong két (= sum closingCounts[].cashCounted)
    actualCash: {
      type: Number,
      default: 0,
      min: 0,
    },
    // ⭐ NEW: Mỗi user trong ca kiểm đếm riêng (Option C)
    closingCounts: {
      type: [ClosingCountSchema],
      default: [],
    },
    // ⭐ NEW 14/05/2026: Bàn giao chia 2 phần
    //   actualCash = handoverToNext + handoverToManager
    //   - handoverToNext: tiền chuyển sang ca kế tiếp (= openingCash của ca mới khi auto-chain)
    //   - handoverToManager: tiền nộp lại cho quản lý (gửi NH, két cố định, v.v.)
    handoverToNext: {
      type: Number,
      default: 0,
      min: 0,
    },
    handoverToManager: {
      type: Number,
      default: 0,
      min: 0,
    },
    handoverReceiver: {              // Người nhận bàn giao (quản lý hoặc lễ tân ca sau)
      type: String,
      default: '',
      maxlength: 100,
    },
    bankStatementBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    closingNote: {
      type: String,
      default: '',
      maxlength: 1000,
    },

    // ─── Summary (snapshot khi đóng ca) ───────────────────────────
    summary: {
      cashIn:     { type: Number, default: 0 },
      transferIn: { type: Number, default: 0 },
      cardIn:     { type: Number, default: 0 },
      otherIn:    { type: Number, default: 0 },
      cashOut:     { type: Number, default: 0 },
      transferOut: { type: Number, default: 0 },
      cardOut:     { type: Number, default: 0 },
      otherOut:    { type: Number, default: 0 },
      transactionCount: { type: Number, default: 0 },
    },

    // ─── Chênh lệch ────────────────────────────────────────────────
    expectedCash: { type: Number, default: 0 },
    cashDifference: { type: Number, default: 0 },
    expectedBankBalance: { type: Number, default: 0 },
    bankDifference: { type: Number, default: 0 },

    // ─── Bàn giao (handover) ───────────────────────────────────────
    //   Trong workflow mới (auto-chain), handover là tự động:
    //   - closedBy = người mở ca tiếp theo
    //   - handedOverTo = closedBy (cùng người)
    //   Nếu khác người: set handedOverTo riêng
    handedOverTo: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    handoverConfirmedAt: {
      type: Date,
      default: null,
    },
    handoverNote: {
      type: String,
      default: '',
      maxlength: 500,
    },

    // ─── Status ────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['open', 'closed', 'handed_over', 'reconciled', 'disputed'],
      default: 'open',
      index: true,
    },

    // ─── Audit ─────────────────────────────────────────────────────
    closedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    reconciledBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    reconciledAt: { type: Date },
  },
  { timestamps: true }
);

// ─── Indexes ────────────────────────────────────────────────────────
ShiftSchema.index({ user: 1, status: 1 });
ShiftSchema.index({ branchId: 1, openedAt: -1 });
ShiftSchema.index({ branchId: 1, status: 1, openedAt: -1 });
// ⭐ NEW: Index cho "Ca đang mở của branch" (chỉ 1 ca/branch/lần)
ShiftSchema.index(
  { branchId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } }
);

// ─── Static helpers ─────────────────────────────────────────────────

/**
 * Tìm ca đang OPEN của 1 branch (chỉ 1 ca/branch)
 */
ShiftSchema.statics.findOpenShiftInBranch = function (branchId) {
  return this.findOne({ branchId, status: 'open' });
};

/**
 * ⭐ Check user có thuộc ca này không (primary hoặc assistant)
 */
ShiftSchema.statics.isUserInShift = function (shift, userId) {
  if (!shift) return false;
  if (String(shift.user?._id ?? shift.user) === String(userId)) return true;
  return (shift.assistants ?? []).some(
    (a) => String(a.userId?._id ?? a.userId) === String(userId)
            && !a.leftAt   // chỉ tính assistant đang active
  );
};

/**
 * Tìm ca đang OPEN của 1 user (primary hoặc assistant)
 */
ShiftSchema.statics.findOpenShiftForUser = async function (userId, branchId) {
  const filter = { status: 'open' };
  if (branchId) filter.branchId = branchId;
  filter.$or = [
    { user: userId },
    {
      assistants: {
        $elemMatch: { userId, leftAt: null },
      },
    },
  ];
  return this.findOne(filter);
};

/**
 * Snapshot tổng thu/chi từ Transactions
 *
 * ⭐ UPDATED 14/05/2026 v2: Robust paymentMethod handling
 *   - Chuẩn hoá về lowercase string
 *   - Map các alias: 'bank'/'momo'/'vnpay'/'zalopay' → 'transfer'
 *   - Map 'credit'/'debit' → 'card'
 *   - Nếu là ObjectId → lookup PaymentMethod.type → map theo type
 *   - Còn lại → 'other'
 */
ShiftSchema.statics.computeShiftSummary = async function (shiftId) {
  const Transaction = mongoose.model('Transaction');

  const txs = await Transaction.find({
    shiftId: new mongoose.Types.ObjectId(shiftId),
  }).select('type amount paymentMethod').lean();

  // Map alias → enum chuẩn
  const ALIAS_MAP = {
    cash: 'cash',
    transfer: 'transfer',
    bank: 'transfer',
    banking: 'transfer',
    momo: 'transfer',
    vnpay: 'transfer',
    zalopay: 'transfer',
    card: 'card',
    credit: 'card',
    debit: 'card',
  };

  // ⭐ Pre-load PaymentMethod cache nếu có ObjectId trong tx
  const objectIdPMs = new Set();
  for (const t of txs) {
    const raw = String(t.paymentMethod || '').toLowerCase();
    if (/^[0-9a-f]{24}$/.test(raw)) objectIdPMs.add(raw);
  }
  const pmTypeCache = {};   // ObjectId string → type ('cash'/'transfer'/...)
  if (objectIdPMs.size > 0) {
    try {
      const PaymentMethod = require('./PaymentMethod');
      const docs = await PaymentMethod.find({
        _id: { $in: Array.from(objectIdPMs) },
      }).select('type').lean();
      for (const d of docs) {
        pmTypeCache[String(d._id).toLowerCase()] = String(d.type || '').toLowerCase();
      }
    } catch (e) {
      // Non-fatal
    }
  }

  const summary = {
    cashIn: 0, transferIn: 0, cardIn: 0, otherIn: 0,
    cashOut: 0, transferOut: 0, cardOut: 0, otherOut: 0,
    transactionCount: 0,
  };

  for (const t of txs) {
    let rawPm = String(t.paymentMethod || '').toLowerCase().trim();

    // Nếu là ObjectId → resolve sang type qua PaymentMethod
    if (/^[0-9a-f]{24}$/.test(rawPm) && pmTypeCache[rawPm]) {
      rawPm = pmTypeCache[rawPm];
    }

    const pm = ALIAS_MAP[rawPm] || 'other';
    const key = t.type === 'income' ? `${pm}In` : `${pm}Out`;
    if (summary[key] !== undefined) {
      summary[key] += Number(t.amount) || 0;
    }
    summary.transactionCount++;
  }
  return summary;
};

module.exports = mongoose.model('Shift', ShiftSchema);