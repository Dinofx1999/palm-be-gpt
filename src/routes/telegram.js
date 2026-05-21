// backend/src/routes/telegram.js
// ════════════════════════════════════════════════════════════════════
// Route Telegram — test gửi tin + xem trạng thái cấu hình.
// Gắn vào index.js:  app.use('/api/telegram', require('./routes/telegram'))
// ════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { testSend, status } = require('../controllers/telegramController');

// Chỉ Admin/Manager mới test được (tránh spam). Nếu middleware tên khác, đổi lại.
function requireStaff(req, res, next) {
  const role = req.user?.role;
  if (role === 'Admin' || role === 'Manager') return next();
  return res.status(403).json({ success: false, message: 'Chỉ Admin/Manager' });
}

router.get('/status', authenticate, status);
router.post('/test', authenticate, requireStaff, testSend);

module.exports = router;