const router = require('express').Router();
const { getAll, getOne, create, update, remove } = require('../controllers/roomTypeController');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/',                                  getAll);
router.get('/:id',                               getOne);

// router.get('/',      authenticate,                              getAll);
// router.get('/:id',   authenticate,                              getOne);
router.post('/',     authenticate, authorize('Admin', 'Manager'), create);
router.put('/:id',   authenticate, authorize('Admin', 'Manager'), update);
router.delete('/:id',authenticate, authorize('Admin'),            remove);

module.exports = router;