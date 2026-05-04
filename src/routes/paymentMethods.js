const router = require('express').Router();
const { getAll, create, update, toggle, remove } = require('../controllers/paymentMethodController');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/',              authenticate,                              getAll);
router.post('/',             authenticate, authorize('Admin', 'Manager'), create);
router.put('/:id',           authenticate, authorize('Admin', 'Manager'), update);
router.patch('/:id/toggle',  authenticate, authorize('Admin', 'Manager'), toggle);
router.delete('/:id',        authenticate, authorize('Admin'),            remove);

module.exports = router;