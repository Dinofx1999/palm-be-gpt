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
const { authenticate, authorize } = require('../middleware/auth');

// Lấy config khóa của chi nhánh (FE đặt phòng gọi để biết có bật khóa + cổng agent)
router.get('/config', authenticate, ctrl.getLockConfig);

// Tạo/sửa config khóa của chi nhánh (Admin/Manager)
router.put('/config', authenticate, authorize('Admin', 'Manager'), ctrl.upsertLockConfig);

// Lấy mã khóa của 1 phòng (FE gọi trước khi tạo thẻ)
router.get('/room-code/:roomId', authenticate, ctrl.getRoomLockCode);

// Cập nhật mã khóa cho 1 phòng (dashboard phòng)
router.patch('/room-code/:roomId', authenticate, authorize('Admin', 'Manager'), ctrl.setRoomLockCode);

module.exports = router;
