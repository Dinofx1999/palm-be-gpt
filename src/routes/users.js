const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const ctrl = require('../controllers/userController');

// ─────────────────────────────────────────────────────────────
// ⭐ NEW: HỒ SƠ CÁ NHÂN — user thao tác với chính mình
//   ⚠️ PHẢI đặt TRƯỚC các route '/:id' bên dưới, nếu không Express
//      sẽ match 'me' như một :id và gọi nhầm getOne/update.
//   Chỉ cần authenticate (KHÔNG authorize) vì ai cũng sửa được hồ sơ mình.
// ─────────────────────────────────────────────────────────────
router.get('/me',                   authenticate, ctrl.getMe);
router.patch('/me',                 authenticate, ctrl.updateMe);
router.post('/me/change-password',  authenticate, ctrl.changeMyPassword);

// ── Quản trị (Admin/Manager) ──
router.get('/',                     authenticate, authorize('Admin', 'Manager'), ctrl.getAll);
router.get('/:id',                  authenticate, authorize('Admin', 'Manager'), ctrl.getOne);
router.post('/',                    authenticate, authorize('Admin'),            ctrl.create);
router.put('/:id',                  authenticate, authorize('Admin', 'Manager'), ctrl.update);
router.patch('/:id/toggle',         authenticate, authorize('Admin'),            ctrl.toggle);
router.patch('/:id/reset-password', authenticate, authorize('Admin'),            ctrl.resetPassword);
router.delete('/:id',               authenticate, authorize('Admin'),            ctrl.remove);

module.exports = router;