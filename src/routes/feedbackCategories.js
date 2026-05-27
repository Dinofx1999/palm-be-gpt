// backend/src/routes/feedbackCategories.js
const router = require('express').Router();
const ctrl = require('../controllers/feedbackController');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/',         authenticate,                                ctrl.listCategories);
router.post('/',        authenticate, authorize('Admin', 'Manager'), ctrl.createCategory);
router.put('/:id',      authenticate, authorize('Admin', 'Manager'), ctrl.updateCategory);
router.delete('/:id',   authenticate, authorize('Admin', 'Manager'), ctrl.deleteCategory);

module.exports = router;