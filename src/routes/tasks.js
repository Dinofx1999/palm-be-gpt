// backend/src/routes/tasks.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/taskController');

// ⚠️ ĐIỀU CHỈNH dòng dưới cho khớp middleware auth của dự án.
//   Nhiều route khác trong dự án dùng `authenticate` — nếu path/tên khác, sửa lại.
//   Ví dụ các kiểu thường gặp:
//     const { authenticate } = require('../middleware/auth');
//     const authenticate = require('../middleware/authenticate');
const { authenticate } = require('../middleware/auth');

// Tất cả route task yêu cầu đăng nhập (để biết createdBy / doneBy).
router.use(authenticate);

// GET /api/tasks?bookingId= | ?branchId= | ?status=pending|done|all
router.get('/', ctrl.getAll);

// POST /api/tasks   body: { title, bookingId?, branchId? }
router.post('/', ctrl.create);

// PATCH /api/tasks/:id/toggle   — tick xong / mở lại
router.patch('/:id/toggle', ctrl.toggle);

// PATCH /api/tasks/:id   — sửa tiêu đề
router.patch('/:id', ctrl.update);

// DELETE /api/tasks/:id
router.delete('/:id', ctrl.remove);

module.exports = router;