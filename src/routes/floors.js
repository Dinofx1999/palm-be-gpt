const router = require('express').Router();
const { getAll, create, update, remove } = require('../controllers/floorController');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/',       authenticate,                              getAll);
router.post('/',      authenticate, authorize('Admin', 'Manager'), create);
router.put('/:id',    authenticate, authorize('Admin', 'Manager'), update);
router.delete('/:id', authenticate, authorize('Admin'),            remove);

module.exports = router;