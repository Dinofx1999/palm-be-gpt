const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  getAll, getOne, create, update, remove,
  addToBooking, getByBooking, removeFromBooking, updateBookingService,
} = require('../controllers/serviceController');

// ── BookingService operations (đặt TRƯỚC route động /:id) ──
router.post('/add-to-booking',             authenticate, addToBooking);
router.get('/by-booking/:bookingId',       authenticate, getByBooking);
router.delete('/booking-service/:id',      authenticate, removeFromBooking);
router.patch('/booking-service/:id',       authenticate, updateBookingService);

// ── CRUD Service ──
router.get('/',         authenticate, getAll);
router.get('/:id',      authenticate, getOne);
router.post('/',        authenticate, authorize('Admin', 'Manager'), create);
router.put('/:id',      authenticate, authorize('Admin', 'Manager'), update);
router.delete('/:id',   authenticate, authorize('Admin', 'Manager'), remove);

module.exports = router;