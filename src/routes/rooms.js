const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  getAll, getOne, getAvailable,
  create, update, updateStatus, remove,
} = require('../controllers/roomController');

router.get('/available',     authenticate, getAvailable);
router.get('/',              authenticate, getAll);
router.get('/:id',           authenticate, getOne);
router.post('/',             authenticate, authorize('Admin', 'Manager'), create);
router.put('/:id',           authenticate, update);
router.patch('/:id/status',  authenticate, updateStatus);
router.delete('/:id',        authenticate, authorize('Admin'), remove);

module.exports = router;