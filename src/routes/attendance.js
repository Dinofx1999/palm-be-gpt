// backend/src/routes/attendance.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const Attendance = require('../models/Attendance');
const WorkShift = require('../models/WorkShift');
const { Penalty, PenaltyRecord } = require('../models/Penalty');
const Branch = require('../models/Branch');
const User = require('../models/User');
const {
  calculateDistance,
  calculateLateMinutes,
  computePenaltyAmount,
} = require('../utils/geoHelpers');
const { authenticate } = require('../middleware/auth');

const isAdmin = (req) => req.user?.role === 'Admin';
const isManager = (req) => req.user?.role === 'Manager';

// Helper: lấy ngày YYYY-MM-DD theo giờ địa phương
function getWorkDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ═════════════════════════════════════════════════════════════════════════
// GET /api/attendance/today
// Trả về trạng thái checkin hôm nay của user hiện tại + danh sách ca khả dụng
// ═════════════════════════════════════════════════════════════════════════
router.get('/today', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const branchId = req.user.branchId;
     // ⭐ THÊM 4 DÒNG NÀY ĐỂ DEBUG
    console.log('[ATT] req.user:', JSON.stringify(req.user));
    console.log('[ATT] branchId:', branchId, 'type:', typeof branchId);
    const testBranch = await Branch.findById(branchId).lean();
    console.log('[ATT] Branch found?', !!testBranch, '| Branch._id:', testBranch?._id);
    
    if (!branchId) {
      return res.status(400).json({ message: 'User không thuộc branch nào' });
    }

    const workDate = getWorkDate();

    const [myAttendance, allShifts, takenAttendances, branch] = await Promise.all([
      Attendance.findOne({ user: userId, workDate }).populate('shift').lean(),
      WorkShift.find({ branchId, isActive: true })
        .sort({ sortOrder: 1, startTime: 1 })
        .populate('latePenaltyId', 'name type timeWindowTiers fixedAmount severity')
        .lean(),
      // Các ca đã có người checkin hôm nay (để FE hiển thị "đã có người")
      Attendance.find({ branchId, workDate })
        .populate('user', 'fullName')
        .lean(),
      // ⭐ FIX: thêm Branch.findById vào Promise.all
      Branch.findById(branchId).select('name latitude longitude geofenceRadius').lean(),
    ]);

    const takenMap = new Map();
    for (const a of takenAttendances) {
      takenMap.set(String(a.shift), {
        userName: a.user?.fullName || 'Ai đó',
        userId: String(a.user?._id || a.user),
      });
    }

    const shifts = allShifts.map((s) => ({
      ...s,
      taken: takenMap.get(String(s._id)) || null,
      isMine: String(takenMap.get(String(s._id))?.userId || '') === String(userId),
    }));

    res.json({
      workDate,
      myAttendance,
      shifts,
      branch: branch ? {
        latitude: branch.latitude,
        longitude: branch.longitude,
        geofenceRadius: branch.geofenceRadius || 100,
        name: branch.name,
      } : null,
    });
  } catch (err) {
    console.error('[GET /attendance/today]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/attendance/checkin
// Body: { shiftId, latitude, longitude }
// ═════════════════════════════════════════════════════════════════════════
router.post('/checkin', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const userBranchId = req.user.branchId;
    if (!userBranchId) {
      return res.status(400).json({ message: 'User không thuộc branch' });
    }

    const { shiftId, latitude, longitude } = req.body;
    if (!mongoose.isValidObjectId(shiftId)) {
      return res.status(400).json({ message: 'shiftId không hợp lệ' });
    }
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({
        message: 'Cần vị trí GPS để checkin. Vui lòng cho phép định vị.',
      });
    }

    const workDate = getWorkDate();

    // 1. Kiểm tra đã checkin hôm nay chưa
    const existing = await Attendance.findOne({ user: userId, workDate }).lean();
    if (existing) {
      return res.status(400).json({
        message: 'Bạn đã checkin hôm nay. Mỗi ngày chỉ được checkin 1 ca.',
      });
    }

    // 2. Lấy shift + verify cùng branch
    const shift = await WorkShift.findById(shiftId)
      .populate('latePenaltyId')
      .lean();
    if (!shift || !shift.isActive) {
      return res.status(404).json({ message: 'Không tìm thấy ca làm' });
    }
    if (String(shift.branchId) !== String(userBranchId)) {
      return res.status(403).json({ message: 'Ca này không thuộc branch của bạn' });
    }

    // 3. Kiểm tra ca đã có người chưa (1 ca / 1 NV / ngày)
    const taken = await Attendance.findOne({ shift: shiftId, workDate })
      .populate('user', 'fullName')
      .lean();
    if (taken) {
      return res.status(400).json({
        message: `Ca này đã có ${taken.user?.fullName || 'người khác'} checkin.`,
      });
    }

    // 4. Verify GPS — cần lấy branch lat/lng
    const branch = await Branch.findById(userBranchId).lean();
    if (!branch) {
      return res.status(500).json({ message: 'Không tìm thấy thông tin branch' });
    }
    if (
      typeof branch.latitude !== 'number' ||
      typeof branch.longitude !== 'number'
    ) {
      return res.status(500).json({
        message: 'Branch chưa cấu hình GPS. Liên hệ Admin để setup tọa độ.',
      });
    }

    const distance = calculateDistance(
      latitude, longitude,
      branch.latitude, branch.longitude
    );
    const radius = Number(branch.geofenceRadius) || 100;

    if (distance > radius) {
      return res.status(400).json({
        message: `Bạn đang ở cách ${Math.round(distance)}m so với ${branch.name}. Yêu cầu trong vòng ${radius}m. Vui lòng đến nơi làm việc.`,
        distance: Math.round(distance),
        allowedRadius: radius,
      });
    }

    // 5. Tính số phút trễ
    const checkInAt = new Date();
    const lateMinutes = calculateLateMinutes(
      checkInAt,
      shift.startTime,
      shift.crossesMidnight,
      shift.graceMinutes || 0
    );

    // 6. Tạo Attendance
    const attendance = await Attendance.create({
      user: userId,
      branchId: userBranchId,
      shift: shiftId,
      shiftName: shift.name,
      workDate,
      shiftStartTime: shift.startTime,
      shiftEndTime: shift.endTime,
      checkInAt,
      lateMinutes,
      latitude,
      longitude,
      distanceMeters: Math.round(distance),
      ipAddress: req.ip || req.headers['x-forwarded-for'] || '',
      userAgent: req.headers['user-agent'] || '',
    });

    // 7. ⭐ Auto tạo PenaltyRecord nếu trễ + shift có gắn latePenalty
    let penaltyRecord = null;
    if (lateMinutes > 0 && shift.latePenaltyId) {
      const penalty = shift.latePenaltyId;
      const { amount, appliedTier } = computePenaltyAmount(penalty, {
        minutes: lateMinutes,
      });

      if (amount > 0) {
        penaltyRecord = await PenaltyRecord.create({
          user: userId,
          branchId: userBranchId,
          year: checkInAt.getFullYear(),
          month: checkInAt.getMonth() + 1,
          penaltyId: penalty._id,
          penaltyName: penalty.name,
          penaltyType: penalty.type,
          severity: penalty.severity,
          minutes: lateMinutes,
          appliedTier,
          amount,
          occurredOn: checkInAt,
          reason: `Tự động: trễ ${lateMinutes} phút ca ${shift.name}`,
          attendanceId: attendance._id,
          autoCreated: true,
          createdBy: userId,
        });

        // Liên kết ngược
        await Attendance.findByIdAndUpdate(attendance._id, {
          $set: { penaltyRecordId: penaltyRecord._id },
        });
        attendance.penaltyRecordId = penaltyRecord._id;
      }
    }

    res.json({
      success: true,
      attendance,
      penaltyRecord,
      message: lateMinutes > 0
        ? `Đã checkin. Bạn trễ ${lateMinutes} phút${penaltyRecord ? ` (phạt -${penaltyRecord.amount.toLocaleString()}₫)` : ''}.`
        : 'Đã checkin đúng giờ. Chúc bạn ngày làm việc tốt!',
    });
  } catch (err) {
    console.error('[POST /attendance/checkin]', err);
    if (err.code === 11000) {
      return res.status(400).json({ message: 'Đã checkin rồi.' });
    }
    res.status(500).json({ message: err.message || 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/attendance/checkout/:id
// ═════════════════════════════════════════════════════════════════════════
router.post('/checkout/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const att = await Attendance.findById(id);
    if (!att) return res.status(404).json({ message: 'Không tìm thấy' });
    if (String(att.user) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Không phải checkin của bạn' });
    }
    if (att.checkOutAt) {
      return res.status(400).json({ message: 'Đã checkout rồi' });
    }

    att.checkOutAt = new Date();
    await att.save();
    res.json(att);
  } catch (err) {
    console.error('[POST /attendance/checkout]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/attendance/list?userId=&year=&month=
// Admin/Manager xem lịch sử checkin của 1 NV
// ═════════════════════════════════════════════════════════════════════════
router.get('/list', authenticate, async (req, res) => {
  try {
    const { userId, year, month } = req.query;
    const targetUserId = userId || req.user.id;

    if (!mongoose.isValidObjectId(targetUserId)) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }

    // Permission
    if (String(targetUserId) !== String(req.user.id)) {
      if (isAdmin(req)) {
        // OK
      } else if (isManager(req)) {
        const target = await User.findById(targetUserId).select('branchId').lean();
        if (!target || String(target.branchId) !== String(req.user.branchId)) {
          return res.status(403).json({ message: 'Không có quyền' });
        }
      } else {
        return res.status(403).json({ message: 'Không có quyền' });
      }
    }

    const filter = { user: targetUserId };
    if (year && month) {
      const y = parseInt(year, 10);
      const m = parseInt(month, 10);
      const start = `${y}-${String(m).padStart(2, '0')}-01`;
      const endDate = new Date(y, m, 1); // first day next month
      const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-01`;
      filter.workDate = { $gte: start, $lt: end };
    }

    const list = await Attendance.find(filter)
      .sort({ workDate: -1, checkInAt: -1 })
      .populate('shift', 'name startTime endTime')
      .populate('penaltyRecordId', 'amount minutes appliedTier')
      .lean();

    res.json(list);
  } catch (err) {
    console.error('[GET /attendance/list]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/attendance/:id/waive — Admin/Manager xóa phạt trễ (nếu có lý do)
// Body: { reason }
// ═════════════════════════════════════════════════════════════════════════
router.post('/:id/waive', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req) && !isManager(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }
    const { id } = req.params;
    const { reason = '' } = req.body;

    const att = await Attendance.findById(id);
    if (!att) return res.status(404).json({ message: 'Không tìm thấy' });

    // Manager chỉ xóa được trong branch mình
    if (isManager(req) && String(att.branchId) !== String(req.user.branchId)) {
      return res.status(403).json({ message: 'Không có quyền với branch khác' });
    }

    if (att.waiveLatePenalty) {
      return res.status(400).json({ message: 'Đã miễn phạt rồi' });
    }

    // Xóa PenaltyRecord nếu có
    if (att.penaltyRecordId) {
      await PenaltyRecord.findByIdAndDelete(att.penaltyRecordId);
    }

    att.waiveLatePenalty = true;
    att.waivedBy = req.user.id;
    att.waivedReason = reason;
    att.waivedAt = new Date();
    att.penaltyRecordId = null;
    await att.save();

    res.json({ success: true, attendance: att });
  } catch (err) {
    console.error('[POST /attendance/waive]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

module.exports = router;