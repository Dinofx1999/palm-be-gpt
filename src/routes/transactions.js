// backend/src/routes/transactions.js
//
// ⭐ NEW 14/05/2026: Routes Thu/Chi
//   - CRUD giao dịch
//   - Summary theo tháng (tổng thu, tổng chi)
//   - Breakdown theo category
//   - Categories preset cho UI auto-suggest
//
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const Transaction = require('../models/Transaction');
const { COMMON_INCOME_CATEGORIES, COMMON_EXPENSE_CATEGORIES } = require('../models/Transaction');
const { authenticate } = require('../middleware/auth');

// ── Permission helpers ──────────────────────────────────────────────────
// ⭐ UPDATED 14/05/2026: Cho phép mọi role đăng nhập đều nhập được Thu/Chi
//   (Receptionist/Staff cũng có thể ghi nhận chi phí lặt vặt trong ca trực)
const canCreateTransaction = (user) => !!user;

// Sửa thì:
//   - Admin: sửa/xoá mọi giao dịch
//   - Manager: sửa/xoá giao dịch trong branch của mình
//   - Receptionist/Staff: chỉ sửa/xoá giao dịch DO CHÍNH MÌNH tạo (recordedBy === user.id)
const canEditTransaction = (user, transaction) => {
  if (user.role === 'Admin') return true;
  if (user.role === 'Manager') {
    return String(transaction.branchId) === String(user.branchId);
  }
  // Receptionist/Staff: chỉ giao dịch của mình
  return String(transaction.recordedBy) === String(user.id);
};

const canViewTransactions = (user) => !!user;   // Mọi role đăng nhập đều xem được

// Filter scope theo role: Manager/Receptionist → chỉ branch của họ
function applyScopeFilter(filter, user) {
  if (user.role === 'Admin') return filter;
  if (!user.branchId) {
    // Non-admin chưa có branch → không thấy gì
    filter.branchId = null;
    return filter;
  }
  filter.branchId = user.branchId;
  return filter;
}

// ═════════════════════════════════════════════════════════════════════════
// GET /api/transactions — List với filter + pagination
//
// ⭐ UPDATED 14/05/2026: Thêm nhiều bộ lọc mới
//
// Query params (tất cả optional):
//   type            : 'income' | 'expense'
//   category        : 'Tiền điện' | 'Marketing' ... (single hoặc array)
//   paymentMethod   : 'cash' | 'transfer' | 'card' | 'other' (single hoặc array)
//   recordedBy      : userId (lọc theo NV ghi nhận)
//   shiftId         : shiftId (lọc theo ca trực)
//   relatedType     : 'manual' | 'invoice_payment' | 'salary'
//   minAmount, maxAmount : khoảng tiền
//   year, month     : nhanh theo tháng
//   fromDate, toDate: tự do theo khoảng ngày (override year/month)
//   branchId        : Admin only
//   search          : text search trong category/description/note
//   sortBy          : 'occurredOn' (default) | 'amount' | 'createdAt'
//   sortOrder       : 'asc' | 'desc' (default)
//   page, limit     : pagination
// ═════════════════════════════════════════════════════════════════════════
router.get('/', authenticate, async (req, res) => {
  try {
    if (!canViewTransactions(req.user)) {
      return res.status(403).json({ success: false, message: 'Không có quyền xem' });
    }

    const filter = {};

    // ─── 1. Type ──────────────────────────────────────────────────────
    if (req.query.type && ['income', 'expense'].includes(req.query.type)) {
      filter.type = req.query.type;
    }

    // ─── 2. Category (single hoặc array via comma) ────────────────────
    if (req.query.category) {
      const categories = String(req.query.category).split(',').map(s => s.trim()).filter(Boolean);
      filter.category = categories.length === 1 ? categories[0] : { $in: categories };
    }

    // ─── 3. PaymentMethod (single hoặc array) ─────────────────────────
    if (req.query.paymentMethod) {
      const methods = String(req.query.paymentMethod).split(',')
        .map(s => s.trim())
        .filter(m => ['cash', 'transfer', 'card', 'other'].includes(m));
      if (methods.length > 0) {
        filter.paymentMethod = methods.length === 1 ? methods[0] : { $in: methods };
      }
    }

    // ─── 4. RelatedType (manual / invoice_payment / salary) ───────────
    if (req.query.relatedType) {
      const types = String(req.query.relatedType).split(',')
        .map(s => s.trim())
        .filter(t => ['manual', 'invoice_payment', 'salary'].includes(t));
      if (types.length > 0) {
        filter.relatedType = types.length === 1 ? types[0] : { $in: types };
      }
    }

    // ─── 5. RecordedBy (lọc theo NV) ──────────────────────────────────
    if (req.query.recordedBy && mongoose.isValidObjectId(req.query.recordedBy)) {
      filter.recordedBy = req.query.recordedBy;
    }

    // ─── 6. ShiftId (lọc theo ca trực) ────────────────────────────────
    if (req.query.shiftId && mongoose.isValidObjectId(req.query.shiftId)) {
      filter.shiftId = req.query.shiftId;
    }

    // ─── 7. Branch filter ──────────────────────────────────────────────
    if (req.user.role === 'Admin' && req.query.branchId) {
      if (!mongoose.isValidObjectId(req.query.branchId)) {
        return res.status(400).json({ success: false, message: 'branchId không hợp lệ' });
      }
      filter.branchId = req.query.branchId;
    } else {
      applyScopeFilter(filter, req.user);
    }

    // ─── 8. Date filter ────────────────────────────────────────────────
    //   fromDate/toDate có priority cao hơn year/month
    //   FE gửi ISO đầy đủ với startOf('day') / endOf('day') của VN time
    //   → BE chỉ cần parse trực tiếp
    if (req.query.fromDate || req.query.toDate) {
      filter.occurredOn = {};
      if (req.query.fromDate) {
        const d = new Date(req.query.fromDate);
        if (!isNaN(d.getTime())) filter.occurredOn.$gte = d;
      }
      if (req.query.toDate) {
        const d = new Date(req.query.toDate);
        if (!isNaN(d.getTime())) filter.occurredOn.$lte = d;
      }
    } else {
      const year = parseInt(req.query.year, 10);
      const month = parseInt(req.query.month, 10);
      if (year && month) {
        const start = new Date(year, month - 1, 1);
        const end = new Date(year, month, 1);
        filter.occurredOn = { $gte: start, $lt: end };
      }
    }

    // ─── 9. Amount range ───────────────────────────────────────────────
    if (req.query.minAmount || req.query.maxAmount) {
      filter.amount = {};
      if (req.query.minAmount) filter.amount.$gte = Number(req.query.minAmount) || 0;
      if (req.query.maxAmount) filter.amount.$lte = Number(req.query.maxAmount) || 0;
    }

    // ─── 10. Text search ───────────────────────────────────────────────
    if (req.query.search) {
      // Nếu đã có $or (từ scope), phải merge — nhưng hiện tại scope dùng filter cứng
      filter.$or = [
        { category:    { $regex: req.query.search, $options: 'i' } },
        { description: { $regex: req.query.search, $options: 'i' } },
        { note:        { $regex: req.query.search, $options: 'i' } },
      ];
    }

    // ─── Sort ──────────────────────────────────────────────────────────
    const allowedSortFields = ['occurredOn', 'amount', 'createdAt'];
    const sortBy = allowedSortFields.includes(req.query.sortBy) ? req.query.sortBy : 'occurredOn';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortOrder };
    if (sortBy !== 'createdAt') sort.createdAt = -1;   // Secondary sort

    // ─── Pagination ────────────────────────────────────────────────────
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const [data, total, sumAgg] = await Promise.all([
      Transaction.find(filter)
        .populate('branchId', 'name')
        .populate('recordedBy', 'fullName username')
        .populate('shiftId', 'shiftCode label')
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Transaction.countDocuments(filter),
      // ⭐ NEW: Tổng theo type trong filter hiện tại (cho UI hiển thị summary của filter)
      Transaction.aggregate([
        { $match: filter },
        { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
    ]);

    // Format summary
    let filteredIncome = 0, filteredExpense = 0;
    let filteredIncomeCount = 0, filteredExpenseCount = 0;
    for (const r of sumAgg) {
      if (r._id === 'income')  { filteredIncome  = r.total; filteredIncomeCount  = r.count; }
      if (r._id === 'expense') { filteredExpense = r.total; filteredExpenseCount = r.count; }
    }

    res.json({
      success: true,
      data: {
        data,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        // Summary của filter hiện tại (tổng tiền theo bộ lọc đang áp dụng)
        filteredSummary: {
          income: filteredIncome,
          expense: filteredExpense,
          net: filteredIncome - filteredExpense,
          incomeCount: filteredIncomeCount,
          expenseCount: filteredExpenseCount,
        },
      },
    });
  } catch (err) {
    console.error('[GET /transactions]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/transactions/summary — Tổng thu, tổng chi tháng
// Query: ?year=2026&month=5&branchId=...
// ═════════════════════════════════════════════════════════════════════════
router.get('/summary', authenticate, async (req, res) => {
  try {
    if (!canViewTransactions(req.user)) {
      return res.status(403).json({ success: false, message: 'Không có quyền' });
    }

    const now = new Date();
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);

    let bId = req.query.branchId;
    if (req.user.role !== 'Admin') {
      bId = req.user.branchId;
    }

    // ⭐ Cho phép query mode: 'all' = bao gồm cả Tiền phòng từ booking,
    //   'manual' (default) = chỉ thu/chi khác do nhập tay
    //   FE trang Thu/Chi default 'manual', dashboard Lợi nhuận có thể dùng 'all'
    const mode = req.query.mode === 'all' ? 'all' : 'manual';

    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 1);
    // ⭐ FIX 14/05/2026: `new Date(year, month, 1)` tạo theo LOCAL time của server.
    //   Server local nếu khác VN sẽ lệch — nhưng nếu server set TZ=Asia/Ho_Chi_Minh
    //   thì OK. Đây giữ nguyên vì summary endpoint dùng cho cùng query month-only.
    //   Nếu deploy server TZ khác VN, cần parse cẩn thận hơn như filter ở list endpoint.
    const match = { occurredOn: { $gte: start, $lt: end } };
    if (bId && mongoose.isValidObjectId(bId)) {
      match.branchId = new mongoose.Types.ObjectId(bId);
    }
    if (mode === 'manual') {
      match.$or = [
        { relatedType: { $ne: 'invoice_payment' } },
        { relatedType: null },
        { relatedType: { $exists: false } },
      ];
    }

    const [totals, byCategory] = await Promise.all([
      Transaction.aggregate([
        { $match: match },
        { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Transaction.aggregate([
        { $match: match },
        { $group: {
          _id: { type: '$type', category: '$category' },
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        }},
        { $sort: { total: -1 } },
      ]),
    ]);

    let income = 0, expense = 0, incomeCount = 0, expenseCount = 0;
    for (const r of totals) {
      if (r._id === 'income')  { income  = r.total; incomeCount  = r.count; }
      if (r._id === 'expense') { expense = r.total; expenseCount = r.count; }
    }
    const breakdownIncome = byCategory.filter(r => r._id.type === 'income')
      .map(r => ({ category: r._id.category, total: r.total, count: r.count }));
    const breakdownExpense = byCategory.filter(r => r._id.type === 'expense')
      .map(r => ({ category: r._id.category, total: r.total, count: r.count }));

    res.json({
      success: true,
      data: {
        year,
        month,
        mode,
        branchId: bId || null,
        income,
        expense,
        net: income - expense,
        incomeCount,
        expenseCount,
        breakdownIncome,
        breakdownExpense,
      },
    });
  } catch (err) {
    console.error('[GET /transactions/summary]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/transactions/categories — Categories preset + custom đã dùng
// ═════════════════════════════════════════════════════════════════════════
router.get('/categories', authenticate, async (req, res) => {
  try {
    if (!canViewTransactions(req.user)) {
      return res.status(403).json({ success: false, message: 'Không có quyền' });
    }

    const filter = {};
    applyScopeFilter(filter, req.user);

    // Lấy distinct categories đã từng dùng (kèm preset)
    const [usedIncome, usedExpense] = await Promise.all([
      Transaction.distinct('category', { ...filter, type: 'income' }),
      Transaction.distinct('category', { ...filter, type: 'expense' }),
    ]);

    res.json({
      success: true,
      data: {
        income: Array.from(new Set([...COMMON_INCOME_CATEGORIES, ...usedIncome])).sort(),
        expense: Array.from(new Set([...COMMON_EXPENSE_CATEGORIES, ...usedExpense])).sort(),
      },
    });
  } catch (err) {
    console.error('[GET /transactions/categories]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/transactions/filter-options — Options cho UI filter
//   Trả về: categories + NV trong branch + shifts đang mở/gần đây
// ═════════════════════════════════════════════════════════════════════════
router.get('/filter-options', authenticate, async (req, res) => {
  try {
    if (!canViewTransactions(req.user)) {
      return res.status(403).json({ success: false, message: 'Không có quyền' });
    }

    const branchFilter = {};
    applyScopeFilter(branchFilter, req.user);

    const User = require('../models/User');
    const Shift = require('../models/Shift');

    // Users trong branch (để dropdown "ghi nhận bởi")
    const userFilter = req.user.role === 'Admin'
      ? { isActive: true }
      : { branchId: req.user.branchId, isActive: true };

    const [usedIncomeCats, usedExpenseCats, users, recentShifts] = await Promise.all([
      Transaction.distinct('category', { ...branchFilter, type: 'income' }),
      Transaction.distinct('category', { ...branchFilter, type: 'expense' }),
      User.find(userFilter).select('_id fullName username role').sort({ fullName: 1 }).lean(),
      Shift.find(branchFilter)
        .select('_id shiftCode label openedAt status user')
        .populate('user', 'fullName')
        .sort({ openedAt: -1 })
        .limit(20)
        .lean(),
    ]);

    res.json({
      success: true,
      data: {
        categories: {
          income: Array.from(new Set([...COMMON_INCOME_CATEGORIES, ...usedIncomeCats])).sort(),
          expense: Array.from(new Set([...COMMON_EXPENSE_CATEGORIES, ...usedExpenseCats])).sort(),
        },
        paymentMethods: [
          { value: 'cash',     label: '💵 Tiền mặt' },
          { value: 'transfer', label: '🏦 Chuyển khoản' },
          { value: 'card',     label: '💳 Thẻ' },
          { value: 'other',    label: 'Khác' },
        ],
        relatedTypes: [
          { value: 'manual',          label: '✋ Nhập tay' },
          { value: 'invoice_payment', label: '🧾 Tiền phòng (auto)' },
          { value: 'salary',          label: '💰 Lương' },
        ],
        users: users.map(u => ({
          value: String(u._id),
          label: `${u.fullName} (${u.role})`,
        })),
        recentShifts: recentShifts.map(s => ({
          value: String(s._id),
          label: `${s.shiftCode}${s.label ? ` — ${s.label}` : ''} — ${s.user?.fullName || ''}`,
          status: s.status,
        })),
      },
    });
  } catch (err) {
    console.error('[GET /transactions/filter-options]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/transactions/:id — Chi tiết 1 transaction
// ═════════════════════════════════════════════════════════════════════════
router.get('/:id', authenticate, async (req, res) => {
  try {
    if (!canViewTransactions(req.user)) {
      return res.status(403).json({ success: false, message: 'Không có quyền' });
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const tx = await Transaction.findById(req.params.id)
      .populate('branchId', 'name')
      .populate('recordedBy', 'fullName username')
      .populate('updatedBy', 'fullName username')
      .lean();
    if (!tx) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy' });
    }

    // Scope check
    if (req.user.role !== 'Admin' && String(tx.branchId?._id) !== String(req.user.branchId)) {
      return res.status(403).json({ success: false, message: 'Không có quyền xem giao dịch của branch khác' });
    }

    res.json({ success: true, data: { transaction: tx } });
  } catch (err) {
    console.error('[GET /transactions/:id]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/transactions — Tạo mới
// Body: { type, category, amount, description, branchId, occurredOn, paymentMethod, note }
// ═════════════════════════════════════════════════════════════════════════
router.post('/', authenticate, async (req, res) => {
  try {
    if (!canCreateTransaction(req.user)) {
      return res.status(403).json({ success: false, message: 'Vui lòng đăng nhập' });
    }

    const { type, category, amount, description, branchId, occurredOn, paymentMethod, note, shiftId } = req.body;

    // Validation cơ bản
    if (!type || !['income', 'expense'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Type phải là "income" hoặc "expense"' });
    }
    if (!category || typeof category !== 'string' || category.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Thiếu category (loại giao dịch)' });
    }
    if (!Number.isFinite(+amount) || +amount < 0) {
      return res.status(400).json({ success: false, message: 'Số tiền không hợp lệ' });
    }

    // Determine branchId
    let bId = branchId;
    if (req.user.role !== 'Admin') {
      bId = req.user.branchId;
    }
    if (!bId || !mongoose.isValidObjectId(bId)) {
      return res.status(400).json({
        success: false,
        message: req.user.role !== 'Admin'
          ? 'Tài khoản của bạn chưa được gán chi nhánh — liên hệ Admin'
          : 'Vui lòng chọn chi nhánh',
      });
    }

    // ⭐ UPDATED 14/05/2026 v2: Auto-link với Shift đang mở của BRANCH
    //   Workflow mới: 1 branch chỉ có 1 ca mở tại 1 lần
    //   - Nếu body có shiftId rõ ràng → dùng (Admin/Manager backdate)
    //   - Nếu không → tìm ca mở trong branch (bất kể user là ai)
    //   - Nếu không có ca mở → shiftId=null (vẫn cho tạo, không bắt buộc)
    let resolvedShiftId = null;
    if (shiftId && mongoose.isValidObjectId(shiftId)) {
      resolvedShiftId = shiftId;
    } else {
      try {
        const Shift = require('../models/Shift');
        const openShift = await Shift.findOne({
          branchId: bId,
          status: 'open',
        }).select('_id').lean();
        if (openShift) {
          resolvedShiftId = openShift._id;
        }
      } catch (shiftErr) {
        console.warn('[POST /transactions] Shift lookup failed:', shiftErr.message);
      }
    }

    const tx = await Transaction.create({
      type,
      category: category.trim(),
      amount: +amount,
      description: description || '',
      branchId: bId,
      occurredOn: occurredOn ? new Date(occurredOn) : new Date(),
      paymentMethod: paymentMethod || 'cash',
      note: note || '',
      recordedBy: req.user.id,
      shiftId: resolvedShiftId,                  // ⭐ NEW
      relatedType: 'manual',
    });

    const populated = await Transaction.findById(tx._id)
      .populate('branchId', 'name')
      .populate('recordedBy', 'fullName username')
      .populate('shiftId', 'shiftCode label')
      .lean();

    res.status(201).json({
      success: true,
      message: `Đã ghi nhận ${type === 'income' ? 'khoản thu' : 'khoản chi'}: ${category}` +
        (resolvedShiftId ? ` (ca ${populated.shiftId?.shiftCode || ''})` : ''),
      data: { transaction: populated },
    });
  } catch (err) {
    console.error('[POST /transactions]', err);
    res.status(500).json({ success: false, message: err.message || 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PUT /api/transactions/:id — Update
// ═════════════════════════════════════════════════════════════════════════
router.put('/:id', authenticate, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const tx = await Transaction.findById(req.params.id);
    if (!tx) return res.status(404).json({ success: false, message: 'Không tìm thấy' });

    if (!canEditTransaction(req.user, tx)) {
      return res.status(403).json({ success: false, message: 'Không có quyền sửa giao dịch này' });
    }

    const allowed = ['type', 'category', 'amount', 'description', 'occurredOn', 'paymentMethod', 'note'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        if (k === 'amount' && +req.body[k] < 0) continue;
        tx[k] = k === 'category' ? String(req.body[k]).trim() : req.body[k];
      }
    }
    tx.updatedBy = req.user.id;
    await tx.save();

    const populated = await Transaction.findById(tx._id)
      .populate('branchId', 'name')
      .populate('recordedBy', 'fullName username')
      .populate('updatedBy', 'fullName username')
      .lean();

    res.json({
      success: true,
      message: 'Cập nhật thành công',
      data: { transaction: populated },
    });
  } catch (err) {
    console.error('[PUT /transactions/:id]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// DELETE /api/transactions/:id
// ═════════════════════════════════════════════════════════════════════════
router.delete('/:id', authenticate, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const tx = await Transaction.findById(req.params.id);
    if (!tx) return res.status(404).json({ success: false, message: 'Không tìm thấy' });

    if (!canEditTransaction(req.user, tx)) {
      return res.status(403).json({ success: false, message: 'Không có quyền xoá' });
    }

    await tx.deleteOne();
    res.json({ success: true, message: 'Đã xoá giao dịch' });
  } catch (err) {
    console.error('[DELETE /transactions/:id]', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

module.exports = router;