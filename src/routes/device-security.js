// backend/src/routes/device-security.js
//
// Admin routes for Device Binding feature
//
const router = require('express').Router();
const User = require('../models/User');
const Branch = require('../models/Branch');
const DeviceConflictLog = require('../models/DeviceConflictLog');
const { authenticate } = require('../middleware/auth');

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'Admin') {
    return res.status(403).json({ success: false, message: 'Chỉ Admin được truy cập' });
  }
  next();
};

// ════════════════════════════════════════════════════════════════════════
// GET /branches-security
// ════════════════════════════════════════════════════════════════════════
router.get('/branches-security', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const branches = await Branch.find({})
      .select('name address city status attendanceSecurity')
      .lean();

    const result = branches.map((b) => ({
      _id: b._id,
      name: b.name,
      address: b.address,
      city: b.city,
      status: b.status,
      attendanceSecurity: b.attendanceSecurity || {
        deviceBindingEnabled: false,
        autoApproveNewDevice: true,
        enforceAtLogin: true,
        enforceAtCheckin: true,
      },
    }));

    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════
// GET /branch/:id/security
// ════════════════════════════════════════════════════════════════════════
router.get('/branch/:id/security', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const branch = await Branch.findById(req.params.id)
      .select('name attendanceSecurity').lean();
    if (!branch) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy chi nhánh' });
    }
    res.json({
      success: true,
      data: {
        branchId: branch._id,
        branchName: branch.name,
        attendanceSecurity: branch.attendanceSecurity || {
          deviceBindingEnabled: false,
          autoApproveNewDevice: true,
          enforceAtLogin: true,
          enforceAtCheckin: true,
        },
      },
    });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════
// PUT /branch/:id/security
// ════════════════════════════════════════════════════════════════════════
router.put('/branch/:id/security', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { attendanceSecurity } = req.body;
    if (!attendanceSecurity || typeof attendanceSecurity !== 'object') {
      return res.status(400).json({ success: false, message: 'Thiếu attendanceSecurity' });
    }

    const allowed = ['deviceBindingEnabled', 'autoApproveNewDevice', 'enforceAtLogin', 'enforceAtCheckin'];
    const update = {};
    allowed.forEach((k) => {
      if (typeof attendanceSecurity[k] === 'boolean') {
        update[`attendanceSecurity.${k}`] = attendanceSecurity[k];
      }
    });

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, message: 'Không có field nào hợp lệ' });
    }

    const branch = await Branch.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true }
    ).select('name attendanceSecurity').lean();

    if (!branch) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy chi nhánh' });
    }

    console.log('[admin] Updated security config:', {
      branch: branch.name,
      config: branch.attendanceSecurity,
      by: req.user.username,
    });

    res.json({
      success: true,
      message: 'Đã cập nhật cấu hình bảo mật',
      data: {
        branchId: branch._id,
        attendanceSecurity: branch.attendanceSecurity,
      },
    });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════
// GET /users/:id/devices
// ════════════════════════════════════════════════════════════════════════
router.get('/users/:id/devices', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id)
      .select('username fullName role knownDevices').lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy NV' });
    }
    res.json({
      success: true,
      data: {
        userId: user._id,
        fullName: user.fullName,
        username: user.username,
        role: user.role,
        devices: user.knownDevices || [],
      },
    });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════
// DELETE /users/:userId/devices/:deviceId
// ════════════════════════════════════════════════════════════════════════
router.delete('/users/:userId/devices/:deviceId', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { userId, deviceId } = req.params;
    const result = await User.updateOne(
      { _id: userId },
      { $pull: { knownDevices: { deviceId } } }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy device' });
    }

    res.json({ success: true, message: 'Đã xóa thiết bị' });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════
// PATCH /users/:userId/devices/:deviceId/label
// ════════════════════════════════════════════════════════════════════════
router.patch('/users/:userId/devices/:deviceId/label', authenticate, async (req, res, next) => {
  try {
    const { userId, deviceId } = req.params;
    const { label } = req.body;

    if (req.user.role !== 'Admin' && String(req.user.id) !== String(userId)) {
      return res.status(403).json({ success: false, message: 'Không có quyền' });
    }

    await User.updateOne(
      { _id: userId, 'knownDevices.deviceId': deviceId },
      { $set: { 'knownDevices.$.label': label || '' } }
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════
// GET /device-conflicts
// ════════════════════════════════════════════════════════════════════════
router.get('/device-conflicts', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { branchId, resolved, limit = 100 } = req.query;
    const filter = {};
    if (branchId) filter.branchId = branchId;
    if (resolved !== undefined) filter.resolved = resolved === 'true';

    const logs = await DeviceConflictLog.find(filter)
      .populate('attemptedUser', 'username fullName role')
      .populate('conflictWithUser', 'username fullName')
      .populate('branchId', 'name')
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .lean();

    res.json({ success: true, data: logs });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════
// PATCH /device-conflicts/:id/resolve
// ════════════════════════════════════════════════════════════════════════
router.patch('/device-conflicts/:id/resolve', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { resolution = 'allowed', note = '' } = req.body;
    const log = await DeviceConflictLog.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          resolved: true,
          resolvedBy: req.user.id,
          resolvedAt: new Date(),
          resolvedNote: note,
          resolution,
        },
      },
      { new: true }
    );
    if (!log) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy log' });
    }
    res.json({ success: true, data: log });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════
// ⭐ NEW: POST /device-conflicts/:id/release-device
//   Gỡ device khỏi NV owner cũ → cho phép NV mới dùng máy
// ════════════════════════════════════════════════════════════════════════
router.post('/device-conflicts/:id/release-device', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { note = '' } = req.body;

    const log = await DeviceConflictLog.findById(req.params.id)
      .populate('conflictWithUser', '_id username fullName')
      .populate('attemptedUser', '_id username fullName');
    if (!log) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy log' });
    }

    if (!log.conflictWithUser) {
      return res.status(400).json({
        success: false,
        message: 'Log này không có user owner (máy mới — không cần gỡ)',
      });
    }

    if (!log.deviceId) {
      return res.status(400).json({ success: false, message: 'Log không có deviceId' });
    }

    const ownerUserId = log.conflictWithUser._id;
    const ownerUserName = log.conflictWithUser.fullName || log.conflictWithUser.username;

    const result = await User.updateOne(
      { _id: ownerUserId },
      { $pull: { knownDevices: { deviceId: log.deviceId } } }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({
        success: false,
        message: `Không tìm thấy device này trong danh sách của ${ownerUserName} (có thể đã bị xóa trước đó)`,
      });
    }

    // Đánh dấu log hiện tại đã xử lý
    log.resolved = true;
    log.resolvedBy = req.user.id;
    log.resolvedAt = new Date();
    log.resolution = 'allowed';
    log.resolvedNote = `Đã gỡ device khỏi ${ownerUserName}.${note ? ' Note: ' + note : ''}`;
    await log.save();

    // Bonus: tự xử lý các log khác cùng deviceId + cùng owner (tránh Admin phải click nhiều lần)
    await DeviceConflictLog.updateMany(
      {
        deviceId: log.deviceId,
        conflictWithUser: ownerUserId,
        resolved: false,
        _id: { $ne: log._id },
      },
      {
        $set: {
          resolved: true,
          resolvedBy: req.user.id,
          resolvedAt: new Date(),
          resolution: 'allowed',
          resolvedNote: `Tự xử lý: device đã được gỡ khỏi ${ownerUserName}`,
        },
      }
    );

    console.log('[admin] Released device:', {
      deviceId: log.deviceId.substring(0, 12) + '...',
      removedFromUser: ownerUserName,
      by: req.user.username,
    });

    res.json({
      success: true,
      message: `Đã gỡ thiết bị khỏi ${ownerUserName}. Lần sau ${log.attemptedUser?.fullName || 'NV'} dùng máy này sẽ được pass.`,
      removedFromUser: ownerUserName,
      deviceId: log.deviceId,
      log,
    });
  } catch (err) { next(err); }
});

module.exports = router;