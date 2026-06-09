// backend/src/routes/reportsAnalytics.js
// ⭐ NEW 30/05/2026: API Báo cáo phân tích (Component Báo cáo)
//   - GET /profit?from=&to=&branchId=  → Lợi nhuận = income - expense - lương realtime
//   Mount: app.use('/api/reports-analytics', require('./routes/reportsAnalytics'))
//
// Lưu ý: KHÔNG đụng routes/reports.js (gửi báo cáo email) — đây là file riêng.

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { SalaryConfig, KpiConfig, SalaryRecord } = require('../models/Salary');
const { calculateSalary } = require('../utils/Salarycalculator');
const { authenticate } = require('../middleware/auth');

// ── Quyền xem báo cáo: Admin/Manager ──
const canViewReports = (user) =>
  user && (user.role === 'Admin' || user.role === 'Manager');

// Chuẩn hóa khoảng thời gian từ query (from/to ISO, hoặc year/month).
function resolveRange(q) {
  if (q.from && q.to) {
    return { from: new Date(q.from), to: new Date(q.to) };
  }
  const year = parseInt(q.year, 10) || new Date().getFullYear();
  const month = parseInt(q.month, 10) || (new Date().getMonth() + 1);
  return {
    from: new Date(year, month - 1, 1),
    to: new Date(year, month, 1), // đầu tháng kế (exclusive)
  };
}

// Tổng lương realtime của các NV trong 1 chi nhánh (hoặc tất cả) cho 1 kỳ.
//   Vì cấu hình lương theo kỳ (year/month), ta tính theo THÁNG mà khoảng [from,to] chạm tới.
//   Cách đơn giản & nhất quán với module lương: tính theo từng tháng giao với khoảng,
//   nhưng để gọn, dùng tháng của `from` (báo cáo theo tháng là chính).
async function totalSalaryRealtime(branchId, year, month) {
  const filter = { isActive: true };
  if (branchId) filter.branchId = new mongoose.Types.ObjectId(branchId);

  const users = await User.find(filter).select('_id role branchId createdAt').lean();
  let total = 0;

  for (const u of users) {
    // bỏ NV chưa vào làm tại kỳ này
    if (u.createdAt) {
      const j = new Date(u.createdAt);
      const joinYM = j.getFullYear() * 12 + j.getMonth();
      if (year * 12 + (month - 1) < joinYM) continue;
    }

    // Đã chốt → lấy record; chưa → tính realtime
    const record = await SalaryRecord.findOne({ user: u._id, year, month }).lean();
    if (record) {
      total += record.total || 0;
      continue;
    }

    const cfg = await SalaryConfig.getConfigForPeriod(u._id, year, month);
    const components = cfg?.components || [];
    const fixedTotal = components.reduce((s, c) => s + (Number(c.amount) || 0), 0);
    if (fixedTotal <= 0) continue; // NV nghỉ kỳ này → không tính

    // KPI: cần target + roleKpi của branch
    let target = 0;
    let roleKpi = {};
    if (u.role !== 'Admin' && u.branchId) {
      const kpiCfg = await KpiConfig.findOne({ branchId: u.branchId }).lean();
      if (kpiCfg) {
        target = kpiCfg.target || 0;
        roleKpi = kpiCfg.roles?.[u.role] || {};
      }
    }
    // revenue cho KPI: bỏ qua (không có service tính nhanh ở đây) → KPI exceed = 0.
    // Lương cố định vẫn được tính đầy đủ; KPI thưởng (nếu có) sẽ được phản ánh khi chốt.
    const result = calculateSalary(
      { components, target, roleKpi, penalties: [] },
      0
    );
    total += result.total || 0;
  }

  return total;
}

// ─────────────────────────────────────────────────────────────────────
// GET /api/reports-analytics/profit?from=&to=&branchId=  (hoặc ?year=&month=)
// ─────────────────────────────────────────────────────────────────────
router.get('/profit', authenticate, async (req, res) => {
  try {
    if (!canViewReports(req.user)) {
      return res.status(403).json({ success: false, message: 'Không có quyền xem báo cáo' });
    }

    // Chi nhánh: Admin có thể chọn (hoặc null = tất cả); Manager ép theo branch của mình.
    let branchId = null;
    if (req.user.role === 'Admin') {
      if (req.query.branchId && mongoose.isValidObjectId(req.query.branchId)) {
        branchId = req.query.branchId;
      }
    } else {
      branchId = req.user.branchId ? String(req.user.branchId) : null;
    }

    const { from, to } = resolveRange(req.query);

    // 1) Doanh thu + chi từ transactions (bỏ giao dịch đã huỷ)
    const match = {
      occurredOn: { $gte: from, $lt: to },
      isCancelled: { $ne: true },
    };
    if (branchId) match.branchId = new mongoose.Types.ObjectId(branchId);

    const agg = await Transaction.aggregate([
      { $match: match },
      { $group: { _id: '$type', total: { $sum: '$amount' } } },
    ]);
    let income = 0;
    let expense = 0;
    for (const r of agg) {
      if (r._id === 'income') income = r.total;
      else if (r._id === 'expense') expense = r.total;
    }

    // 2) Lương realtime — tính theo tháng của `from`
    const y = from.getFullYear();
    const m = from.getMonth() + 1;
    const salaryTotal = await totalSalaryRealtime(branchId, y, m);

    // 3) Lợi nhuận
    const profit = income - expense - salaryTotal;

    res.json({
      success: true,
      data: {
        from, to,
        branchId: branchId || null,
        income,
        expense,
        salaryTotal,
        profit,
      },
    });
  } catch (err) {
    console.error('[GET /reports-analytics/profit]', err);
    res.status(500).json({ success: false, message: err.message || 'Lỗi server' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/reports-analytics/discounts?from=&to=&branchId=
//   Trả 2 nhóm:
//   - hotel: mọi booking có discount > 0 trong kỳ (giảm giá chung khách sạn)
//   - staff: booking có discount > 0 VÀ gán NV chịu (discountChargedTo)
// ─────────────────────────────────────────────────────────────────────
router.get('/discounts', authenticate, async (req, res) => {
  try {
    if (!canViewReports(req.user)) {
      return res.status(403).json({ success: false, message: 'Không có quyền xem báo cáo' });
    }

    let branchId = null;
    if (req.user.role === 'Admin') {
      if (req.query.branchId && mongoose.isValidObjectId(req.query.branchId)) {
        branchId = req.query.branchId;
      }
    } else {
      branchId = req.user.branchId ? String(req.user.branchId) : null;
    }

    const { from, to } = resolveRange(req.query);

    const Booking = require('../models/Booking');

    const match = {
      discount: { $gt: 0 },
      discountAppliedAt: { $gte: from, $lt: to },
      status: { $nin: ['cancelled'] },
    };
    if (branchId) match.branchId = new mongoose.Types.ObjectId(branchId);

    const bookings = await Booking.find(match)
      .select('_id bookingCode roomNumber customerName discount discountReason discountAppliedAt discountChargedTo branchId')
      .populate('discountChargedTo', 'fullName username')
      .sort({ discountAppliedAt: -1 })
      .lean();

    const hotel = [];   // tất cả giảm giá (chung khách sạn)
    const staff = [];   // các khoản NV chịu
    let hotelTotal = 0;
    let staffTotal = 0;

    for (const b of bookings) {
      const row = {
        bookingId: b._id,
        bookingCode: b.bookingCode || '',
        roomNumber: b.roomNumber || '',
        customerName: b.customerName || '',
        amount: Number(b.discount) || 0,
        reason: b.discountReason || '',
        appliedAt: b.discountAppliedAt,
        chargedTo: b.discountChargedTo
          ? (b.discountChargedTo.fullName || b.discountChargedTo.username || '')
          : '',
      };
      hotel.push(row);
      hotelTotal += row.amount;
      if (b.discountChargedTo) {
        staff.push(row);
        staffTotal += row.amount;
      }
    }

    res.json({
      success: true,
      data: { from, to, hotel, staff, hotelTotal, staffTotal },
    });
  } catch (err) {
    console.error('[GET /reports-analytics/discounts]', err);
    res.status(500).json({ success: false, message: err.message || 'Lỗi server' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/reports-analytics/profit-trend?branchId=
//   - series: 12 tháng gần nhất [{ label, year, month, income, expense, salary, profit }]
//   - cumulative: lợi nhuận lũy kế TỪ ĐẦU = (Σincome - Σexpense toàn bộ) - (Σlương đã chốt)
// ─────────────────────────────────────────────────────────────────────
router.get('/profit-trend', authenticate, async (req, res) => {
  try {
    if (!canViewReports(req.user)) {
      return res.status(403).json({ success: false, message: 'Không có quyền xem báo cáo' });
    }

    let branchId = null;
    if (req.user.role === 'Admin') {
      if (req.query.branchId && mongoose.isValidObjectId(req.query.branchId)) {
        branchId = req.query.branchId;
      }
    } else {
      branchId = req.user.branchId ? String(req.user.branchId) : null;
    }
    const branchObjId = branchId ? new mongoose.Types.ObjectId(branchId) : null;

    const now = new Date();
    const curY = now.getFullYear();
    const curM = now.getMonth() + 1;

    // 12 kỳ gần nhất (cũ → mới)
    const periods = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(curY, curM - 1 - i, 1);
      periods.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    }

    const rangeStart = new Date(periods[0].year, periods[0].month - 1, 1);
    const rangeEnd = new Date(curY, curM, 1); // đầu tháng kế

    // Income/expense theo tháng (1 truy vấn gộp)
    const txMatch = {
      occurredOn: { $gte: rangeStart, $lt: rangeEnd },
      isCancelled: { $ne: true },
    };
    if (branchObjId) txMatch.branchId = branchObjId;

    const txAgg = await Transaction.aggregate([
      { $match: txMatch },
      {
        $group: {
          _id: { y: { $year: '$occurredOn' }, m: { $month: '$occurredOn' }, type: '$type' },
          total: { $sum: '$amount' },
        },
      },
    ]);
    const txMap = new Map(); // key 'y-m' → { income, expense }
    for (const r of txAgg) {
      const key = `${r._id.y}-${r._id.m}`;
      const cur = txMap.get(key) || { income: 0, expense: 0 };
      if (r._id.type === 'income') cur.income += r.total;
      else if (r._id.type === 'expense') cur.expense += r.total;
      txMap.set(key, cur);
    }

    // Lương đã chốt theo tháng (1 truy vấn) — dùng cho series (nhẹ, chính xác sổ sách)
    const srMatch = {
      $or: periods.map((p) => ({ year: p.year, month: p.month })),
    };
    if (branchObjId) srMatch.branchId = branchObjId;
    const srAgg = await SalaryRecord.aggregate([
      { $match: srMatch },
      { $group: { _id: { y: '$year', m: '$month' }, total: { $sum: '$total' } } },
    ]);
    const srMap = new Map();
    for (const r of srAgg) srMap.set(`${r._id.y}-${r._id.m}`, r.total);

    const series = periods.map((p) => {
      const key = `${p.year}-${p.month}`;
      const tx = txMap.get(key) || { income: 0, expense: 0 };
      const salary = srMap.get(key) || 0;
      return {
        label: `${String(p.month).padStart(2, '0')}/${String(p.year).slice(-2)}`,
        year: p.year,
        month: p.month,
        income: tx.income,
        expense: tx.expense,
        salary,
        profit: tx.income - tx.expense - salary,
      };
    });

    // Lũy kế TỪ ĐẦU (toàn bộ lịch sử)
    const allTxMatch = { isCancelled: { $ne: true } };
    if (branchObjId) allTxMatch.branchId = branchObjId;
    const allTxAgg = await Transaction.aggregate([
      { $match: allTxMatch },
      { $group: { _id: '$type', total: { $sum: '$amount' } } },
    ]);
    let allIncome = 0;
    let allExpense = 0;
    for (const r of allTxAgg) {
      if (r._id === 'income') allIncome = r.total;
      else if (r._id === 'expense') allExpense = r.total;
    }

    const allSalaryMatch = {};
    if (branchObjId) allSalaryMatch.branchId = branchObjId;
    const allSalaryAgg = await SalaryRecord.aggregate([
      { $match: allSalaryMatch },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]);
    const allSalary = allSalaryAgg[0]?.total || 0;

    const cumulativeProfit = allIncome - allExpense - allSalary;

    res.json({
      success: true,
      data: {
        series,
        cumulative: {
          income: allIncome,
          expense: allExpense,
          salary: allSalary,
          profit: cumulativeProfit,
        },
      },
    });
  } catch (err) {
    console.error('[GET /reports-analytics/profit-trend]', err);
    res.status(500).json({ success: false, message: err.message || 'Lỗi server' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/reports-analytics/profit-series?mode=day|week|month&date=&branchId=
//   Trả chuỗi điểm "lợi nhuận = thu - chi" theo bucket, kèm kỳ trước để so sánh.
//   - day:   24 bucket theo giờ (0..23); kỳ trước = hôm trước
//   - week:  7 bucket T2..CN; kỳ trước = tuần trước
//   - month: theo ngày trong tháng; kỳ trước = tháng trước
//   `date` = ngày tham chiếu (ISO). Mặc định hôm nay.
// ─────────────────────────────────────────────────────────────────────
router.get('/profit-series', authenticate, async (req, res) => {
  try {
    if (!canViewReports(req.user)) {
      return res.status(403).json({ success: false, message: 'Không có quyền xem báo cáo' });
    }

    let branchId = null;
    if (req.user.role === 'Admin') {
      if (req.query.branchId && mongoose.isValidObjectId(req.query.branchId)) {
        branchId = req.query.branchId;
      }
    } else {
      branchId = req.user.branchId ? String(req.user.branchId) : null;
    }
    const branchObjId = branchId ? new mongoose.Types.ObjectId(branchId) : null;

    const mode = ['day', 'week', 'month'].includes(req.query.mode) ? req.query.mode : 'day';
    const ref = req.query.date ? new Date(req.query.date) : new Date();

    // Xác định [start,end) của kỳ hiện tại + kỳ trước, và hàm chia bucket.
    let curStart, curEnd, prevStart, prevEnd, bucketOf, labels;

    if (mode === 'day') {
      curStart = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
      curEnd = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + 1);
      prevStart = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 1);
      prevEnd = curStart;
      labels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}h`);
      bucketOf = (d, base) => Math.floor((d - base) / 3600000); // giờ
    } else if (mode === 'week') {
      // Tuần bắt đầu Thứ 2
      const day = (ref.getDay() + 6) % 7; // 0=T2..6=CN
      const monday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - day);
      curStart = monday;
      curEnd = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7);
      prevStart = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7);
      prevEnd = monday;
      labels = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
      bucketOf = (d, base) => Math.floor((d - base) / 86400000); // ngày
    } else {
      // month
      curStart = new Date(ref.getFullYear(), ref.getMonth(), 1);
      curEnd = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
      prevStart = new Date(ref.getFullYear(), ref.getMonth() - 1, 1);
      prevEnd = curStart;
      const daysInMonth = new Date(ref.getFullYear(), ref.getMonth() + 1, 0).getDate();
      labels = Array.from({ length: daysInMonth }, (_, i) => String(i + 1));
      bucketOf = (d, base) => Math.floor((d - base) / 86400000); // ngày
    }

    // Lấy giao dịch (thu/chi) trong 1 khoảng → trả mảng profit theo bucket.
    async function seriesFor(start, end, base, nBuckets) {
      const match = {
        occurredOn: { $gte: start, $lt: end },
        isCancelled: { $ne: true },
      };
      if (branchObjId) match.branchId = branchObjId;
      const txs = await Transaction.find(match).select('type amount occurredOn').lean();

      const arr = new Array(nBuckets).fill(0);
      for (const t of txs) {
        const idx = bucketOf(new Date(t.occurredOn), base);
        if (idx < 0 || idx >= nBuckets) continue;
        arr[idx] += (t.type === 'income' ? 1 : -1) * (Number(t.amount) || 0);
      }
      return arr;
    }

    const n = labels.length;
    const [curArr, prevArr] = await Promise.all([
      seriesFor(curStart, curEnd, curStart, n),
      seriesFor(prevStart, prevEnd, prevStart, n),
    ]);

    const series = labels.map((label, i) => ({
      label,
      current: curArr[i],
      previous: prevArr[i],
    }));

    res.json({
      success: true,
      data: {
        mode,
        current: { from: curStart, to: curEnd },
        previous: { from: prevStart, to: prevEnd },
        series,
        currentTotal: curArr.reduce((s, v) => s + v, 0),
        previousTotal: prevArr.reduce((s, v) => s + v, 0),
      },
    });
  } catch (err) {
    console.error('[GET /reports-analytics/profit-series]', err);
    res.status(500).json({ success: false, message: err.message || 'Lỗi server' });
  }
});

module.exports = router;