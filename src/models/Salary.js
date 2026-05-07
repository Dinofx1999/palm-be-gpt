// backend/src/models/Salary.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────
// 1) SalaryConfig — cơ cấu lương riêng từng user
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
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
      index: true,
    },
    components: { type: [SalaryComponentSchema], default: [] },
    currency: { type: String, default: 'VND' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// ─────────────────────────────────────────────────────────────────────────
// 2) Tier — 1 bậc % vượt KPI
//    upToPercent: % vượt tối đa của bậc này (vd 20 = vượt đến 20%)
//    percent:     % thưởng áp cho phần vượt khi rơi vào bậc này
// ─────────────────────────────────────────────────────────────────────────
const TierSchema = new Schema(
  {
    upToPercent: { type: Number, required: true, min: 0 },
    percent: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

// Mỗi role có: basePercent + tiers + underTargetPolicy
const RoleKpiSchema = new Schema(
  {
    basePercent: { type: Number, default: 0, min: 0 },
    tiers: { type: [TierSchema], default: [] },
    underTargetPolicy: {
      type: String,
      enum: ['none', 'prorata'],
      default: 'none',
    },
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────
// 3) KpiConfig — 1 cấu hình per branch
//    target: 1 mục tiêu doanh thu chung cho cả branch
//    roles:  { Manager, Receptionist, Staff } — mỗi role 1 RoleKpi
// ─────────────────────────────────────────────────────────────────────────
const KpiConfigSchema = new Schema(
  {
    branchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      unique: true,
      index: true,
    },
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
// 4) SalaryRecord — snapshot khi chốt lương
// ─────────────────────────────────────────────────────────────────────────
const SalaryRecordSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null },
    role: { type: String },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
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
    note: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

SalaryRecordSchema.index({ user: 1, year: 1, month: 1 }, { unique: true });

const SalaryConfig = mongoose.model('SalaryConfig', SalaryConfigSchema);
const KpiConfig = mongoose.model('KpiConfig', KpiConfigSchema);
const SalaryRecord = mongoose.model('SalaryRecord', SalaryRecordSchema);

module.exports = { SalaryConfig, KpiConfig, SalaryRecord };