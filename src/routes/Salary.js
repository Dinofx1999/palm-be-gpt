// models/Salary.js
// Schema gợi ý cho việc lưu cấu hình lương của từng nhân viên
// Thiết kế tách riêng "config" (cố định) và "monthly record" (theo tháng)
// để bạn dễ dàng truy vấn lịch sử + tính lương từng kỳ.

const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Một khoản lương trong cơ cấu lương.
 * Ví dụ: { name: "Lương cơ bản", amount: 15000000 }
 *        { name: "Phụ cấp ăn trưa", amount: 2000000 }
 *        { name: "Lương năng lực", amount: 5000000 }
 */
const SalaryComponentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0, default: 0 },
    note: { type: String, default: '' },
  },
  { _id: true }
);

/**
 * Cấu hình KPI doanh thu.
 * - target:           mục tiêu doanh thu tháng (vd 250.000.000)
 * - basePercent:      % thưởng khi đạt đủ target (vd 10 = 10% của target)
 * - exceedPercent:    % thưởng cho phần vượt (vd 0.1 = 0.1% của phần vượt)
 *
 * Công thức tính:
 *   if revenue >= target:
 *      bonus = target * basePercent/100
 *            + (revenue - target) * exceedPercent/100
 *   else:
 *      // Tuỳ chính sách. Mặc định: nếu chưa đạt thì không có KPI.
 *      bonus = 0
 *      // Nếu muốn pro-rate: bonus = revenue * basePercent/100
 */
const KpiConfigSchema = new Schema(
  {
    target: { type: Number, default: 0, min: 0 },
    basePercent: { type: Number, default: 0, min: 0 },     // %
    exceedPercent: { type: Number, default: 0, min: 0 },   // %
    // Cờ điều khiển khi chưa đạt target:
    //  - 'none'    : không trả KPI
    //  - 'prorata' : trả theo tỉ lệ thực đạt
    underTargetPolicy: {
      type: String,
      enum: ['none', 'prorata'],
      default: 'none',
    },
  },
  { _id: false }
);

/**
 * Cấu hình lương của một user (1-1).
 * Đây là phần Admin "Setup lương".
 */
const SalaryConfigSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    components: { type: [SalaryComponentSchema], default: [] },
    kpi: { type: KpiConfigSchema, default: () => ({}) },
    currency: { type: String, default: 'VND' },
    effectiveFrom: { type: Date, default: Date.now },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

/**
 * Bản ghi lương theo tháng (snapshot khi chốt lương).
 * Giúp truy vết lịch sử khi cấu hình thay đổi.
 */
const SalaryRecordSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },

    // Snapshot cấu hình tại thời điểm chốt
    components: { type: [SalaryComponentSchema], default: [] },
    kpi: { type: KpiConfigSchema, default: () => ({}) },

    // Doanh thu thực tế của tháng đó
    revenue: { type: Number, default: 0 },

    // Kết quả tính
    fixedTotal: { type: Number, default: 0 },     // tổng từ components
    kpiBase: { type: Number, default: 0 },        // phần KPI đạt target
    kpiExceed: { type: Number, default: 0 },      // phần vượt
    total: { type: Number, default: 0 },          // tổng lương cuối cùng

    note: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

SalaryRecordSchema.index({ user: 1, year: 1, month: 1 }, { unique: true });

module.exports = {
  SalaryConfig: mongoose.model('SalaryConfig', SalaryConfigSchema),
  SalaryRecord: mongoose.model('SalaryRecord', SalaryRecordSchema),
};