// src/controllers/lockConfigController.js
// ════════════════════════════════════════════════════════════════════
// Quản lý cấu hình khóa cửa theo chi nhánh + lấy mã khóa của phòng.
// ════════════════════════════════════════════════════════════════════
const LockConfig = require('../models/LockConfig');
const Room = require('../models/Room');

// Chuẩn response gọn
const ok = (res, data) => res.json({ success: true, data });
const fail = (res, code, message) => res.status(code).json({ success: false, message });

// ── GET /api/lock/config?branchId=... ─────────────────────────────
//   Trả config khóa của chi nhánh. Nếu chưa có → trả mặc định (disabled).
//   FE gọi khi mở màn đặt phòng để biết chi nhánh này có dùng khóa không + cổng agent.
exports.getLockConfig = async (req, res) => {
  try {
    const branchId = req.query.branchId || req.user?.branchId;
    if (!branchId) return fail(res, 400, 'Thiếu branchId');

    let cfg = await LockConfig.findOne({ branchId }).lean();
    if (!cfg) {
      // chưa cấu hình → mặc định tắt
      cfg = {
        branchId, enabled: false, lockBrand: 'DLOCK',
        lockType: null, agentPort: 2000,
        isInputCardToCheckout: false, addCheckoutMinute: 0, minusCheckinMinute: 0,
      };
    }
    return ok(res, cfg);
  } catch (e) {
    console.error('[getLockConfig]', e);
    return fail(res, 500, 'Lỗi lấy cấu hình khóa');
  }
};

// ── PUT /api/lock/config ──────────────────────────────────────────
//   Tạo/cập nhật config khóa cho chi nhánh (Admin/Manager). Upsert theo branchId.
exports.upsertLockConfig = async (req, res) => {
  try {
    const {
      branchId, enabled, lockType, agentPort,
      isInputCardToCheckout, addCheckoutMinute, minusCheckinMinute, note,
    } = req.body || {};
    if (!branchId) return fail(res, 400, 'Thiếu branchId');

    const update = {
      branchId,
      lockBrand: 'DLOCK',
      ...(enabled !== undefined && { enabled: !!enabled }),
      ...(lockType !== undefined && { lockType }),
      ...(agentPort !== undefined && { agentPort: Number(agentPort) || 2000 }),
      ...(isInputCardToCheckout !== undefined && { isInputCardToCheckout: !!isInputCardToCheckout }),
      ...(addCheckoutMinute !== undefined && { addCheckoutMinute: Number(addCheckoutMinute) || 0 }),
      ...(minusCheckinMinute !== undefined && { minusCheckinMinute: Number(minusCheckinMinute) || 0 }),
      ...(note !== undefined && { note }),
    };

    const cfg = await LockConfig.findOneAndUpdate(
      { branchId },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return ok(res, cfg);
  } catch (e) {
    console.error('[upsertLockConfig]', e);
    return fail(res, 500, 'Lỗi lưu cấu hình khóa');
  }
};

// ── GET /api/lock/room-code/:roomId ───────────────────────────────
//   Lấy mã khóa (lockCode "1.2.28") của 1 phòng để FE truyền cho agent makecard.
//   Trả kèm config chi nhánh để FE biết cổng agent + có bật khóa không.
exports.getRoomLockCode = async (req, res) => {
  try {
    const room = await Room.findById(req.params.roomId).lean();
    if (!room) return fail(res, 404, 'Không tìm thấy phòng');

    const cfg = await LockConfig.findOne({ branchId: room.branchId }).lean();
    const lockCode = room.lockCode || '';

    return ok(res, {
      roomId: String(room._id),
      number: room.number,
      lockCode,                                  // "1.2.28" — rỗng nếu chưa map
      hasLockCode: !!lockCode,
      branchId: String(room.branchId),
      lockEnabled: cfg?.enabled ?? false,
      agentPort: cfg?.agentPort ?? 2000,
      lockType: cfg?.lockType ?? null,
    });
  } catch (e) {
    console.error('[getRoomLockCode]', e);
    return fail(res, 500, 'Lỗi lấy mã khóa phòng');
  }
};

// ── PATCH /api/lock/room-code/:roomId  body:{ lockCode } ──────────
//   Cập nhật mã khóa cho 1 phòng (dùng trong dashboard phòng).
exports.setRoomLockCode = async (req, res) => {
  try {
    const { lockCode } = req.body || {};
    const room = await Room.findByIdAndUpdate(
      req.params.roomId,
      { $set: { lockCode: (lockCode || '').toString().trim() } },
      { new: true }
    ).lean();
    if (!room) return fail(res, 404, 'Không tìm thấy phòng');
    return ok(res, { roomId: String(room._id), lockCode: room.lockCode || '' });
  } catch (e) {
    console.error('[setRoomLockCode]', e);
    return fail(res, 500, 'Lỗi cập nhật mã khóa phòng');
  }
};