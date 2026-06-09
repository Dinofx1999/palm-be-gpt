// backend/src/controllers/salaryAdvanceController.js
//
// ⭐ NEW 11/05/2026: Controller lương ứng
//
// Convention khớp với routes/salaryy.js:
//   - SalaryConfig dùng field `user` (không phải `userId`)
//   - Permission: canView (Admin all, Manager same-branch, Self own), canEdit (Admin/Manager)
//   - req.user có: { id, role, branchId }
//
const mongoose = require('mongoose');
const SalaryAdvance = require('../models/SalaryAdvance');
const { SalaryConfig } = require('../models/Salary');
const Branch = require('../models/Branch');
const User = require('../models/User');

// ─────────────────────────────────────────────────────────────────────
// Permission helpers — copy logic từ routes/salaryy.js để consistent
// ─────────────────────────────────────────────────────────────────────
async function canView(requester, targetUserId) {
  if (String(requester.id) === String(targetUserId)) return true;
  if (requester.role === 'Admin') return true;
  if (requester.role === 'Manager') {
    if (!requester.branchId) return false;
    const target = await User.findById(targetUserId).select('branchId').lean();
    if (!target) return false;
    return String(target.branchId) === String(requester.branchId);
  }
  return false;
}

async function canEdit(requester, targetUserId) {
  // Admin/Manager mới được tạo/sửa/xoá lương ứng
  if (requester.role === 'Admin') return true;
  if (requester.role === 'Manager') {
    if (!requester.branchId) return false;
    const target = await User.findById(targetUserId).select('branchId').lean();
    if (!target) return false;
    return String(target.branchId) === String(requester.branchId);
  }
  return false;
}

// Helper: tính tổng cố định của NV cho 1 KỲ (từ SalaryConfig.components, carry-forward).
const getFixedTotal = async (userId, year, month) => {
  const now = new Date();
  const y = Number(year) || now.getFullYear();
  const m = Number(month) || (now.getMonth() + 1);
  const cfg = await SalaryConfig.getConfigForPeriod(userId, y, m);
  if (!cfg || !Array.isArray(cfg.components)) return 0;
  return cfg.components.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
};

// Helper: get advanceMaxPercent của branch
const getBranchAdvancePercent = async (branchId) => {
  if (!branchId) return 30;
  const branch = await Branch.findById(branchId).select('advanceMaxPercent').lean();
  return Number(branch?.advanceMaxPercent ?? 30);
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/salary-advances/by-user/:userId?year=&month=
// ─────────────────────────────────────────────────────────────────────
exports.getByUser = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }
    const year  = parseInt(req.query.year, 10)  || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);

    if (!(await canView(req.user, userId))) {
      return res.status(403).json({ message: 'Không có quyền xem lương ứng của người này' });
    }

    const records = await SalaryAdvance.find({ user: userId, year, month })
      .populate('createdBy', 'fullName email username')
      .sort({ advancedAt: -1 })
      .lean();

    return res.json({
      success: true,
      data: { data: records },
    });
  } catch (err) {
    console.error('[salaryAdvance.getByUser]', err);
    return res.status(500).json({ success: false, message: err.message || 'Lỗi server' });
  }
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/salary-advances/by-user/:userId/limit?year=&month=
//   Trả về info giới hạn ứng
// ─────────────────────────────────────────────────────────────────────
exports.getLimit = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }
    const year  = parseInt(req.query.year, 10)  || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);

    if (!(await canView(req.user, userId))) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    const user = await User.findById(userId).select('branchId').lean();
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy NV' });
    }
    const branchId = user.branchId;

    const [maxPercent, fixedTotal, usedAmount] = await Promise.all([
      getBranchAdvancePercent(branchId),
      getFixedTotal(userId, year, month),
      SalaryAdvance.totalForMonth(userId, year, month),
    ]);

    const maxAmount       = Math.floor((fixedTotal * maxPercent) / 100);
    const remainingAmount = Math.max(0, maxAmount - usedAmount);

    return res.json({
      success: true,
      data: {
        year, month,
        maxPercent,
        fixedTotal,
        maxAmount,
        usedAmount,
        remainingAmount,
      },
    });
  } catch (err) {
    console.error('[salaryAdvance.getLimit]', err);
    return res.status(500).json({ success: false, message: err.message || 'Lỗi server' });
  }
};

// ─────────────────────────────────────────────────────────────────────
// POST /api/salary-advances
//   body: { userId, year, month, amount, reason?, paymentMethod?, note?, advancedAt? }
// ─────────────────────────────────────────────────────────────────────
exports.create = async (req, res) => {
  try {
    const {
      userId, year, month, amount,
      reason = '', paymentMethod = 'cash', note = '', advancedAt,
    } = req.body;

    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }
    if (!year || !month || !amount) {
      return res.status(400).json({ message: 'Thiếu thông tin: year, month, amount' });
    }
    if (Number(amount) <= 0) {
      return res.status(400).json({ message: 'Số tiền ứng phải lớn hơn 0' });
    }
    if (!['cash', 'transfer'].includes(paymentMethod)) {
      return res.status(400).json({ message: 'Phương thức thanh toán không hợp lệ' });
    }

    if (!(await canEdit(req.user, userId))) {
      return res.status(403).json({ message: 'Chỉ Admin/Manager mới được tạo lương ứng' });
    }

    const user = await User.findById(userId).select('branchId').lean();
    if (!user) {
      return res.status(404).json({ message: 'Không tìm thấy NV' });
    }
    const branchId = user.branchId;

    // Validate giới hạn %
    const [maxPercent, fixedTotal, usedAmount] = await Promise.all([
      getBranchAdvancePercent(branchId),
      getFixedTotal(userId, year, month),
      SalaryAdvance.totalForMonth(userId, year, month),
    ]);

    if (fixedTotal <= 0) {
      return res.status(400).json({
        success: false,
        code: 'NO_SALARY_CONFIG',
        message: 'Nhân viên chưa có cấu hình lương cố định — không thể ứng',
      });
    }

    const maxAmount = Math.floor((fixedTotal * maxPercent) / 100);
    const newTotal  = usedAmount + Number(amount);

    if (newTotal > maxAmount) {
      const remainingAmount = Math.max(0, maxAmount - usedAmount);
      return res.status(400).json({
        success: false,
        code: 'ADVANCE_EXCEEDS_LIMIT',
        message: `Vượt giới hạn ứng. Đã ứng ${usedAmount.toLocaleString('vi-VN')}đ, tối đa được ${maxAmount.toLocaleString('vi-VN')}đ (${maxPercent}% × ${fixedTotal.toLocaleString('vi-VN')}đ). Còn được ứng: ${remainingAmount.toLocaleString('vi-VN')}đ`,
        data: { maxPercent, fixedTotal, maxAmount, usedAmount, remainingAmount, requested: Number(amount) },
      });
    }

    const created = await SalaryAdvance.create({
      user: userId,
      branchId,
      year:  Number(year),
      month: Number(month),
      amount: Number(amount),
      reason, paymentMethod, note,
      advancedAt: advancedAt ? new Date(advancedAt) : new Date(),
      createdBy: req.user.id,
    });

    const populated = await SalaryAdvance.findById(created._id)
      .populate('createdBy', 'fullName email username')
      .lean();

    return res.json({
      success: true,
      message: `Đã ghi nhận ứng ${Number(amount).toLocaleString('vi-VN')}đ`,
      data: populated,
    });
  } catch (err) {
    console.error('[salaryAdvance.create]', err);
    return res.status(500).json({ success: false, message: err.message || 'Lỗi server' });
  }
};

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/salary-advances/:id
// ─────────────────────────────────────────────────────────────────────
exports.remove = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }

    const existing = await SalaryAdvance.findById(id);
    if (!existing) {
      return res.status(404).json({ message: 'Không tìm thấy bản ghi' });
    }

    if (!(await canEdit(req.user, existing.user))) {
      return res.status(403).json({ message: 'Chỉ Admin/Manager mới được xoá' });
    }

    await SalaryAdvance.findByIdAndDelete(id);
    return res.json({ success: true, message: 'Đã xoá khoản ứng' });
  } catch (err) {
    console.error('[salaryAdvance.remove]', err);
    return res.status(500).json({ success: false, message: err.message || 'Lỗi server' });
  }
};

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/salary-advances/:id
//   Cho phép sửa amount/reason/paymentMethod/note/advancedAt
//   Nếu sửa amount → re-validate giới hạn (loại trừ bản ghi hiện tại)
// ─────────────────────────────────────────────────────────────────────
exports.update = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }

    const existing = await SalaryAdvance.findById(id);
    if (!existing) {
      return res.status(404).json({ message: 'Không tìm thấy bản ghi' });
    }

    if (!(await canEdit(req.user, existing.user))) {
      return res.status(403).json({ message: 'Chỉ Admin/Manager mới được sửa' });
    }

    const { amount, reason, paymentMethod, note, advancedAt } = req.body;

    // Nếu sửa amount → validate lại
    if (amount !== undefined && Number(amount) !== existing.amount) {
      if (Number(amount) <= 0) {
        return res.status(400).json({ message: 'Số tiền ứng phải lớn hơn 0' });
      }

      const user = await User.findById(existing.user).select('branchId').lean();
      const branchId = user?.branchId;
      const [maxPercent, fixedTotal] = await Promise.all([
        getBranchAdvancePercent(branchId),
        getFixedTotal(existing.user, existing.year, existing.month),
      ]);

      // Tổng đã ứng TRỪ bản ghi hiện tại
      const usedAggResult = await SalaryAdvance.aggregate([
        { $match: {
          user: existing.user,
          year: existing.year, month: existing.month,
          _id: { $ne: existing._id },
        } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);
      const usedAmount = usedAggResult[0]?.total ?? 0;

      const maxAmount = Math.floor((fixedTotal * maxPercent) / 100);
      const newTotal  = usedAmount + Number(amount);
      if (newTotal > maxAmount) {
        const remainingAmount = Math.max(0, maxAmount - usedAmount);
        return res.status(400).json({
          success: false,
          code: 'ADVANCE_EXCEEDS_LIMIT',
          message: `Vượt giới hạn ứng. Còn được ứng: ${remainingAmount.toLocaleString('vi-VN')}đ`,
          data: { maxPercent, fixedTotal, maxAmount, usedAmount, remainingAmount },
        });
      }
      existing.amount = Number(amount);
    }

    if (reason !== undefined)        existing.reason = reason;
    if (paymentMethod !== undefined) {
      if (!['cash', 'transfer'].includes(paymentMethod)) {
        return res.status(400).json({ message: 'Phương thức thanh toán không hợp lệ' });
      }
      existing.paymentMethod = paymentMethod;
    }
    if (note !== undefined)       existing.note = note;
    if (advancedAt !== undefined) existing.advancedAt = new Date(advancedAt);

    await existing.save();
    const populated = await SalaryAdvance.findById(id)
      .populate('createdBy', 'fullName email username')
      .lean();

    return res.json({ success: true, message: 'Đã cập nhật', data: populated });
  } catch (err) {
    console.error('[salaryAdvance.update]', err);
    return res.status(500).json({ success: false, message: err.message || 'Lỗi server' });
  }
};