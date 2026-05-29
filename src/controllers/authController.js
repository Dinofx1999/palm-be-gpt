const jwt  = require('jsonwebtoken');
const User = require('../models/User');
const Branch = require('../models/Branch');
const DeviceConflictLog = require('../models/DeviceConflictLog');

const JWT_SECRET  = process.env.JWT_SECRET  || 'luxstay-secret-2025';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

const login = async (req, res, next) => {
  try {
    const { username, password, deviceId, userAgent, components, isFallback } = req.body;
    if (!username || !password)
      return res.status(400).json({ success: false, message: 'Thiếu username hoặc password' });

    // ⭐ Cho phép đăng nhập bằng USERNAME hoặc EMAIL (không phân biệt hoa/thường)
    const identifier = String(username).trim();
    const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const user = await User.findOne({
      $or: [
        { username: identifier.toLowerCase() },
        { email: { $regex: `^${escapeRegex(identifier)}$`, $options: 'i' } },
      ],
    }).populate('branchId', 'name address city attendanceSecurity');

    if (!user)
      return res.status(401).json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu' });

    if (!user.isActive)
      return res.status(403).json({ success: false, message: 'Tài khoản đã bị khoá' });

    const match = await user.comparePassword(password);
    if (!match)
      return res.status(401).json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu' });

    const branchObj = user.branchId && typeof user.branchId === 'object' ? user.branchId : null;
    const branchIdStr = branchObj?._id?.toString() ?? null;
    const branchNameStr = branchObj?.name ?? '';

    // ═══════════════════════════════════════════════════════════════════════
    // ⭐ DEVICE BINDING CHECK
    //   - Admin: BYPASS hoàn toàn (luôn được login từ mọi máy)
    //   - Khác: tuân theo cấu hình branch
    // ═══════════════════════════════════════════════════════════════════════
    const isAdmin = user.role === 'Admin';

    if (deviceId && branchObj && !isAdmin) {
      const sec = branchObj.attendanceSecurity || {};
      const enabled = sec.deviceBindingEnabled === true && sec.enforceAtLogin !== false;

      if (enabled) {
        // Tìm user khác đang owning deviceId này
        const ownerUser = await User.findOne({
          _id: { $ne: user._id },
          'knownDevices.deviceId': deviceId,
        }).select('_id username fullName role').lean();

        if (ownerUser) {
          // ⛔ CHẶN: device đang thuộc user khác
          await DeviceConflictLog.create({
            attemptedUser: user._id,
            deviceId,
            userAgent: userAgent || req.headers['user-agent'] || '',
            conflictWithUser: ownerUser._id,
            action: 'login',
            branchId: branchObj._id,
            ip: req.ip || req.headers['x-forwarded-for'] || '',
            resolution: 'blocked',
          });

          console.warn('[auth.login] 🚫 DEVICE_CONFLICT', {
            attemptedUser: user.username,
            conflictWith: ownerUser.username,
            deviceId: deviceId.substring(0, 12) + '...',
          });

          return res.status(403).json({
            success: false,
            code: 'DEVICE_CONFLICT',
            message: `Thiết bị này đã được sử dụng bởi nhân viên khác (${ownerUser.fullName || ownerUser.username}). Bạn không thể đăng nhập từ thiết bị này. Vui lòng liên hệ Admin.`,
            conflictWith: ownerUser.fullName || ownerUser.username,
          });
        }

        // Pass — update knownDevices
        const exists = (user.knownDevices || []).some((d) => d.deviceId === deviceId);
        const now = new Date();

        if (exists) {
          await User.updateOne(
            { _id: user._id, 'knownDevices.deviceId': deviceId },
            {
              $set: {
                'knownDevices.$.lastSeenAt': now,
                'knownDevices.$.userAgent': userAgent || req.headers['user-agent'] || '',
              },
            }
          );
        } else {
          await User.updateOne(
            { _id: user._id },
            {
              $push: {
                knownDevices: {
                  deviceId,
                  userAgent: userAgent || req.headers['user-agent'] || '',
                  components: components || {},
                  firstSeenAt: now,
                  lastSeenAt: now,
                  isFallback: !!isFallback,
                  source: 'login',
                },
              },
            }
          );

          await DeviceConflictLog.create({
            attemptedUser: user._id,
            deviceId,
            userAgent: userAgent || req.headers['user-agent'] || '',
            conflictWithUser: null,
            action: 'login',
            branchId: branchObj._id,
            ip: req.ip || req.headers['x-forwarded-for'] || '',
            resolution: 'allowed',
            resolved: true,
            resolvedNote: 'Máy mới chưa ai dùng — auto pass',
          });

          console.log('[auth.login] ✓ NEW_DEVICE auto-added', {
            user: user.username,
            deviceId: deviceId.substring(0, 12) + '...',
          });
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ⭐ ADMIN: Vẫn lưu device để track (nhưng KHÔNG check conflict)
    //   Để có lịch sử thiết bị Admin đã dùng (audit)
    //   Đồng thời log vào DeviceConflictLog với note "Admin bypass"
    // ═══════════════════════════════════════════════════════════════════════
    if (deviceId && isAdmin) {
      const exists = (user.knownDevices || []).some((d) => d.deviceId === deviceId);
      const now = new Date();

      if (exists) {
        // Đã có → update lastSeenAt
        await User.updateOne(
          { _id: user._id, 'knownDevices.deviceId': deviceId },
          {
            $set: {
              'knownDevices.$.lastSeenAt': now,
              'knownDevices.$.userAgent': userAgent || req.headers['user-agent'] || '',
            },
          }
        );
      } else {
        // Mới → push (KHÔNG check conflict, vì Admin được phép dùng máy của ai cũng được)
        await User.updateOne(
          { _id: user._id },
          {
            $push: {
              knownDevices: {
                deviceId,
                userAgent: userAgent || req.headers['user-agent'] || '',
                components: components || {},
                firstSeenAt: now,
                lastSeenAt: now,
                isFallback: !!isFallback,
                source: 'login',
                label: 'Admin', // optional flag
              },
            },
          }
        );

        // Log info: Admin login từ máy mới (nếu máy đang thuộc user khác → log để audit)
        if (branchObj) {
          const ownerUser = await User.findOne({
            _id: { $ne: user._id },
            'knownDevices.deviceId': deviceId,
          }).select('_id username fullName').lean();

          await DeviceConflictLog.create({
            attemptedUser: user._id,
            deviceId,
            userAgent: userAgent || req.headers['user-agent'] || '',
            conflictWithUser: ownerUser?._id || null,
            action: 'login',
            branchId: branchObj._id,
            ip: req.ip || req.headers['x-forwarded-for'] || '',
            resolution: 'allowed',
            resolved: true,
            resolvedNote: ownerUser
              ? `Admin bypass — máy đang thuộc ${ownerUser.fullName || ownerUser.username}`
              : 'Admin login máy mới — auto pass',
          });

          if (ownerUser) {
            console.log('[auth.login] ⚡ ADMIN_BYPASS', {
              admin: user.username,
              deviceOwner: ownerUser.username,
              deviceId: deviceId.substring(0, 12) + '...',
            });
          }
        }
      }
    }
    // ═══════════════════════════════════════════════════════════════════════

    // Token vẫn lưu branchId là string (không lưu object)
    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role, branchId: branchIdStr },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    const safeUser = user.toSafeObject();
    safeUser.branchId = branchIdStr;
    safeUser.branchName = branchNameStr;
    safeUser.avatar = user.avatar || '';      // ⭐ FIX: toSafeObject không có avatar → bổ sung
    safeUser.email  = user.email  || safeUser.email  || '';
    safeUser.phone  = user.phone  || safeUser.phone  || '';

    console.log('[auth.login]', {
      username: user.username,
      role: user.role,
      branchId: branchIdStr,
      branchName: branchNameStr,
      isAdminBypass: isAdmin,
    });

    if (branchNameStr && user.branchName && branchNameStr !== user.branchName) {
      console.warn(`[auth.login] ⚠️ User ${user.username} có branchName cache (${user.branchName}) KHÁC với branch thực tế (${branchNameStr}). Cần update DB!`);
    }

    res.json({
      success: true,
      message: 'Đăng nhập thành công',
      data: { token, user: safeUser },
    });
  } catch (err) { next(err); }
};

const me = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id)
      .select('-password')
      .populate('branchId', 'name address city');

    if (!user)
      return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });

    const branchObj = user.branchId && typeof user.branchId === 'object' ? user.branchId : null;
    const branchIdStr = branchObj?._id?.toString() ?? null;
    const branchNameStr = branchObj?.name ?? '';

    const safeUser = user.toObject();
    delete safeUser.knownDevices;
    delete safeUser.password;
    safeUser.branchId = branchIdStr;
    safeUser.branchName = branchNameStr;

    res.json({ success: true, data: safeUser });
  } catch (err) { next(err); }
};

const logout = (_req, res) => {
  res.json({ success: true, message: 'Đã đăng xuất' });
};

module.exports = { login, me, logout };