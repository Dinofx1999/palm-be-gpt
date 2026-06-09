// backend/src/models/Salary.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────
// SalaryConfig
// ─────────────────────────────────────────────────────────────────────────
const SalaryComponentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0, default: 0 },
    note: { type: String, default: '' },
  },
  { _id: true }
);

const SalaryConfigSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // ⭐ NEW 30/05/2026: cơ cấu lương THEO KỲ (year/month).
    //   null/0 = bản "gốc" (cấu hình cũ trước khi tách kỳ) — dùng làm mặc định lùi về.
    //   Đọc config 1 tháng: lấy bản đúng kỳ, nếu không có → lấy kỳ gần nhất TRƯỚC đó (carry-forward).
    year:  { type: Number, default: 0, index: true },
    month: { type: Number, default: 0, min: 0, max: 12, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    components: { type: [SalaryComponentSchema], default: [] },
    currency: { type: String, default: 'VND' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// ⭐ Mỗi NV chỉ 1 cấu hình cho mỗi kỳ (user + year + month)
SalaryConfigSchema.index({ user: 1, year: 1, month: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────────────────
// KpiConfig
// ─────────────────────────────────────────────────────────────────────────
const TierSchema = new Schema(
  {
    upToPercent: { type: Number, required: true, min: 0 },
    percent: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const RoleKpiSchema = new Schema(
  {
    basePercent: { type: Number, default: 0, min: 0 },
    tiers: { type: [TierSchema], default: [] },
    underTargetPolicy: { type: String, enum: ['none', 'prorata'], default: 'none' },
  },
  { _id: false }
);

const KpiConfigSchema = new Schema(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, unique: true, index: true },
    target: { type: Number, default: 0, min: 0 },
    roles: {
      Manager: { type: RoleKpiSchema, default: () => ({}) },
      Receptionist: { type: RoleKpiSchema, default: () => ({}) },
      Staff: { type: RoleKpiSchema, default: () => ({}) },
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// ─────────────────────────────────────────────────────────────────────────
// Penalty snapshot — dùng trong SalaryRecord
// ─────────────────────────────────────────────────────────────────────────
const PenaltySnapshotSchema = new Schema(
  {
    penaltyId: { type: Schema.Types.ObjectId, ref: 'Penalty' },
    name: { type: String, required: true },
    type: { type: String },
    minutes: { type: Number, default: 0 },
    severityName: { type: String, default: '' },
    amount: { type: Number, required: true, min: 0 },
    reason: { type: String, default: '' },
    occurredOn: { type: Date },
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────
// SalaryRecord
// ─────────────────────────────────────────────────────────────────────────
const DiscountChargeSnapshotSchema = new Schema(
  {
    bookingId:    { type: Schema.Types.ObjectId, ref: 'Booking' },
    bookingCode:  { type: String, default: '' },
    roomNumber:   { type: String, default: '' },
    customerName: { type: String, default: '' },
    amount:       { type: Number, required: true, min: 0 },
    reason:       { type: String, default: '' },
    appliedAt:    { type: Date },
  },
  { _id: false }
);

const SalaryRecordSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    role: { type: String },

    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },

    components: { type: [SalaryComponentSchema], default: [] },
    target: { type: Number, default: 0 },
    basePercent: { type: Number, default: 0 },
    appliedTier: { upToPercent: Number, percent: Number },
    revenue: { type: Number, default: 0 },
    fixedTotal: { type: Number, default: 0 },
    kpiBase: { type: Number, default: 0 },
    kpiExceed: { type: Number, default: 0 },

    // ⭐ Phạt
    penalties: { type: [PenaltySnapshotSchema], default: [] },
    penaltyTotal: { type: Number, default: 0 },

    // ⭐ NEW 19/05/2026: Discount NV chịu trách nhiệm (trừ vào lương cuối tháng)
    discountCharges:      { type: [DiscountChargeSnapshotSchema], default: [] },
    discountChargesTotal: { type: Number, default: 0 },

    total: { type: Number, default: 0 },

      // ⭐ NEW 11/05/2026: Snapshot lương ứng tại thời điểm chốt lương
    advanceTotal:    { type: Number, default: 0 },
    remainingToPay:  { type: Number, default: 0 },

    paidStatus: { type: String, enum: ['paid', 'unpaid'], default: 'paid', index: true },
    paidAt: { type: Date, default: Date.now },
    paymentMethod: { type: String, enum: ['cash', 'transfer'], default: 'cash' },
    paidNote: { type: String, default: '' },
    paidBy: { type: Schema.Types.ObjectId, ref: 'User' },

    note: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

SalaryRecordSchema.index({ user: 1, year: 1, month: 1 }, { unique: true });

// ⭐ NEW 30/05/2026: Lấy cơ cấu lương áp dụng cho 1 kỳ (year/month), có CARRY-FORWARD.
//   Ưu tiên: bản đúng kỳ → bản kỳ gần nhất TRƯỚC đó → bản gốc (year:0) → null.
//   VD: tháng 7 chưa cấu hình riêng → tự lấy cấu hình tháng 6.
SalaryConfigSchema.statics.getConfigForPeriod = async function (userId, year, month) {
  const ym = Number(year) * 12 + (Number(month) - 1); // chỉ số tháng tuyệt đối
  // Lấy tất cả config của NV, chọn bản phù hợp nhất ở tầng ứng dụng (an toàn, dễ hiểu)
  const all = await this.find({ user: userId }).lean();
  if (!all.length) return null;

  // tách bản gốc (year=0) và các bản theo kỳ
  let root = null;
  const dated = [];
  for (const c of all) {
    if (!c.year || !c.month) root = c;                 // bản gốc
    else dated.push({ ...c, _ym: c.year * 12 + (c.month - 1) });
  }

  // bản có kỳ <= kỳ yêu cầu, gần nhất
  const eligible = dated
    .filter((c) => c._ym <= ym)
    .sort((a, b) => b._ym - a._ym);

  if (eligible.length) return eligible[0];
  // không có bản kỳ nào trước/bằng → dùng bản gốc nếu có
  return root;
};

const SalaryConfig = mongoose.model('SalaryConfig', SalaryConfigSchema);
const KpiConfig = mongoose.model('KpiConfig', KpiConfigSchema);
const SalaryRecord = mongoose.model('SalaryRecord', SalaryRecordSchema);

module.exports = { SalaryConfig, KpiConfig, SalaryRecord };