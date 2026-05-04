const router = require('express').Router();
const { getAll, getOne, create, update, toggle, remove } = require('../controllers/branchController');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/',           authenticate,                        getAll);
router.get('/:id',        authenticate,                        getOne);
router.post('/',          authenticate, authorize('Admin', 'Manager'), create);
router.put('/:id',        authenticate, authorize('Admin', 'Manager'), update);
router.patch('/:id/toggle', authenticate, authorize('Admin'),          toggle);
router.delete('/:id',     authenticate, authorize('Admin'),            remove);

module.exports = router;