// backend/src/routes/news.js — quản lý tin tức (cần auth)
const router = require('express').Router();
const { getAll, getOne, create, update, remove } = require('../controllers/newsController');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/',     authenticate,                                  getAll);
router.get('/:id',  authenticate,                                  getOne);
router.post('/',    authenticate, authorize('Admin', 'Manager'),   create);
router.put('/:id',  authenticate, authorize('Admin', 'Manager'),   update);
router.delete('/:id', authenticate, authorize('Admin', 'Manager'), remove);

module.exports = router;