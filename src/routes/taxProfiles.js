const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/taxProfileController');

// ⭐ NEW 30/05/2026: Routes cho hồ sơ thuế / thông tin xuất HĐĐT.
//   Gắn vào app: app.use('/api/tax-profiles', require('./routes/taxProfiles'))
//   (đặt sau middleware auth nếu cần — theo convention dự án).

// Autocomplete: gõ tên hoặc MST → gợi ý
router.get('/search', ctrl.search);

// Lấy chính xác theo MST
router.get('/by-code/:taxCode', ctrl.getByCode);

// Lưu / cập nhật (upsert theo MST)
router.post('/', ctrl.upsert);

// Tăng lượt dùng khi chọn 1 gợi ý (tùy chọn)
router.patch('/:id/touch', ctrl.touch);

module.exports = router;