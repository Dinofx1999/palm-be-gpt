const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getAll, getRecent, getByBooking } = require('../controllers/auditLogController');

router.get('/recent',                  authenticate, getRecent);
// ⭐ NEW: log của 1 booking (gồm Booking + Invoice + Service liên quan)
router.get('/by-booking/:bookingId',   authenticate, getByBooking);
router.get('/',                        authenticate, getAll);

module.exports = router;