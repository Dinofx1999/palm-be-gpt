// backend/src/routes/customerDisplayConfig.js
// Cấu hình màn hình khách theo chi nhánh.
//   - GET /public : PUBLIC (màn /customer-display không đăng nhập)
//   - GET /       : cần đăng nhập (trang quản trị)
//   - PUT /       : Admin/Manager
const router = require('express').Router();
const {
  getPublicByBranch, getByBranch, updateByBranch,
} = require('../controllers/customerDisplayConfigController');
const { authenticate, authorize } = require('../middleware/auth');

// PUBLIC — màn phụ lấy nội dung hiển thị (KHÔNG auth)
router.get('/public', getPublicByBranch);

// AUTH — trang quản trị đọc cấu hình đầy đủ
router.get('/', authenticate, getByBranch);

// AUTH (Admin/Manager) — lưu cấu hình
router.put('/', authenticate, authorize('Admin', 'Manager'), updateByBranch);

module.exports = router;