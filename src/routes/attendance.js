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
    if (!branchId) {
      return res.status(400).json({ message: 'User không thuộc branch nào' });
    }

    const workDate = getWorkDate();

    const [myAttendance, allShifts, takenAttendances, branch] = await Promise.all([
      Attendance.findOne({ user: userId, workDate })
        .populate('shift')
        .populate('penaltyRecordId', 'penaltyName amount minutes appliedTier penaltyType severity')
        .lean(),
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
// Body: { latitude, longitude }
// ═════════════════════════════════════════════════════════════════════════
router.post('/checkout/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { latitude, longitude } = req.body;

    // Validate GPS
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({
        message: 'Cần vị trí GPS để checkout. Vui lòng cho phép định vị.',
      });
    }

    const att = await Attendance.findById(id);
    if (!att) return res.status(404).json({ message: 'Không tìm thấy' });
    if (String(att.user) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Không phải checkin của bạn' });
    }
    if (att.checkOutAt) {
      return res.status(400).json({ message: 'Đã checkout rồi' });
    }

    // ⭐ Verify GPS — tương tự checkin
    const branch = await Branch.findById(att.branchId).lean();
    if (!branch) {
      return res.status(500).json({ message: 'Không tìm thấy branch' });
    }
    if (
      typeof branch.latitude !== 'number' ||
      typeof branch.longitude !== 'number'
    ) {
      return res.status(500).json({
        message: 'Branch chưa cấu hình GPS. Liên hệ Admin.',
      });
    }

    const distance = calculateDistance(
      latitude, longitude,
      branch.latitude, branch.longitude
    );
    const radius = Number(branch.geofenceRadius) || 100;

    if (distance > radius) {
      return res.status(400).json({
        message: `Bạn đang ở cách ${Math.round(distance)}m so với ${branch.name}. Yêu cầu trong vòng ${radius}m để checkout.`,
        distance: Math.round(distance),
        allowedRadius: radius,
      });
    }

    // ⭐ Tính số phút làm việc
    const checkOutAt = new Date();
    const workedMs = checkOutAt.getTime() - new Date(att.checkInAt).getTime();
    const workedMinutes = Math.max(0, Math.floor(workedMs / 60000));

    // Cập nhật attendance
    att.checkOutAt = checkOutAt;
    att.checkOutLatitude = latitude;
    att.checkOutLongitude = longitude;
    att.checkOutDistanceMeters = Math.round(distance);
    att.checkOutIpAddress = req.ip || req.headers['x-forwarded-for'] || '';
    att.checkOutUserAgent = req.headers['user-agent'] || '';
    att.workedMinutes = workedMinutes;

    await att.save();

    // Format thời lượng
    const hours = Math.floor(workedMinutes / 60);
    const mins = workedMinutes % 60;
    const durationStr = hours > 0
      ? `${hours} giờ${mins > 0 ? ` ${mins} phút` : ''}`
      : `${mins} phút`;

    res.json({
      success: true,
      attendance: att,
      message: `Đã checkout. Bạn đã làm việc ${durationStr}.`,
    });
  } catch (err) {
    console.error('[POST /attendance/checkout]', err);
    res.status(500).json({ message: err.message || 'Lỗi server' });
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

// ═════════════════════════════════════════════════════════════════════════
// ⭐ ADMIN/MANAGER ENDPOINTS — quản trị chấm công
// ═════════════════════════════════════════════════════════════════════════

// GET /api/attendance/admin/list — danh sách tất cả chấm công với filter
// Query: ?branchId=&workDate=&userId=&hasCheckout=&hasLateMinutes=&from=&to=
router.get('/admin/list', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req) && !isManager(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    const filter = {};

    // Manager chỉ xem được branch mình
    if (isManager(req)) {
      filter.branchId = req.user.branchId;
    } else if (req.query.branchId && mongoose.isValidObjectId(req.query.branchId)) {
      filter.branchId = req.query.branchId;
    }

    if (req.query.userId && mongoose.isValidObjectId(req.query.userId)) {
      filter.user = req.query.userId;
    }

    // Filter theo ngày
    if (req.query.workDate) {
      filter.workDate = req.query.workDate;
    } else if (req.query.from || req.query.to) {
      filter.workDate = {};
      if (req.query.from) filter.workDate.$gte = req.query.from;
      if (req.query.to) filter.workDate.$lte = req.query.to;
    }

    // Filter "có trễ"
    if (req.query.hasLateMinutes === 'true') {
      filter.lateMinutes = { $gt: 0 };
    } else if (req.query.hasLateMinutes === 'false') {
      filter.lateMinutes = 0;
    }

    // Filter "đã checkout chưa"
    if (req.query.hasCheckout === 'true') {
      filter.checkOutAt = { $ne: null };
    } else if (req.query.hasCheckout === 'false') {
      filter.checkOutAt = null;
    }

    const list = await Attendance.find(filter)
      .sort({ workDate: -1, checkInAt: -1 })
      .populate('user', 'fullName username role')
      .populate('shift', 'name startTime endTime crossesMidnight')
      .populate('branchId', 'name')
      .populate('penaltyRecordId', 'amount penaltyName')
      .limit(500)
      .lean();

    res.json(list);
  } catch (err) {
    console.error('[GET /attendance/admin/list]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// GET /api/attendance/admin/stats?workDate=YYYY-MM-DD
// Thống kê nhanh: tổng đi làm, trễ, phạt
// ═════════════════════════════════════════════════════════════════════════
router.get('/admin/stats', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req) && !isManager(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    const workDate = req.query.workDate || getWorkDate();
    const filter = { workDate };
    if (isManager(req)) {
      filter.branchId = req.user.branchId;
    } else if (req.query.branchId && mongoose.isValidObjectId(req.query.branchId)) {
      filter.branchId = req.query.branchId;
    }

    const list = await Attendance.find(filter)
      .populate('penaltyRecordId', 'amount')
      .lean();

    const total = list.length;
    const lateCount = list.filter((a) => (a.lateMinutes || 0) > 0).length;
    const onTimeCount = total - lateCount;
    const checkedOutCount = list.filter((a) => !!a.checkOutAt).length;
    const totalPenalty = list.reduce(
      (s, a) => s + (a.penaltyRecordId?.amount || 0),
      0
    );

    res.json({
      workDate,
      total,
      onTimeCount,
      lateCount,
      checkedOutCount,
      stillWorkingCount: total - checkedOutCount,
      totalPenalty,
    });
  } catch (err) {
    console.error('[GET /attendance/admin/stats]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /api/attendance/admin/:id/undo-checkout — xóa checkout (NV click nhầm)
// ═════════════════════════════════════════════════════════════════════════
router.post('/admin/:id/undo-checkout', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req) && !isManager(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }

    const att = await Attendance.findById(id);
    if (!att) return res.status(404).json({ message: 'Không tìm thấy' });
    if (isManager(req) && String(att.branchId) !== String(req.user.branchId)) {
      return res.status(403).json({ message: 'Không có quyền với branch khác' });
    }
    if (!att.checkOutAt) {
      return res.status(400).json({ message: 'Chấm công này chưa checkout' });
    }

    // Reset checkout fields
    att.checkOutAt = null;
    att.checkOutLatitude = null;
    att.checkOutLongitude = null;
    att.checkOutDistanceMeters = null;
    att.checkOutIpAddress = '';
    att.checkOutUserAgent = '';
    att.workedMinutes = 0;
    att.note = (att.note || '') +
      `\n[${new Date().toISOString()}] Undo checkout bởi ${req.user.username || req.user.id}: ${req.body.reason || ''}`;
    await att.save();

    res.json({ success: true, attendance: att });
  } catch (err) {
    console.error('[POST /attendance/admin/undo-checkout]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PATCH /api/attendance/admin/:id/change-shift — đổi sang ca khác
// Body: { shiftId, recalculateLate=true }
// ═════════════════════════════════════════════════════════════════════════
router.patch('/admin/:id/change-shift', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req) && !isManager(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }
    const { id } = req.params;
    const { shiftId, recalculateLate = true, reason = '' } = req.body;

    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(shiftId)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }

    const att = await Attendance.findById(id);
    if (!att) return res.status(404).json({ message: 'Không tìm thấy' });
    if (isManager(req) && String(att.branchId) !== String(req.user.branchId)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    const newShift = await WorkShift.findById(shiftId).populate('latePenaltyId').lean();
    if (!newShift) return res.status(404).json({ message: 'Không tìm thấy ca mới' });
    if (String(newShift.branchId) !== String(att.branchId)) {
      return res.status(400).json({ message: 'Ca không cùng branch' });
    }

    // Check ca mới đã có người khác checkin chưa
    const taken = await Attendance.findOne({
      shift: shiftId,
      workDate: att.workDate,
      _id: { $ne: id },
    }).populate('user', 'fullName').lean();
    if (taken) {
      return res.status(400).json({
        message: `Ca này đã có ${taken.user?.fullName || 'người khác'} checkin trong ngày ${att.workDate}`,
      });
    }

    // Cập nhật shift
    att.shift = shiftId;
    att.shiftName = newShift.name;
    att.shiftStartTime = newShift.startTime;
    att.shiftEndTime = newShift.endTime;

    // Tính lại lateMinutes nếu yêu cầu
    if (recalculateLate) {
      const newLate = calculateLateMinutes(
        new Date(att.checkInAt),
        newShift.startTime,
        newShift.crossesMidnight,
        newShift.graceMinutes || 0
      );

      // Xóa phạt cũ nếu có
      if (att.penaltyRecordId) {
        await PenaltyRecord.findByIdAndDelete(att.penaltyRecordId);
        att.penaltyRecordId = null;
      }

      att.lateMinutes = newLate;

      // Tạo phạt mới nếu vẫn trễ + ca mới có gắn penalty
      if (newLate > 0 && newShift.latePenaltyId) {
        const { amount, appliedTier } = computePenaltyAmount(newShift.latePenaltyId, {
          minutes: newLate,
        });
        if (amount > 0) {
          const checkInDate = new Date(att.checkInAt);
          const newPenalty = await PenaltyRecord.create({
            user: att.user,
            branchId: att.branchId,
            year: checkInDate.getFullYear(),
            month: checkInDate.getMonth() + 1,
            penaltyId: newShift.latePenaltyId._id,
            penaltyName: newShift.latePenaltyId.name,
            penaltyType: newShift.latePenaltyId.type,
            severity: newShift.latePenaltyId.severity,
            minutes: newLate,
            appliedTier,
            amount,
            occurredOn: checkInDate,
            reason: `Đổi ca: trễ ${newLate} phút ca ${newShift.name}`,
            attendanceId: att._id,
            autoCreated: true,
            createdBy: req.user.id,
          });
          att.penaltyRecordId = newPenalty._id;
        }
      }
    }

    att.note = (att.note || '') +
      `\n[${new Date().toISOString()}] Đổi sang ca ${newShift.name} bởi ${req.user.username || req.user.id}: ${reason}`;
    await att.save();

    res.json({ success: true, attendance: att });
  } catch (err) {
    console.error('[PATCH /attendance/admin/change-shift]', err);
    res.status(500).json({ message: err.message || 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// PATCH /api/attendance/admin/:id/note — thêm/sửa ghi chú
// ═════════════════════════════════════════════════════════════════════════
router.patch('/admin/:id/note', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req) && !isManager(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }
    const { id } = req.params;
    const { note = '' } = req.body;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }

    const att = await Attendance.findById(id);
    if (!att) return res.status(404).json({ message: 'Không tìm thấy' });
    if (isManager(req) && String(att.branchId) !== String(req.user.branchId)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    att.note = note;
    await att.save();
    res.json({ success: true, attendance: att });
  } catch (err) {
    console.error('[PATCH /attendance/admin/note]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// DELETE /api/attendance/admin/:id — xóa hoàn toàn (Admin only)
// ═════════════════════════════════════════════════════════════════════════
router.delete('/admin/:id', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req) && !isManager(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }

    const att = await Attendance.findById(id).lean();
    if (!att) return res.status(404).json({ message: 'Không tìm thấy' });

    // Manager chỉ được xóa trong branch của mình
    if (isManager(req) && String(att.branchId) !== String(req.user.branchId)) {
      return res.status(403).json({ message: 'Không có quyền với branch khác' });
    }

    // Xóa cả PenaltyRecord nếu có
    if (att.penaltyRecordId) {
      await PenaltyRecord.findByIdAndDelete(att.penaltyRecordId);
    }

    await Attendance.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /attendance/admin/:id]', err);
    res.status(500).json({ message: err.message || 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// ⭐ NEW: PATCH /api/attendance/admin/:id/edit-times
// Sửa giờ checkin/checkout + tự tính lại trễ + phạt
// Body: { checkInAt, checkOutAt, reason }
// ═════════════════════════════════════════════════════════════════════════
router.patch('/admin/:id/edit-times', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req) && !isManager(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }
    const { id } = req.params;
    const { checkInAt, checkOutAt, reason = '' } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }

    const att = await Attendance.findById(id);
    if (!att) return res.status(404).json({ message: 'Không tìm thấy' });
    if (isManager(req) && String(att.branchId) !== String(req.user.branchId)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    // Lấy shift để tính lại lateMinutes
    const shift = await WorkShift.findById(att.shift).populate('latePenaltyId').lean();
    if (!shift) {
      return res.status(500).json({ message: 'Không tìm thấy ca' });
    }

    // Cập nhật giờ
    if (checkInAt) {
      att.checkInAt = new Date(checkInAt);
      // Tính lại lateMinutes
      att.lateMinutes = calculateLateMinutes(
        att.checkInAt,
        shift.startTime,
        shift.crossesMidnight,
        shift.graceMinutes || 0
      );

      // Xóa phạt cũ
      if (att.penaltyRecordId) {
        await PenaltyRecord.findByIdAndDelete(att.penaltyRecordId);
        att.penaltyRecordId = null;
      }

      // Tạo phạt mới nếu vẫn trễ + ca có gắn penalty
      if (att.lateMinutes > 0 && shift.latePenaltyId) {
        const { amount, appliedTier } = computePenaltyAmount(shift.latePenaltyId, {
          minutes: att.lateMinutes,
        });
        if (amount > 0) {
          const newPenalty = await PenaltyRecord.create({
            user: att.user,
            branchId: att.branchId,
            year: att.checkInAt.getFullYear(),
            month: att.checkInAt.getMonth() + 1,
            penaltyId: shift.latePenaltyId._id,
            penaltyName: shift.latePenaltyId.name,
            penaltyType: shift.latePenaltyId.type,
            severity: shift.latePenaltyId.severity,
            minutes: att.lateMinutes,
            appliedTier,
            amount,
            occurredOn: att.checkInAt,
            reason: `Sửa giờ: trễ ${att.lateMinutes} phút ca ${shift.name}`,
            attendanceId: att._id,
            autoCreated: true,
            createdBy: req.user.id,
          });
          att.penaltyRecordId = newPenalty._id;
        }
      }
    }

    if (checkOutAt !== undefined) {
      if (checkOutAt === null || checkOutAt === '') {
        // Clear checkout
        att.checkOutAt = null;
        att.workedMinutes = 0;
      } else {
        att.checkOutAt = new Date(checkOutAt);
        // Tính lại workedMinutes
        const workedMs = att.checkOutAt.getTime() - new Date(att.checkInAt).getTime();
        att.workedMinutes = Math.max(0, Math.floor(workedMs / 60000));
      }
    }

    att.note = (att.note || '') +
      `\n[${new Date().toISOString()}] Sửa giờ bởi ${req.user.username || req.user.id}: ${reason || ''}`;

    await att.save();
    res.json({ success: true, attendance: att });
  } catch (err) {
    console.error('[PATCH /attendance/admin/edit-times]', err);
    res.status(500).json({ message: err.message || 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// ⭐ NEW: POST /api/attendance/admin/manual-create
// Admin tạo chấm công thay NV (NV quên checkin)
// Body: { userId, shiftId, workDate, checkInAt, checkOutAt?, reason }
// ═════════════════════════════════════════════════════════════════════════
router.post('/admin/manual-create', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req) && !isManager(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    const {
      userId,
      shiftId,
      workDate,           // YYYY-MM-DD
      checkInAt,          // ISO string
      checkOutAt,         // ISO string (optional)
      reason = '',
    } = req.body;

    if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(shiftId)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }
    if (!workDate || !checkInAt) {
      return res.status(400).json({ message: 'Thiếu workDate hoặc checkInAt' });
    }

    const targetUser = await User.findById(userId).lean();
    if (!targetUser) return res.status(404).json({ message: 'Không tìm thấy user' });

    if (isManager(req) && String(targetUser.branchId) !== String(req.user.branchId)) {
      return res.status(403).json({ message: 'Không có quyền với user này' });
    }

    const shift = await WorkShift.findById(shiftId).populate('latePenaltyId').lean();
    if (!shift) return res.status(404).json({ message: 'Không tìm thấy ca' });

    // Check NV đã có chấm công ngày này chưa
    const existingNV = await Attendance.findOne({ user: userId, workDate });
    if (existingNV) {
      return res.status(400).json({
        message: `NV này đã có chấm công ca ${existingNV.shiftName} ngày ${workDate}`,
      });
    }

    // Check ca này đã có người khác chiếm chưa
    const existingShift = await Attendance.findOne({ shift: shiftId, workDate });
    if (existingShift) {
      const u = await User.findById(existingShift.user).select('fullName').lean();
      return res.status(400).json({
        message: `Ca này đã được ${u?.fullName || 'người khác'} checkin trong ngày ${workDate}`,
      });
    }

    const checkInDate = new Date(checkInAt);
    const checkOutDate = checkOutAt ? new Date(checkOutAt) : null;

    // Tính lateMinutes
    const lateMinutes = calculateLateMinutes(
      checkInDate,
      shift.startTime,
      shift.crossesMidnight,
      shift.graceMinutes || 0
    );

    // Tính workedMinutes nếu có checkout
    let workedMinutes = 0;
    if (checkOutDate) {
      workedMinutes = Math.max(0, Math.floor(
        (checkOutDate.getTime() - checkInDate.getTime()) / 60000
      ));
    }

    // Tạo attendance
    const att = await Attendance.create({
      user: userId,
      branchId: targetUser.branchId,
      shift: shiftId,
      shiftName: shift.name,
      shiftStartTime: shift.startTime,
      shiftEndTime: shift.endTime,
      workDate,
      checkInAt: checkInDate,
      checkOutAt: checkOutDate,
      lateMinutes,
      workedMinutes,
      // GPS để null vì manual create không có
      latitude: null,
      longitude: null,
      distanceMeters: null,
      ipAddress: req.ip || '',
      userAgent: 'manual-admin-' + (req.user.username || req.user.id),
      note: `[${new Date().toISOString()}] Tạo bởi Admin/Manager ${req.user.username || req.user.id}: ${reason}`,
    });

    // Tạo phạt nếu trễ + ca có gắn penalty
    if (lateMinutes > 0 && shift.latePenaltyId) {
      const { amount, appliedTier } = computePenaltyAmount(shift.latePenaltyId, {
        minutes: lateMinutes,
      });
      if (amount > 0) {
        const newPenalty = await PenaltyRecord.create({
          user: userId,
          branchId: targetUser.branchId,
          year: checkInDate.getFullYear(),
          month: checkInDate.getMonth() + 1,
          penaltyId: shift.latePenaltyId._id,
          penaltyName: shift.latePenaltyId.name,
          penaltyType: shift.latePenaltyId.type,
          severity: shift.latePenaltyId.severity,
          minutes: lateMinutes,
          appliedTier,
          amount,
          occurredOn: checkInDate,
          reason: `Manual: trễ ${lateMinutes} phút ca ${shift.name}`,
          attendanceId: att._id,
          autoCreated: true,
          createdBy: req.user.id,
        });
        att.penaltyRecordId = newPenalty._id;
        await att.save();
      }
    }

    res.json({ success: true, attendance: att });
  } catch (err) {
    console.error('[POST /attendance/admin/manual-create]', err);
    res.status(500).json({ message: err.message || 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// ⭐ NEW: PATCH /api/attendance/admin/:id/transfer
// Bàn giao ca cho NV khác (NV A đột xuất nghỉ, B làm thay)
// Body: { newUserId, reason }
// ═════════════════════════════════════════════════════════════════════════
router.patch('/admin/:id/transfer', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req) && !isManager(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }
    const { id } = req.params;
    const { newUserId, reason = '' } = req.body;

    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(newUserId)) {
      return res.status(400).json({ message: 'id không hợp lệ' });
    }

    const att = await Attendance.findById(id);
    if (!att) return res.status(404).json({ message: 'Không tìm thấy' });
    if (isManager(req) && String(att.branchId) !== String(req.user.branchId)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    const newUser = await User.findById(newUserId).lean();
    if (!newUser) return res.status(404).json({ message: 'Không tìm thấy NV mới' });

    if (String(newUser.branchId) !== String(att.branchId)) {
      return res.status(400).json({ message: 'NV mới không cùng branch' });
    }

    // Check NV mới đã có chấm công ngày này chưa
    const existing = await Attendance.findOne({
      user: newUserId,
      workDate: att.workDate,
      _id: { $ne: id },
    });
    if (existing) {
      return res.status(400).json({
        message: `${newUser.fullName} đã có chấm công ca khác ngày ${att.workDate}`,
      });
    }

    const oldUserId = att.user;
    const oldUser = await User.findById(oldUserId).select('fullName').lean();

    // Chuyển user
    att.user = newUserId;

    // Chuyển luôn PenaltyRecord nếu có
    if (att.penaltyRecordId) {
      await PenaltyRecord.findByIdAndUpdate(att.penaltyRecordId, {
        user: newUserId,
        reason: `Bàn giao từ ${oldUser?.fullName || oldUserId}: ${reason}`,
      });
    }

    att.note = (att.note || '') +
      `\n[${new Date().toISOString()}] Bàn giao từ ${oldUser?.fullName || oldUserId} → ${newUser.fullName} bởi ${req.user.username || req.user.id}: ${reason}`;

    await att.save();
    res.json({ success: true, attendance: att });
  } catch (err) {
    console.error('[PATCH /attendance/admin/transfer]', err);
    res.status(500).json({ message: err.message || 'Lỗi server' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// ⭐ NEW: GET /api/attendance/admin/users-in-branch
// Lấy danh sách NV của branch (cho filter + manual create + transfer)
// ═════════════════════════════════════════════════════════════════════════
router.get('/admin/users-in-branch', authenticate, async (req, res) => {
  try {
    if (!isAdmin(req) && !isManager(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }

    let branchId;
    if (isManager(req)) {
      branchId = req.user.branchId;
    } else if (req.query.branchId && mongoose.isValidObjectId(req.query.branchId)) {
      branchId = req.query.branchId;
    } else {
      return res.status(400).json({ message: 'Thiếu branchId' });
    }

    const users = await User.find({
      branchId,
      isActive: { $ne: false },
      role: { $in: ['Receptionist', 'Staff', 'Manager'] },
    })
      .select('_id fullName username role')
      .sort({ fullName: 1 })
      .lean();

    res.json(users);
  } catch (err) {
    console.error('[GET /attendance/admin/users-in-branch]', err);
    res.status(500).json({ message: 'Lỗi server' });
  }
});

module.exports = router;