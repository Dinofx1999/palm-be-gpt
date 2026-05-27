// backend/src/routes/feedbackBlocks.js
const router = require('express').Router();
const ctrl = require('../controllers/feedbackController');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/',       authenticate,                                ctrl.listBlocks);
router.post('/',      authenticate, authorize('Admin', 'Manager'), ctrl.createBlock);
router.delete('/:id', authenticate, authorize('Admin', 'Manager'), ctrl.deleteBlock);

module.exports = router;