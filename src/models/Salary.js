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
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    components: { type: [SalaryComponentSchema], default: [] },
    currency: { type: String, default: 'VND' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

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
// SalaryRecord — snapshot + trạng thái thanh toán
// ─────────────────────────────────────────────────────────────────────────
const SalaryRecordSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    role: { type: String },

    // Kỳ lương
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },

    // Snapshot data (chốt khi đánh dấu đã trả)
    components: { type: [SalaryComponentSchema], default: [] },
    target: { type: Number, default: 0 },
    basePercent: { type: Number, default: 0 },
    appliedTier: {
      upToPercent: Number,
      percent: Number,
    },
    revenue: { type: Number, default: 0 },
    fixedTotal: { type: Number, default: 0 },
    kpiBase: { type: Number, default: 0 },
    kpiExceed: { type: Number, default: 0 },
    total: { type: Number, default: 0 },

    // ⭐ Trạng thái thanh toán
    paidStatus: {
      type: String,
      enum: ['paid', 'unpaid'],
      default: 'paid', // mặc định khi tạo record là đã trả (vì gộp 1 nút)
      index: true,
    },
    paidAt: { type: Date, default: Date.now },
    paymentMethod: {
      type: String,
      enum: ['cash', 'transfer'],
      default: 'cash',
    },
    paidNote: { type: String, default: '' },
    paidBy: { type: Schema.Types.ObjectId, ref: 'User' },

    note: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// 1 user × 1 month × 1 year = 1 record duy nhất
SalaryRecordSchema.index({ user: 1, year: 1, month: 1 }, { unique: true });

const SalaryConfig = mongoose.model('SalaryConfig', SalaryConfigSchema);
const KpiConfig = mongoose.model('KpiConfig', KpiConfigSchema);
const SalaryRecord = mongoose.model('SalaryRecord', SalaryRecordSchema);

module.exports = { SalaryConfig, KpiConfig, SalaryRecord };