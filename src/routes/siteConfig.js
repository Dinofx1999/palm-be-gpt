// backend/src/routes/siteConfig.js — cấu hình web (cần auth)
const router = require('express').Router();
const { getConfig, updateConfig } = require('../controllers/siteConfigController');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/',  authenticate,                                getConfig);
router.put('/',  authenticate, authorize('Admin', 'Manager'), updateConfig);

module.exports = router;