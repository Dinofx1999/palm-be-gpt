// backend/src/routes/publicFeedback.js
// Endpoint PUBLIC cho khách gửi góp ý (không cần đăng nhập).
// Đăng ký:
//   app.use('/api/public/feedback', require('./routes/publicFeedback'));
const router = require('express').Router();
const ctrl = require('../controllers/feedbackController');

router.get('/categories', ctrl.getPublicCategories);
router.post('/submit',    ctrl.submitFeedback);

module.exports = router;