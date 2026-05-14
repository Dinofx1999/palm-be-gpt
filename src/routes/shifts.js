// backend/src/routes/shifts.js
//
// ⭐ REFACTOR 14/05/2026 v2: Multi-user shift + auto-chain
//
// Workflow mới:
//   1. Mở ca: POST /open (chỉ 1 ca/branch tại 1 lần)
//   2. Thêm lễ tân phụ: POST /:id/assistants
//   3. Xem ca hiện tại của branch: GET /current
//   4. Đóng ca: POST /:id/close
//      - Body: { closingCounts: [{ userId, cashCounted, note }], bankStatementBalance, closingNote, autoChainNewShift: true }
//      - actualCash = sum closingCounts[].cashCounted
//      - Nếu autoChainNewShift=true → tự mở ca mới với:
//          + user: người đóng (req.user)
//          + openingCash: actualCash của ca cũ
//          + previousShiftId: ca cũ
//
const router = require('express').Router();
const mongoose = require('mongoose');

const Shift = require('../models/Shift');
const ShiftCounter = require('../models/ShiftCounter');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { authenticate, authorize } = require('../middleware/auth');

// ─── Helpers ────────────────────────────────────────────────────────
const canViewAllShifts = (user) => ['Admin', 'Manager'].includes(user.role);

const resolveUserId = (user) => user.id || user._id || user.userId;

const resolveBranchId = (user) => {
  let b = user.branchId;
  if (b && typeof b === 'object') b = b._id || b.id;
  return b;
};

const applyScopeFilter = (filter, user) => {
  if (user.role === 'Admin') return filter;
  // ⭐ UPDATED 15/05/2026: Lễ tân/Staff xem được mọi ca trong BRANCH (không phải chỉ ca mình)
  //   Lý do: workflow bàn giao ca cần xem số liệu ca trước; két là chung; audit chéo
  //   - Admin: toàn hệ thống
  //   - Manager + Receptionist + Staff: scope theo branchId
  filter.branchId = resolveBranchId(user);
  return filter;
};

/**
 * ⭐ UPDATED 15/05/2026: Sinh mã ca theo counter của branch
 *   Format: #1, #2, ..., #1000 (theo từng branch)
 *   Async + atomic increment
 */
const genShiftCode = async (branchId) => {
  const num = await ShiftCounter.getNext(branchId);
  return `#${num}`;
};

// ═════════════════════════════════════════════════════════════════════════
// CONTROLLERS
// ═════════════════════════════════════════════════════════════════════════

/**
 * GET / — List shifts với filter + pagination
 */
const getAll = async (req, res, next) => {
  try {
    const filter = {};

    if (req.query.status && ['open', 'closed', 'handed_over', 'reconciled', 'disputed'].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    if (req.user.role === 'Admin') {
      if (req.query.branchId && mongoose.isValidObjectId(req.query.branchId)) {
        filter.branchId = req.query.branchId;
      }
      if (req.query.userId && mongoose.isValidObjectId(req.query.userId)) {
        filter.$or = [
          { user: req.query.userId },
          { 'assistants.userId': req.query.userId },
        ];
      }
    } else {
      applyScopeFilter(filter, req.user);
    }

    if (req.query.fromDate || req.query.toDate) {
      filter.openedAt = {};
      if (req.query.fromDate) filter.openedAt.$gte = new Date(req.query.fromDate);
      if (req.query.toDate)   filter.openedAt.$lte = new Date(req.query.toDate);
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const [data, total] = await Promise.all([
      Shift.find(filter)
        .populate('user', 'fullName username role')
        .populate('branchId', 'name')
        .populate('handedOverTo', 'fullName username')
        .populate('closedBy', 'fullName username')
        .populate('assistants.userId', 'fullName username')
        .sort({ openedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Shift.countDocuments(filter),
    ]);

    res.json({ success: true, data: { data, total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
};

/**
 * GET /current — Ca đang OPEN của BRANCH hiện tại
 *   (vì 1 branch chỉ có 1 ca mở tại 1 lần)
 *   Trả null nếu chưa có ca → FE sẽ block UI và force user mở ca
 */
const getCurrent = async (req, res, next) => {
  try {
    const branchId = resolveBranchId(req.user);
    if (!branchId) {
      return res.json({ success: true, data: { shift: null, reason: 'NO_BRANCH' } });
    }

    const shift = await Shift.findOne({ branchId, status: 'open' })
      .populate('user', 'fullName username')
      .populate('branchId', 'name')
      .populate('assistants.userId', 'fullName username')
      .populate('previousShiftId', 'shiftCode actualCash closedAt')
      .lean();

    if (!shift) {
      return res.json({ success: true, data: { shift: null } });
    }

    // ⭐ Guard: ca cũ trong DB có thể không có assistants/closingCounts
    //   Default về [] để FE không crash
    if (!Array.isArray(shift.assistants)) shift.assistants = [];
    if (!Array.isArray(shift.closingCounts)) shift.closingCounts = [];

    // Compute realtime summary
    const summary = await Shift.computeShiftSummary(shift._id);
    // ⭐ Két dự kiến = đầu ca + tổng thu - tổng chi (TẤT CẢ HTTT)
    const totalIn = (summary.cashIn || 0) + (summary.transferIn || 0)
      + (summary.cardIn || 0) + (summary.otherIn || 0);
    const totalOut = (summary.cashOut || 0) + (summary.transferOut || 0)
      + (summary.cardOut || 0) + (summary.otherOut || 0);
    const expectedCash = (shift.openingCash || 0) + totalIn - totalOut;

    // ⭐ Check user có thuộc ca này không (cho UI hiển thị)
    const userId = resolveUserId(req.user);
    const isPrimary = String(shift.user._id) === String(userId);
    const isAssistant = shift.assistants.some(
      (a) => String(a.userId?._id ?? a.userId) === String(userId) && !a.leftAt
    );
    const userInShift = isPrimary || isAssistant;

    res.json({
      success: true,
      data: {
        shift: { ...shift, summary, expectedCashRealtime: expectedCash },
        userInShift,    // UI dùng để hiển thị badge "Bạn đang trong ca"
        isPrimary,
        isAssistant,
      },
    });
  } catch (err) { next(err); }
};

/**
 * GET /stats/summary — Thống kê tổng quan
 */
const getStatsSummary = async (req, res, next) => {
  try {
    const filter = {};
    if (req.user.role === 'Admin' && req.query.branchId) {
      filter.branchId = req.query.branchId;
    } else if (req.user.role !== 'Admin') {
      filter.branchId = resolveBranchId(req.user);
    }
    if (req.query.fromDate || req.query.toDate) {
      filter.openedAt = {};
      if (req.query.fromDate) filter.openedAt.$gte = new Date(req.query.fromDate);
      if (req.query.toDate)   filter.openedAt.$lte = new Date(req.query.toDate);
    }

    const [stats, discrepancies] = await Promise.all([
      Shift.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalCashDiff: { $sum: '$cashDifference' },
            totalBankDiff: { $sum: '$bankDifference' },
          },
        },
      ]),
      Shift.find({
        ...filter,
        $or: [{ cashDifference: { $ne: 0 } }, { bankDifference: { $ne: 0 } }],
        status: { $in: ['closed', 'handed_over', 'disputed'] },
      })
        .populate('user', 'fullName')
        .select('shiftCode user openedAt closedAt cashDifference bankDifference status')
        .sort({ closedAt: -1 })
        .limit(10)
        .lean(),
    ]);

    res.json({
      success: true,
      data: { byStatus: stats, recentDiscrepancies: discrepancies },
    });
  } catch (err) { next(err); }
};

/**
 * GET /:id — Chi tiết 1 ca + transactions
 */
const getOne = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const shift = await Shift.findById(req.params.id)
      .populate('user', 'fullName username role')
      .populate('branchId', 'name')
      .populate('handedOverTo', 'fullName username')
      .populate('closedBy', 'fullName username')
      .populate('reconciledBy', 'fullName username')
      .populate('assistants.userId', 'fullName username')
      .populate('previousShiftId', 'shiftCode actualCash closedAt')
      .populate('nextShiftId', 'shiftCode openingCash openedAt user')
      .lean();

    if (!shift) return res.status(404).json({ success: false, message: 'Không tìm thấy ca' });

    const userId = resolveUserId(req.user);
    const isInShift = Shift.isUserInShift(shift, userId);
    const userBranchId = resolveBranchId(req.user);
    const shiftBranchId = shift.branchId?._id ?? shift.branchId;
    const isSameBranch = String(userBranchId) === String(shiftBranchId);

    // ⭐ UPDATED 15/05/2026: Cho phép xem nếu cùng branch (audit chéo + workflow bàn giao)
    //   - Admin: xem mọi ca
    //   - Manager: chỉ branch của mình
    //   - Receptionist/Staff: ca cùng branch
    if (req.user.role !== 'Admin' && !isSameBranch) {
      return res.status(403).json({ success: false, message: 'Bạn không thuộc chi nhánh của ca này' });
    }

    const transactions = await Transaction.find({ shiftId: shift._id })
      .sort({ occurredOn: -1, createdAt: -1 })
      .populate('recordedBy', 'fullName')
      .lean();

    let summary = shift.summary;
    if (shift.status === 'open') {
      summary = await Shift.computeShiftSummary(shift._id);
    }

    res.json({
      success: true,
      data: { shift: { ...shift, summary }, transactions },
    });
  } catch (err) { next(err); }
};

/**
 * GET /:id/transactions-in-shift — Tab "Thanh toán trong ca"
 *   Liệt kê các giao dịch trong khoảng [openedAt, closedAt ?? now] của 1 ca
 *   Group theo type (income/expense) hoặc payment method
 */
const getTransactionsInShift = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const shift = await Shift.findById(req.params.id).lean();
    if (!shift) return res.status(404).json({ success: false, message: 'Không tìm thấy ca' });

    const userId = resolveUserId(req.user);
    const isInShift = Shift.isUserInShift(shift, userId);
    const userBranchId = resolveBranchId(req.user);
    const isSameBranch = String(userBranchId) === String(shift.branchId);
    // ⭐ Relax: cùng branch xem được
    if (req.user.role !== 'Admin' && !isSameBranch) {
      return res.status(403).json({ success: false, message: 'Bạn không thuộc chi nhánh của ca này' });
    }

    // Filter optional theo recordedBy (lọc theo nhân viên)
    const filter = { shiftId: shift._id };
    if (req.query.recordedBy && mongoose.isValidObjectId(req.query.recordedBy)) {
      filter.recordedBy = req.query.recordedBy;
    }
    if (req.query.paymentMethod && ['cash', 'transfer', 'card', 'other'].includes(req.query.paymentMethod)) {
      filter.paymentMethod = req.query.paymentMethod;
    }

    const txs = await Transaction.find(filter)
      .sort({ occurredOn: -1, createdAt: -1 })
      .populate('recordedBy', 'fullName username')
      .lean();

    // Tổng kết theo user + payment method (cho bảng "Người thu tiền")
    const byUser = {};
    const byMethod = {};
    for (const t of txs) {
      const uid = String(t.recordedBy?._id ?? t.recordedBy ?? 'unknown');
      const uname = t.recordedBy?.fullName ?? t.recordedBy?.username ?? '—';
      if (!byUser[uid]) byUser[uid] = { userId: uid, userName: uname, income: 0, expense: 0, net: 0 };
      if (t.type === 'income') byUser[uid].income += t.amount;
      else byUser[uid].expense += t.amount;
      byUser[uid].net = byUser[uid].income - byUser[uid].expense;

      const pm = t.paymentMethod || 'other';
      if (!byMethod[pm]) byMethod[pm] = { paymentMethod: pm, income: 0, expense: 0, net: 0 };
      if (t.type === 'income') byMethod[pm].income += t.amount;
      else byMethod[pm].expense += t.amount;
      byMethod[pm].net = byMethod[pm].income - byMethod[pm].expense;
    }

    res.json({
      success: true,
      data: {
        transactions: txs,
        byUser: Object.values(byUser),
        byMethod: Object.values(byMethod),
        totalIncome: Object.values(byUser).reduce((s, u) => s + u.income, 0),
        totalExpense: Object.values(byUser).reduce((s, u) => s + u.expense, 0),
      },
    });
  } catch (err) { next(err); }
};

/**
 * POST /open — Mở ca mới
 *   Constraint: 1 branch chỉ có TỐI ĐA 1 ca mở
 */
const openShift = async (req, res, next) => {
  try {
    const userId = resolveUserId(req.user);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Không xác định được userId' });
    }

    const branchId = resolveBranchId(req.user);
    if (!branchId) {
      return res.status(400).json({
        success: false,
        message: 'Tài khoản của bạn chưa được gán chi nhánh — liên hệ Admin',
      });
    }

    // ⭐ Check: branch đã có ca mở chưa
    const existingBranchShift = await Shift.findOne({ branchId, status: 'open' })
      .populate('user', 'fullName username')
      .lean();
    if (existingBranchShift) {
      const userInShift = Shift.isUserInShift(existingBranchShift, userId);
      return res.status(409).json({
        success: false,
        code: 'BRANCH_HAS_OPEN_SHIFT',
        message: userInShift
          ? `Bạn đang trong ca ${existingBranchShift.shiftCode}`
          : `Chi nhánh đang có ca ${existingBranchShift.shiftCode} mở bởi ${existingBranchShift.user?.fullName ?? '?'} — vui lòng đóng ca cũ trước hoặc tham gia làm phụ.`,
        data: {
          shiftId: existingBranchShift._id,
          shiftCode: existingBranchShift.shiftCode,
          primaryUser: existingBranchShift.user,
          userInShift,
        },
      });
    }

    const {
      label = '',
      openingCash = 0,
      openingBankBalance = 0,
      openingNote = '',
    } = req.body;

    if (Number(openingCash) < 0 || Number(openingBankBalance) < 0) {
      return res.status(400).json({ success: false, message: 'Số tiền đầu ca không hợp lệ' });
    }

    const shiftCode = await genShiftCode(branchId);
    const shift = await Shift.create({
      shiftCode,
      user: userId,
      branchId,
      label: String(label || ''),
      openedAt: new Date(),
      openingCash: Number(openingCash) || 0,
      openingBankBalance: Number(openingBankBalance) || 0,
      openingNote: String(openingNote || ''),
      status: 'open',
    });

    const populated = await Shift.findById(shift._id)
      .populate('user', 'fullName username')
      .populate('branchId', 'name')
      .lean();

    res.status(201).json({
      success: true,
      message: `Đã mở ca ${shift.shiftCode}`,
      data: { shift: populated },
    });
  } catch (err) { next(err); }
};

/**
 * POST /:id/assistants — Thêm lễ tân phụ vào ca
 *   Body: { userId, note? }
 */
const addAssistant = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID ca không hợp lệ' });
    }

    const shift = await Shift.findById(req.params.id);
    if (!shift) return res.status(404).json({ success: false, message: 'Không tìm thấy ca' });
    if (shift.status !== 'open') {
      return res.status(400).json({ success: false, message: 'Chỉ thêm lễ tân phụ vào ca đang mở' });
    }

    const callerUserId = resolveUserId(req.user);
    const isPrimary = String(shift.user) === String(callerUserId);
    const isAdminOrManager = ['Admin', 'Manager'].includes(req.user.role);
    if (!isPrimary && !isAdminOrManager) {
      return res.status(403).json({ success: false, message: 'Chỉ chủ ca (primary) hoặc quản lý mới thêm được lễ tân phụ' });
    }

    const { userId: assistantUserId, note = '' } = req.body;
    if (!mongoose.isValidObjectId(assistantUserId)) {
      return res.status(400).json({ success: false, message: 'userId không hợp lệ' });
    }
    if (String(assistantUserId) === String(shift.user)) {
      return res.status(400).json({ success: false, message: 'Người này đã là primary của ca' });
    }

    // Check user tồn tại + cùng branch
    const u = await User.findById(assistantUserId).select('fullName username role branchId').lean();
    if (!u) return res.status(404).json({ success: false, message: 'Không tìm thấy nhân viên' });
    if (u.role === 'Admin') {
      return res.status(400).json({ success: false, message: 'Không thể thêm Admin làm lễ tân phụ' });
    }

    // Check không trùng — đã có trong assistants chưa
    const existing = (shift.assistants || []).find(
      (a) => String(a.userId) === String(assistantUserId) && !a.leftAt
    );
    if (existing) {
      return res.status(409).json({ success: false, message: 'Nhân viên này đã trong ca' });
    }

    // Check user chưa thuộc ca mở khác
    const otherOpenShift = await Shift.findOne({
      _id: { $ne: shift._id },
      status: 'open',
      $or: [
        { user: assistantUserId },
        { 'assistants.userId': assistantUserId, 'assistants.leftAt': null },
      ],
    }).lean();
    if (otherOpenShift) {
      return res.status(409).json({
        success: false,
        message: `Nhân viên đang trong ca khác (${otherOpenShift.shiftCode})`,
      });
    }

    shift.assistants.push({
      userId: assistantUserId,
      userFullName: u.fullName || u.username,
      joinedAt: new Date(),
      note: String(note || ''),
    });
    await shift.save();

    const populated = await Shift.findById(shift._id)
      .populate('user', 'fullName username')
      .populate('assistants.userId', 'fullName username')
      .lean();

    res.json({
      success: true,
      message: `Đã thêm ${u.fullName || u.username} làm lễ tân phụ`,
      data: { shift: populated },
    });
  } catch (err) { next(err); }
};

/**
 * DELETE /:id/assistants/:userId — Xoá lễ tân phụ (mark leftAt)
 */
const removeAssistant = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID ca không hợp lệ' });
    }
    const targetUserId = req.params.userId;
    if (!mongoose.isValidObjectId(targetUserId)) {
      return res.status(400).json({ success: false, message: 'userId không hợp lệ' });
    }

    const shift = await Shift.findById(req.params.id);
    if (!shift) return res.status(404).json({ success: false, message: 'Không tìm thấy ca' });
    if (shift.status !== 'open') {
      return res.status(400).json({ success: false, message: 'Chỉ xoá lễ tân phụ khi ca đang mở' });
    }

    const callerUserId = resolveUserId(req.user);
    const isPrimary = String(shift.user) === String(callerUserId);
    const isSelf = String(targetUserId) === String(callerUserId);  // tự rời ca
    const isAdminOrManager = ['Admin', 'Manager'].includes(req.user.role);
    if (!isPrimary && !isSelf && !isAdminOrManager) {
      return res.status(403).json({ success: false, message: 'Không có quyền xoá lễ tân phụ' });
    }

    const idx = shift.assistants.findIndex(
      (a) => String(a.userId) === String(targetUserId) && !a.leftAt
    );
    if (idx === -1) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy lễ tân phụ này' });
    }
    shift.assistants[idx].leftAt = new Date();
    await shift.save();

    res.json({
      success: true,
      message: 'Đã rời lễ tân phụ khỏi ca',
      data: { shift: shift.toObject() },
    });
  } catch (err) { next(err); }
};

/**
 * POST /:id/close — Đóng ca
 *   Body:
 *     - closingCounts: [{ userId, cashCounted, note? }]  ← bắt buộc, mỗi user 1 entry
 *     - bankStatementBalance: number
 *     - closingNote: string
 *     - autoChainNewShift: boolean (mặc định true)
 */
const closeShift = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const shift = await Shift.findById(req.params.id);
    if (!shift) return res.status(404).json({ success: false, message: 'Không tìm thấy ca' });

    const userId = resolveUserId(req.user);
    const isInShift = Shift.isUserInShift(shift, userId);
    const isAdminOrManager = ['Admin', 'Manager'].includes(req.user.role);
    // ⭐ UPDATED 15/05/2026: Relax permission — bất kỳ ai cùng branch đều có quyền đóng ca
    //   (Option B: relax — nhân viên trong branch có thể đóng ca giúp đồng nghiệp)
    const isSameBranch = String(req.user.branchId) === String(shift.branchId);
    if (!isInShift && !isAdminOrManager && !isSameBranch) {
      return res.status(403).json({ success: false, message: 'Bạn không thuộc chi nhánh của ca này' });
    }

    if (shift.status !== 'open') {
      return res.status(400).json({
        success: false,
        message: `Ca này đã ${shift.status === 'closed' ? 'đóng' : 'bàn giao'} — không thể đóng lại`,
      });
    }

    const {
      closingCounts = [],
      bankStatementBalance = 0,
      closingNote = '',
      autoChainNewShift = true,
      // ⭐ NEW: 2 field bàn giao chia
      handoverToNext = 0,
      handoverToManager = 0,
      handoverReceiver = '',
    } = req.body;

    if (!Array.isArray(closingCounts) || closingCounts.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Phải có ít nhất 1 lễ tân kiểm đếm — nhập closingCounts',
      });
    }
    if (Number(bankStatementBalance) < 0) {
      return res.status(400).json({ success: false, message: 'Số dư banking không hợp lệ' });
    }
    if (Number(handoverToNext) < 0 || Number(handoverToManager) < 0) {
      return res.status(400).json({ success: false, message: 'Số tiền bàn giao không được âm' });
    }

    // ⭐ UPDATED 15/05/2026: closingCounts không bắt buộc thuộc ca
    //   Nếu user đóng ca KHÔNG nằm trong ca (cùng branch khác) → tự động add vào assistants
    //   để audit log đầy đủ + closingCounts có context
    const validUserIds = new Set([
      String(shift.user),
      ...shift.assistants.filter(a => !a.leftAt).map(a => String(a.userId)),
    ]);
    const seenUsers = new Set();
    const cleanCounts = [];
    const newAssistantsToAdd = [];   // ⭐ Track user mới để add vào assistants
    for (const c of closingCounts) {
      if (!c.userId || !mongoose.isValidObjectId(c.userId)) {
        return res.status(400).json({ success: false, message: 'closingCounts có userId không hợp lệ' });
      }
      if (seenUsers.has(String(c.userId))) {
        return res.status(400).json({
          success: false,
          message: 'Trùng userId trong closingCounts — mỗi người chỉ kiểm 1 lần',
        });
      }
      seenUsers.add(String(c.userId));
      if (Number(c.cashCounted) < 0) {
        return res.status(400).json({ success: false, message: 'cashCounted phải >= 0' });
      }

      // Snapshot user name
      let userFullName = c.userFullName;
      if (!userFullName) {
        const u = await User.findById(c.userId).select('fullName username').lean();
        userFullName = u?.fullName ?? u?.username ?? '';
      }

      // ⭐ Nếu user không thuộc ca → ghi nhận để add vào assistants
      if (!validUserIds.has(String(c.userId))) {
        newAssistantsToAdd.push({
          userId: c.userId,
          userFullName,
          joinedAt: new Date(),
          note: 'Tự động join khi đóng ca',
        });
      }

      cleanCounts.push({
        userId: c.userId,
        userFullName,
        cashCounted: Number(c.cashCounted) || 0,
        note: String(c.note || ''),
        countedAt: new Date(),
      });
    }

    // ⭐ Add user mới vào assistants trước khi đóng ca (audit log)
    if (newAssistantsToAdd.length > 0) {
      shift.assistants.push(...newAssistantsToAdd);
    }

    // actualCash = sum closingCounts
    const actualCash = cleanCounts.reduce((s, c) => s + c.cashCounted, 0);

    // ⭐ Validate: bàn giao ca sau + bàn giao quản lý phải <= actualCash
    const hNext = Number(handoverToNext) || 0;
    const hMgr = Number(handoverToManager) || 0;
    const totalHandover = hNext + hMgr;
    if (totalHandover > actualCash) {
      return res.status(400).json({
        success: false,
        message: `Tổng bàn giao (${totalHandover}) lớn hơn thực tế trong két (${actualCash}). Vui lòng kiểm tra lại.`,
        data: { actualCash, handoverToNext: hNext, handoverToManager: hMgr, totalHandover },
      });
    }

    // Compute summary
    const summary = await Shift.computeShiftSummary(shift._id);
    shift.summary = summary;
    // ⭐ Két dự kiến = đầu ca + tổng thu - tổng chi (TẤT CẢ HTTT, không chỉ cash)
    const totalInSum = (summary.cashIn || 0) + (summary.transferIn || 0)
      + (summary.cardIn || 0) + (summary.otherIn || 0);
    const totalOutSum = (summary.cashOut || 0) + (summary.transferOut || 0)
      + (summary.cardOut || 0) + (summary.otherOut || 0);
    shift.expectedCash = (shift.openingCash || 0) + totalInSum - totalOutSum;
    shift.expectedBankBalance = (shift.openingBankBalance || 0)
      + (summary.transferIn || 0) + (summary.cardIn || 0)
      - (summary.transferOut || 0) - (summary.cardOut || 0);
    shift.closingCounts = cleanCounts;
    shift.actualCash = actualCash;
    shift.handoverToNext = hNext;
    shift.handoverToManager = hMgr;
    shift.handoverReceiver = String(handoverReceiver || '');
    shift.bankStatementBalance = Number(bankStatementBalance) || 0;
    shift.cashDifference = shift.actualCash - shift.expectedCash;
    shift.bankDifference = shift.bankStatementBalance - shift.expectedBankBalance;
    shift.closedAt = new Date();
    shift.closingNote = String(closingNote || '');
    shift.closedBy = userId;
    shift.status = 'closed';
    await shift.save();

    let newShift = null;
    // ⭐ Auto-chain: tự mở ca mới với người đóng làm primary
    //   openingCash của ca mới = handoverToNext (không phải actualCash)
    //   Phần handoverToManager đã nộp cho QL, không thuộc két ca mới
    if (autoChainNewShift) {
      try {
        const newShiftCode = await genShiftCode(shift.branchId);
        newShift = await Shift.create({
          shiftCode: newShiftCode,
          user: userId,
          branchId: shift.branchId,
          label: '',
          openedAt: new Date(),
          openingCash: hNext,                  // ⭐ Đổi: dùng handoverToNext thay actualCash
          openingBankBalance: shift.bankStatementBalance,
          openingNote: `Tự động chain từ ca ${shift.shiftCode}`
            + (hMgr > 0 ? ` (đã nộp QL ${hMgr.toLocaleString('vi-VN')}đ)` : ''),
          previousShiftId: shift._id,
          status: 'open',
        });

        // Update ca cũ link sang ca mới
        shift.nextShiftId = newShift._id;
        await shift.save();
      } catch (chainErr) {
        // Log nhưng không fail — đóng ca cũ vẫn thành công
        console.error('[shifts/close] Auto-chain failed:', chainErr.message);
      }
    }

    const populated = await Shift.findById(shift._id)
      .populate('user', 'fullName username')
      .populate('branchId', 'name')
      .populate('closedBy', 'fullName username')
      .populate('assistants.userId', 'fullName username')
      .populate('closingCounts.userId', 'fullName username')
      .populate('nextShiftId', 'shiftCode openingCash openedAt')
      .lean();

    const hasDiscrepancy = Math.abs(shift.cashDifference) > 0 || Math.abs(shift.bankDifference) > 0;

    res.json({
      success: true,
      message: `Đã đóng ca ${shift.shiftCode}. ` +
        (hasDiscrepancy ? `⚠️ Có chênh lệch — vui lòng kiểm tra.` : `✅ Số liệu khớp.`) +
        (newShift ? ` Đã mở ca mới ${newShift.shiftCode}.` : ''),
      data: {
        shift: populated,
        cashDifference: shift.cashDifference,
        bankDifference: shift.bankDifference,
        hasDiscrepancy,
        newShift: newShift ? {
          _id: newShift._id,
          shiftCode: newShift.shiftCode,
          openingCash: newShift.openingCash,
          openedAt: newShift.openedAt,
        } : null,
      },
    });
  } catch (err) { next(err); }
};

/**
 * POST /:id/handover — Bàn giao ca cho người khác (sau khi đã đóng)
 *   Workflow auto-chain đã tự handover cho người đóng, route này dùng khi
 *   bàn giao cho NV khác (không phải mình)
 */
const handover = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const shift = await Shift.findById(req.params.id);
    if (!shift) return res.status(404).json({ success: false, message: 'Không tìm thấy ca' });
    if (shift.status !== 'closed') {
      return res.status(400).json({ success: false, message: 'Chỉ bàn giao được ca đã đóng' });
    }

    const { handedOverTo, handoverNote = '' } = req.body;
    if (!handedOverTo || !mongoose.isValidObjectId(handedOverTo)) {
      return res.status(400).json({ success: false, message: 'Thiếu thông tin người nhận ca' });
    }

    const userId = resolveUserId(req.user);
    const isInShift = Shift.isUserInShift(shift, userId);
    const isAdminOrManager = ['Admin', 'Manager'].includes(req.user.role);
    if (!isInShift && !isAdminOrManager) {
      return res.status(403).json({ success: false, message: 'Không có quyền bàn giao' });
    }

    shift.handedOverTo = handedOverTo;
    shift.handoverNote = String(handoverNote || '');
    shift.handoverConfirmedAt = String(userId) === String(handedOverTo) ? new Date() : null;
    shift.status = 'handed_over';
    await shift.save();

    const populated = await Shift.findById(shift._id)
      .populate('user', 'fullName username')
      .populate('handedOverTo', 'fullName username')
      .populate('branchId', 'name')
      .lean();

    res.json({ success: true, message: 'Đã bàn giao ca', data: { shift: populated } });
  } catch (err) { next(err); }
};

const confirmHandover = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const shift = await Shift.findById(req.params.id);
    if (!shift) return res.status(404).json({ success: false, message: 'Không tìm thấy ca' });
    if (shift.status !== 'handed_over') {
      return res.status(400).json({ success: false, message: 'Ca chưa được bàn giao' });
    }

    const userId = resolveUserId(req.user);
    if (String(shift.handedOverTo) !== String(userId)) {
      return res.status(403).json({ success: false, message: 'Bạn không phải người nhận ca này' });
    }

    shift.handoverConfirmedAt = new Date();
    await shift.save();

    res.json({ success: true, message: 'Đã xác nhận nhận ca', data: { shift: shift.toObject() } });
  } catch (err) { next(err); }
};

const reconcile = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const shift = await Shift.findById(req.params.id);
    if (!shift) return res.status(404).json({ success: false, message: 'Không tìm thấy ca' });
    if (!['closed', 'handed_over'].includes(shift.status)) {
      return res.status(400).json({ success: false, message: 'Ca chưa đóng — không thể duyệt' });
    }

    const { dispute = false, reason = '' } = req.body;
    shift.reconciledBy = resolveUserId(req.user);
    shift.reconciledAt = new Date();
    shift.status = dispute ? 'disputed' : 'reconciled';
    if (dispute && reason) shift.closingNote = (shift.closingNote || '') + `\n[DISPUTED] ${reason}`;
    await shift.save();

    res.json({
      success: true,
      message: dispute ? 'Đã đánh dấu tranh chấp' : 'Đã duyệt ca',
      data: { shift: shift.toObject() },
    });
  } catch (err) { next(err); }
};

/**
 * POST /:id/backfill-transactions — Gán shiftId cho giao dịch chưa có ca
 *   Dùng khi:
 *   - Ca mới mở nhưng có giao dịch tạo trước đó cần gắn vào ca
 *   - Body: { fromDate? } — chỉ gắn các giao dịch sau thời điểm này (mặc định: từ openedAt của ca)
 *   - Chỉ gắn vào giao dịch có shiftId=null, branch khớp, occurredOn >= fromDate
 */
const backfillTransactions = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
    }

    const shift = await Shift.findById(req.params.id);
    if (!shift) return res.status(404).json({ success: false, message: 'Không tìm thấy ca' });
    if (shift.status !== 'open') {
      return res.status(400).json({ success: false, message: 'Chỉ backfill cho ca đang mở' });
    }

    const userId = resolveUserId(req.user);
    const isInShift = Shift.isUserInShift(shift, userId);
    const isAdminOrManager = ['Admin', 'Manager'].includes(req.user.role);
    if (!isInShift && !isAdminOrManager) {
      return res.status(403).json({ success: false, message: 'Không có quyền' });
    }

    // fromDate: nếu không truyền → dùng openedAt của ca (gắn mọi gd từ lúc mở ca trở đi)
    //   Có thể truyền 1 ngày sớm hơn để gắn cả gd cũ
    const fromDate = req.body.fromDate ? new Date(req.body.fromDate) : shift.openedAt;
    if (isNaN(fromDate.getTime())) {
      return res.status(400).json({ success: false, message: 'fromDate không hợp lệ' });
    }

    // Update: tất cả tx trong branch + chưa có shiftId + sau fromDate
    const result = await Transaction.updateMany(
      {
        branchId: shift.branchId,
        shiftId: null,
        occurredOn: { $gte: fromDate },
      },
      { $set: { shiftId: shift._id } }
    );

    res.json({
      success: true,
      message: `Đã gắn ${result.modifiedCount} giao dịch vào ca ${shift.shiftCode}`,
      data: {
        matched: result.matchedCount,
        modified: result.modifiedCount,
        fromDate,
      },
    });
  } catch (err) { next(err); }
};

// ═════════════════════════════════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════════════════════════════════
router.get('/',                              authenticate,                                getAll);
router.get('/current',                       authenticate,                                getCurrent);
router.get('/stats/summary',                 authenticate,                                getStatsSummary);
router.get('/:id',                           authenticate,                                getOne);
router.get('/:id/transactions-in-shift',     authenticate,                                getTransactionsInShift);
router.post('/open',                         authenticate,                                openShift);
router.post('/:id/assistants',               authenticate,                                addAssistant);
router.delete('/:id/assistants/:userId',     authenticate,                                removeAssistant);
router.post('/:id/close',                    authenticate,                                closeShift);
router.post('/:id/handover',                 authenticate,                                handover);
router.post('/:id/confirm-handover',         authenticate,                                confirmHandover);
router.post('/:id/reconcile',                authenticate, authorize('Admin', 'Manager'), reconcile);
router.post('/:id/backfill-transactions',    authenticate,                                backfillTransactions);

module.exports = router;