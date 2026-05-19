const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const {
  getAll, getOne, create, update,
  previewPrice, changeDates, changeDatesRoom, moveRoom,
  checkin, checkout, cancel, undo, getAvailableByDate,
  applyDiscount,
  calculateBill,
  changePolicy,
  createGroup,
  getAvailableByType,
  previewGroup,
  checkinRoom,         // ⭐ NEW
  checkoutRoom,        // ⭐ NEW
  undoRoom,            // ⭐ NEW: undo 1 phòng trong đoàn
  getCanSetPast,       // ⭐ NEW: check quyền set giờ trả phòng quá khứ
  mergeGroup,          // ⭐ NEW 11/05/2026: Gộp đoàn
  splitRoom,           // ⭐ NEW 11/05/2026: Tách đoàn
  getMergeCandidates,  // ⭐ NEW 11/05/2026: List booking có thể gộp
} = require('../controllers/bookingController');

router.get('/available-rooms',     authenticate, getAvailableByDate);
router.get('/available-by-type',   authenticate, getAvailableByType);
router.get('/',                    authenticate, getAll);

// ⭐ NEW: Đặt TRƯỚC '/:id' để tránh conflict với getOne
router.get('/:id/can-set-past',      authenticate, getCanSetPast);
router.get('/:id/merge-candidates',  authenticate, getMergeCandidates);   // ⭐ NEW 11/05/2026

router.get('/:id',                 authenticate, getOne);
router.post('/preview-price',      authenticate, previewPrice);
router.post('/preview-group',      authenticate, previewGroup);
router.post('/:id/calculate-bill', authenticate, calculateBill);
router.post('/group',              authenticate, createGroup);
router.post('/',                   authenticate, create);

// ⭐ NEW 11/05/2026: Gộp đoàn / Tách đoàn
router.post('/:id/merge-group',    authenticate, mergeGroup);
router.post('/:id/split-room',     authenticate, splitRoom);

router.put('/:id',                 authenticate, update);
router.patch('/:id/discount',      authenticate, applyDiscount);
router.patch('/:id/change-policy', authenticate, changePolicy);
router.patch('/:id/change-dates',       authenticate, changeDates);
router.patch('/:id/change-dates-room',  authenticate, changeDatesRoom);   // ⭐ NEW: đổi ngày 1 phòng trong đoàn
router.patch('/:id/move-room',          authenticate, moveRoom);
router.patch('/:id/checkin',       authenticate, checkin);          // toàn bộ đoàn
router.patch('/:id/checkin-room',  authenticate, checkinRoom);      // ⭐ NEW: 1 phòng
router.patch('/:id/checkout',      authenticate, checkout);         // toàn bộ đoàn
router.patch('/:id/checkout-room', authenticate, checkoutRoom);     // ⭐ NEW: 1 phòng
router.patch('/:id/cancel',        authenticate, cancel);
router.patch('/:id/undo',          authenticate, authorize('Admin', 'Manager'), undo);
router.patch('/:id/undo-room',     authenticate, authorize('Admin', 'Manager'), undoRoom);   // ⭐ NEW: undo 1 phòng trong đoàn
module.exports = router;