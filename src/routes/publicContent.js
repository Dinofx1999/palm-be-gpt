// backend/src/routes/publicContent.js — nội dung web khách hàng (KHÔNG AUTH)
// Mount: app.use('/api/public', require('./routes/publicContent'))
const router = require('express').Router();
const { publicList, publicDetail } = require('../controllers/newsController');
const { publicGet } = require('../controllers/siteConfigController');

// Tin tức
router.get('/news', publicList);
router.get('/news/:slug', publicDetail);

// Cấu hình web (hero + tiện nghi)
router.get('/site-config', publicGet);

module.exports = router;