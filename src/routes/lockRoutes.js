// src/routes/lockRoutes.js
// ════════════════════════════════════════════════════════════════════
// Routes cấu hình khóa cửa. Mount vào app:
//   const lockRoutes = require('./routes/lockRoutes');
//   app.use('/api/lock', lockRoutes);
//
// Thay `auth`, `requireRole` bằng middleware xác thực/phân quyền hiện có của bạn.
// ════════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/lockConfigController');

// const auth = require('../middleware/auth');
// const requireRole = require('../middleware/requireRole');

// Lấy config khóa của chi nhánh (FE đặt phòng gọi để biết có bật khóa + cổng agent)
router.get('/config', /* auth, */ ctrl.getLockConfig);

// Tạo/sửa config khóa của chi nhánh (Admin/Manager)
router.put('/config', /* auth, requireRole('Admin','Manager'), */ ctrl.upsertLockConfig);

// Lấy mã khóa của 1 phòng (FE gọi trước khi tạo thẻ)
router.get('/room-code/:roomId', /* auth, */ ctrl.getRoomLockCode);

// Cập nhật mã khóa cho 1 phòng (dashboard phòng)
router.patch('/room-code/:roomId', /* auth, requireRole('Admin','Manager'), */ ctrl.setRoomLockCode);

module.exports = router;