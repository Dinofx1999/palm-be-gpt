// backend/src/routes/cccd.js
// ⭐ NEW 30/05/2026: Route giải mã QR CCCD phía server.
//   Mount trong app: app.use('/api/cccd', require('./routes/cccd'))
//
//   Lưu ý: ảnh base64 có thể lớn → đảm bảo body parser cho phép.
//   Trong app chính (index.js), tăng giới hạn JSON nếu cần:
//     app.use(express.json({ limit: '12mb' }))
const express = require('express');
const router = express.Router();
const { decode } = require('../controllers/cccdController');

// Nếu muốn yêu cầu đăng nhập, thêm middleware auth ở đây (tuỳ hệ thống).
router.post('/decode', decode);

module.exports = router;