const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const {
  create,
  getPublic,
  getAll,
  remove,
  getAlternativeRooms,
} = require('../controllers/quoteController');

// ⚠️ THỨ TỰ ROUTE QUAN TRỌNG:
// Routes cụ thể (static path) phải đặt TRƯỚC routes có :param
// Nếu không, Express sẽ match "alternative-rooms" như là ":id"

// ── PUBLIC routes (không cần auth) ─────────────
router.get('/public/:token', getPublic);

// ── PRIVATE routes — STATIC paths trước ────────
router.get('/alternative-rooms', authenticate, getAlternativeRooms);

// ── PRIVATE routes — :param paths sau ──────────
router.post('/',         authenticate, create);
router.get('/',          authenticate, getAll);
router.delete('/:id',    authenticate, remove);

module.exports = router;