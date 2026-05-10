// backend/src/middleware/checkDevice.js
//
// Middleware kiểm tra device binding theo logic:
//   1. Nếu Branch toggle OFF → bỏ qua, cho pass
//   2. Nếu deviceId hợp lệ với user (đã trong knownDevices) → pass + update lastSeenAt
//   3. Nếu deviceId chưa ai dùng → pass + thêm vào knownDevices
//   4. Nếu deviceId trùng với user khác → CHẶN + log conflict
//
const User = require('../models/User');
const Branch = require('../models/Branch');
const DeviceConflictLog = require('../models/DeviceConflictLog');

/**
 * @param {string} action - 'login' | 'checkin'
 * @returns Express middleware
 */
function checkDevice(action = 'checkin') {
  return async (req, res, next) => {
    try {
      const { deviceId, userAgent, components, isFallback } = req.body || {};

      // Lấy user và branch
      const userId = req.user?.id || req.user?._id || req.body?.userId;
      const branchId = req.user?.branchId || req.body?.branchId;

      if (!userId) return next(); // không xác định được user, để route handler xử lý

      // 1. Check toggle ở branch
      let bindingEnabled = false;
      if (branchId) {
        const branch = await Branch.findById(branchId).select('attendanceSecurity').lean();
        const sec = branch?.attendanceSecurity || {};
        bindingEnabled =
          sec.deviceBindingEnabled === true &&
          (action === 'login' ? sec.enforceAtLogin !== false : sec.enforceAtCheckin !== false);
      }

      if (!bindingEnabled) {
        // Feature tắt — vẫn lưu device info để track (tùy chọn) nhưng không chặn
        return next();
      }

      // 2. Phải có deviceId mới check được
      if (!deviceId) {
        return res.status(400).json({
          message: 'Thiếu thông tin định danh thiết bị (deviceId). Vui lòng thử lại hoặc liên hệ Admin.',
          code: 'DEVICE_ID_MISSING',
        });
      }

      // 3. Tìm user nào đang owning deviceId này
      const ownerUser = await User.findOne({
        'knownDevices.deviceId': deviceId,
      }).select('_id username fullName knownDevices').lean();

      const isMyDevice = ownerUser && String(ownerUser._id) === String(userId);
      const isOtherUserDevice = ownerUser && String(ownerUser._id) !== String(userId);

      if (isOtherUserDevice) {
        // ⛔ CHẶN: device đang thuộc user khác → log + reject
        await DeviceConflictLog.create({
          attemptedUser: userId,
          deviceId,
          userAgent: userAgent || req.headers['user-agent'] || '',
          conflictWithUser: ownerUser._id,
          action,
          branchId,
          ip: req.ip || req.headers['x-forwarded-for'] || '',
          resolution: 'blocked',
        });

        return res.status(403).json({
          message: `Thiết bị này đã được sử dụng bởi nhân viên khác (${ownerUser.fullName || ownerUser.username}). Bạn không thể ${action === 'login' ? 'đăng nhập' : 'checkin'} từ thiết bị này. Vui lòng liên hệ Admin.`,
          code: 'DEVICE_CONFLICT',
          conflictWith: ownerUser.fullName || ownerUser.username,
        });
      }

      // 4. Pass — update knownDevices
      const now = new Date();
      if (isMyDevice) {
        // Đã có trong knownDevices → update lastSeenAt
        await User.updateOne(
          { _id: userId, 'knownDevices.deviceId': deviceId },
          {
            $set: {
              'knownDevices.$.lastSeenAt': now,
              'knownDevices.$.userAgent': userAgent || req.headers['user-agent'],
            },
          }
        );
      } else {
        // Device mới → thêm vào knownDevices
        await User.updateOne(
          { _id: userId },
          {
            $push: {
              knownDevices: {
                deviceId,
                userAgent: userAgent || req.headers['user-agent'] || '',
                components: components || {},
                firstSeenAt: now,
                lastSeenAt: now,
                isFallback: !!isFallback,
                source: action,
              },
            },
          }
        );

        // Log "máy mới" để admin biết (resolution: allowed)
        await DeviceConflictLog.create({
          attemptedUser: userId,
          deviceId,
          userAgent: userAgent || req.headers['user-agent'] || '',
          conflictWithUser: null,
          action,
          branchId,
          ip: req.ip || req.headers['x-forwarded-for'] || '',
          resolution: 'allowed',
          resolved: true,
          resolvedNote: 'Máy mới chưa ai dùng — auto pass',
        });
      }

      next();
    } catch (err) {
      console.error('[checkDevice middleware]', err);
      // Lỗi không liên quan logic → cho pass để không chặn flow
      next();
    }
  };
}

module.exports = { checkDevice };