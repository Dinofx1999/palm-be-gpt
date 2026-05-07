const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const {
  create,
  getPublic,
  getAll,
  remove,
  getAlternativeRooms,
  changeStatus,
  publicAccept,   // ⭐ NEW
} = require('../controllers/quoteController');

// ⚠️ THỨ TỰ ROUTE QUAN TRỌNG:
// Routes cụ thể (static path) phải đặt TRƯỚC routes có :param

// ── PUBLIC routes (không cần auth) ─────────────
router.get('/public/:token', getPublic);
router.post('/public-accept/:token', publicAccept);   // ⭐ NEW: khách tự accept

// ── PRIVATE routes — STATIC paths trước ────────
router.get('/alternative-rooms', authenticate, getAlternativeRooms);

// ── PRIVATE routes — :param paths sau ──────────
router.post('/',                    authenticate, create);
router.get('/',                     authenticate, getAll);
router.patch('/:id/status',         authenticate, changeStatus);
router.delete('/:id',               authenticate, remove);

module.exports = router;