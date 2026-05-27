// backend/src/routes/feedback.js
// Quản lý góp ý — Admin/Manager.
// Đăng ký trong index.js:
//   app.use('/api/feedback',            require('./routes/feedback'));
//   app.use('/api/feedback-categories', require('./routes/feedbackCategories'));
//   app.use('/api/feedback-blocks',     require('./routes/feedbackBlocks'));
const router = require('express').Router();
const ctrl = require('../controllers/feedbackController');
const { authenticate, authorize } = require('../middleware/auth');

// Danh sách + chi tiết: lễ tân trở lên cũng xem được
router.get('/',     authenticate, ctrl.listFeedback);
router.get('/:id',  authenticate, ctrl.getFeedback);

// Cập nhật status / staffReply: Admin + Manager + Receptionist
router.patch('/:id', authenticate, authorize('Admin', 'Manager', 'Receptionist'), ctrl.updateFeedback);

// Xoá: chỉ Admin + Manager
router.delete('/:id', authenticate, authorize('Admin', 'Manager'), ctrl.deleteFeedback);

module.exports = router;