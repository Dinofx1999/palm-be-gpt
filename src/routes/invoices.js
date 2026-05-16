// backend/src/routes/invoices.js
//
// ⭐ UPDATED 15/05/2026: Thêm 3 routes cho sửa/xoá phiếu thanh toán
//
const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const {
  getAll, getOne, getOrCreateForBooking, addPayment, update,
  // ⭐ NEW 15/05
  editPayment, deletePayment, getPaymentHistory,
} = require('../controllers/invoiceController');

router.get('/',                      authenticate, getAll);
router.get('/by-booking/:bookingId', authenticate, getOrCreateForBooking);   // ⭐ FE gọi đây
router.get('/:id',                   authenticate, getOne);
router.post('/:id/payment',          authenticate, addPayment);
router.put('/:id',                   authenticate, update);

// ⭐ NEW 15/05/2026: Sửa/Xoá phiếu thanh toán + xem lịch sử sửa đổi
//   Lưu ý: dùng số NHIỀU `payments` cho consistent với REST convention
//   (route cũ `/payment` để add, route mới `/payments/:paymentId` để edit/delete/history)
router.put('/:id/payments/:paymentId',           authenticate, editPayment);
router.delete('/:id/payments/:paymentId',        authenticate, deletePayment);
router.get('/:id/payments/:paymentId/history',   authenticate, getPaymentHistory);

module.exports = router;