const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const ctrl = require('../controllers/userController');

router.get('/',                     authenticate, authorize('Admin', 'Manager'), ctrl.getAll);
router.get('/:id',                  authenticate, authorize('Admin', 'Manager'), ctrl.getOne);
router.post('/',                    authenticate, authorize('Admin'),            ctrl.create);
router.put('/:id',                  authenticate, authorize('Admin', 'Manager'), ctrl.update);
router.patch('/:id/toggle',         authenticate, authorize('Admin'),            ctrl.toggle);
router.patch('/:id/reset-password', authenticate, authorize('Admin'),            ctrl.resetPassword);
router.delete('/:id',               authenticate, authorize('Admin'),            ctrl.remove);  // ← thêm

module.exports = router;