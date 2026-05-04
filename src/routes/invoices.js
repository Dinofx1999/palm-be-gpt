const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const {
  getAll, getOne, getOrCreateForBooking, addPayment, update,
} = require('../controllers/invoiceController');

router.get('/',                      authenticate, getAll);
router.get('/by-booking/:bookingId', authenticate, getOrCreateForBooking);   // ⭐ FE gọi đây
router.get('/:id',                   authenticate, getOne);
router.post('/:id/payment',          authenticate, addPayment);
router.put('/:id',                   authenticate, update);

module.exports = router;