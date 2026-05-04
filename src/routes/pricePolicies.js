const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  getAll, getOne, create, update, toggle, remove, lookup, reorder,
} = require('../controllers/pricePolicyController');

router.get('/lookup',        authenticate, lookup);               // tìm giá booking

// ⭐ Đặt route reorder TRƯỚC :id để tránh conflict (bulk update displayOrder)
router.patch('/reorder',     authenticate, authorize('Admin', 'Manager'), reorder);

router.get('/',              authenticate, getAll);
router.get('/:id',           authenticate, getOne);
router.post('/',             authenticate, authorize('Admin', 'Manager'), create);
router.put('/:id',           authenticate, authorize('Admin', 'Manager'), update);
router.patch('/:id/toggle',  authenticate, authorize('Admin', 'Manager'), toggle);
router.delete('/:id',        authenticate, authorize('Admin'), remove);

module.exports = router;