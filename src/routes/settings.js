// backend/src/routes/settings.js
// Cấu hình hệ thống — chỉ Admin.
// Đăng ký: app.use('/api/settings', require('./routes/settings'));
const router = require('express').Router();
const ctrl = require('../controllers/settingsController');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/',               authenticate, authorize('Admin'), ctrl.getPublicSettings);
router.put('/',               authenticate, authorize('Admin'), ctrl.updateSettings);
router.post('/test-telegram', authenticate, authorize('Admin'), ctrl.testTelegram);
router.post('/test-email',    authenticate, authorize('Admin'), ctrl.testEmail);
router.post('/send-report-now', authenticate, authorize('Admin'), ctrl.sendReportNow);

module.exports = router;