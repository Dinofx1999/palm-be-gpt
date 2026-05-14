// backend/src/routes/profit.js
//
// ⭐ NEW 14/05/2026: Báo cáo lợi nhuận (P&L)
//
// Công thức:
//   Tổng doanh thu = sum(Booking.totalAmount where status=checked_out, theo tháng)
//   Tổng lương    = sum(SalaryRecord.total where paidStatus=paid, theo tháng)
//   Tổng thu khác = sum(Transaction where type=income, theo tháng)
//   Tổng chi khác = sum(Transaction where type=expense, theo tháng)
//
//   Lợi nhuận gộp = Doanh thu - Chi khác
//   Lợi nhuận ròng = Doanh thu - Lương - Chi khác + Thu khác
//
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const Booking = require('../models/Booking');
const Transaction = require('../models/Transaction');
const { SalaryRecord } = require('../models/Salary');
const { authenticate } = require('../middleware/auth');

const canView = (user) => ['Admin', 'Manager'].includes(user.role);

// ═════════════════════════════════════════════════════════════════════════
// GET /api/profit/monthly?year=2026&month=5&branchId=...
// Trả về P&L 1 tháng
// ═════════════════════════════════════════════════════════════════════════
router.get('/monthly', authenticate, async (req, res) => {
  try {
    if (!canView(req.user)) {
      return res.status(403).json({ success: false, message: 'Chỉ Admin/Manager mới xem được lợi nhuận' });
    }

    const now = new Date();
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);

    let bId = req.query.branchId;
    if (req.user.role === 'Manager') {
      bId = String(req.user.branchId);
    }

    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 1);

    // Filter branch nếu có
    const branchObjectId = bId && mongoose.isValidObjectId(bId)
      ? new mongoose.Types.ObjectId(bId)
      : null;

    // ─── 1. Tổng doanh thu (Booking checked_out) ─────────────────────────
    const bookingMatch = {
      status: 'checked_out',
      checkOut: { $gte: start, $lt: end },
    };
    if (branchObjectId) bookingMatch.branchId = branchObjectId;

    const revenueAgg = await Booking.aggregate([
      { $match: bookingMatch },
      { $group: {
        _id: null,
        total: { $sum: '$totalAmount' },
        count: { $sum: 1 },
        rooms: { $sum: '$roomAmount' },
        services: { $sum: '$servicesAmount' },
      }},
    ]);
    const revenueRow = revenueAgg[0] || {};
    const totalRevenue = revenueRow.total || 0;
    const totalBookings = revenueRow.count || 0;
    const roomRevenue = revenueRow.rooms || 0;
    const servicesRevenue = revenueRow.services || 0;

    // ─── 2. Tổng lương (SalaryRecord đã trả) ─────────────────────────────
    const salaryMatch = {
      year,
      month,
      paidStatus: 'paid',
    };
    if (branchObjectId) salaryMatch.branchId = branchObjectId;

    const salaryAgg = await SalaryRecord.aggregate([
      { $match: salaryMatch },
      { $group: {
        _id: null,
        total: { $sum: '$total' },
        count: { $sum: 1 },
      }},
    ]);
    const totalSalary = salaryAgg[0]?.total || 0;
    const paidStaffCount = salaryAgg[0]?.count || 0;

    // Cũng tính lương ĐÃ DỰ KIẾN (chưa trả) — để Admin/Manager thấy cả planning
    const salaryPlannedMatch = { year, month };
    if (branchObjectId) salaryPlannedMatch.branchId = branchObjectId;
    const salaryPlannedAgg = await SalaryRecord.aggregate([
      { $match: salaryPlannedMatch },
      { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } },
    ]);
    const totalSalaryPlanned = salaryPlannedAgg[0]?.total || 0;
    const totalStaff = salaryPlannedAgg[0]?.count || 0;

    // ─── 3. Tổng thu khác + chi khác (Transaction) ───────────────────────
    // ⚠️ QUAN TRỌNG: Loại bỏ Transaction sync từ Invoice Payment (relatedType='invoice_payment')
    //   khỏi "thu khác" vì đã được tính trong `revenue` (Booking.totalAmount) rồi.
    //   Nếu không loại → double-count doanh thu.
    const txMatch = {
      occurredOn: { $gte: start, $lt: end },
      // Chỉ lấy transaction THUẦN (không liên kết booking)
      $or: [
        { relatedType: { $ne: 'invoice_payment' } },
        { relatedType: null },
        { relatedType: { $exists: false } },
      ],
    };
    if (branchObjectId) txMatch.branchId = branchObjectId;

    const txAgg = await Transaction.aggregate([
      { $match: txMatch },
      { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    let otherIncome = 0, otherExpense = 0;
    let otherIncomeCount = 0, otherExpenseCount = 0;
    for (const r of txAgg) {
      if (r._id === 'income')  { otherIncome  = r.total; otherIncomeCount  = r.count; }
      if (r._id === 'expense') { otherExpense = r.total; otherExpenseCount = r.count; }
    }

    // ─── 4. Breakdown chi tiêu theo category ─────────────────────────────
    //   Cũng exclude transaction từ booking (chỉ để hiển thị các khoản "khác")
    const breakdownAgg = await Transaction.aggregate([
      { $match: txMatch },
      { $group: {
        _id: { type: '$type', category: '$category' },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      }},
      { $sort: { total: -1 } },
    ]);
    const breakdownIncome = breakdownAgg
      .filter(r => r._id.type === 'income')
      .map(r => ({ category: r._id.category, total: r.total, count: r.count }));
    const breakdownExpense = breakdownAgg
      .filter(r => r._id.type === 'expense')
      .map(r => ({ category: r._id.category, total: r.total, count: r.count }));

    // ─── 5. Tính lợi nhuận ───────────────────────────────────────────────
    // Gross = Doanh thu - Chi khác (chưa trừ lương)
    const grossProfit = totalRevenue - otherExpense;
    // Net = Doanh thu - Lương - Chi khác + Thu khác
    const netProfit = totalRevenue - totalSalary - otherExpense + otherIncome;
    const netProfitPlanned = totalRevenue - totalSalaryPlanned - otherExpense + otherIncome;

    // Margin %
    const netMargin = totalRevenue > 0
      ? Math.round((netProfit / totalRevenue) * 100 * 100) / 100
      : 0;

    res.json({
      success: true,
      data: {
        year,
        month,
        period: `${month}/${year}`,
        branchId: bId || null,

        // Doanh thu
        revenue: {
          total: totalRevenue,
          fromRooms: roomRevenue,
          fromServices: servicesRevenue,
          bookingCount: totalBookings,
        },

        // Chi phí
        cost: {
          salary: totalSalary,                  // Đã trả thực tế
          salaryPlanned: totalSalaryPlanned,    // Tổng lương kỳ (cả chưa trả)
          paidStaffCount,
          totalStaff,
          otherExpense,
          totalCost: totalSalary + otherExpense,
          totalCostPlanned: totalSalaryPlanned + otherExpense,
        },

        // Thu khác
        otherIncome: {
          total: otherIncome,
          count: txSummary.incomeCount,
        },

        // Lợi nhuận
        profit: {
          gross: grossProfit,
          net: netProfit,
          netPlanned: netProfitPlanned,
          netMargin,
          netMarginLabel: `${netMargin}%`,
        },

        // Breakdown
        breakdownExpense,
        breakdownIncome,
      },
    });
  } catch (err) {
    console.error('[GET /profit/monthly]', err);
    res.status(500).json({ success: false, message: err.message || 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/profit/trend?months=6&branchId=...
// Trend lợi nhuận N tháng gần đây (cho chart)
// ═════════════════════════════════════════════════════════════════════════
router.get('/trend', authenticate, async (req, res) => {
  try {
    if (!canView(req.user)) {
      return res.status(403).json({ success: false, message: 'Không có quyền' });
    }

    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 12);
    let bId = req.query.branchId;
    if (req.user.role === 'Manager') bId = String(req.user.branchId);

    const now = new Date();
    const trend = [];

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const start = new Date(y, m - 1, 1);
      const end = new Date(y, m, 1);

      const branchObjectId = bId && mongoose.isValidObjectId(bId)
        ? new mongoose.Types.ObjectId(bId)
        : null;

      const bookingMatch = { status: 'checked_out', checkOut: { $gte: start, $lt: end } };
      if (branchObjectId) bookingMatch.branchId = branchObjectId;

      const salaryMatch = { year: y, month: m, paidStatus: 'paid' };
      if (branchObjectId) salaryMatch.branchId = branchObjectId;

      const [revRow, salRow, txAggMonth] = await Promise.all([
        Booking.aggregate([
          { $match: bookingMatch },
          { $group: { _id: null, total: { $sum: '$totalAmount' } } },
        ]),
        SalaryRecord.aggregate([
          { $match: salaryMatch },
          { $group: { _id: null, total: { $sum: '$total' } } },
        ]),
        // ⭐ Exclude transaction sync từ booking (đã tính trong revenue)
        Transaction.aggregate([
          { $match: {
            occurredOn: { $gte: start, $lt: end },
            ...(branchObjectId ? { branchId: branchObjectId } : {}),
            $or: [
              { relatedType: { $ne: 'invoice_payment' } },
              { relatedType: null },
              { relatedType: { $exists: false } },
            ],
          }},
          { $group: { _id: '$type', total: { $sum: '$amount' } } },
        ]),
      ]);

      const revenue = revRow[0]?.total || 0;
      const salary = salRow[0]?.total || 0;
      let otherIncome = 0, otherExpense = 0;
      for (const r of txAggMonth) {
        if (r._id === 'income')  otherIncome  = r.total;
        if (r._id === 'expense') otherExpense = r.total;
      }
      const netProfit = revenue - salary - otherExpense + otherIncome;

      trend.push({
        year: y,
        month: m,
        period: `${m}/${y}`,
        revenue,
        salary,
        otherExpense,
        otherIncome,
        netProfit,
        netMargin: revenue > 0 ? Math.round((netProfit / revenue) * 100 * 100) / 100 : 0,
      });
    }

    res.json({ success: true, data: { months, trend } });
  } catch (err) {
    console.error('[GET /profit/trend]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

module.exports = router;