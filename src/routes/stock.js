// backend/src/routes/stock.js
// Quản lý kho dịch vụ.
// Đăng ký trong index.js:
//   app.use('/api/stock', require('./routes/stock'));
const router = require('express').Router();
const ctrl = require('../controllers/stockController');
const { authenticate, authorize } = require('../middleware/auth');

// Nhập kho / điều chỉnh: Admin + Manager
router.post('/in',     authenticate, authorize('Admin', 'Manager'), ctrl.stockIn);
router.post('/adjust', authenticate, authorize('Admin', 'Manager'), ctrl.stockAdjust);

// Phiếu nhập kho (nhiều mặt hàng):
//   - Tạo (nháp): Admin + Manager + Receptionist (lễ tân tạo, quản lý duyệt)
//   - Duyệt / từ chối / huỷ duyệt: chỉ Admin + Manager
router.post('/receipts',     authenticate, authorize('Admin', 'Manager', 'Receptionist'), ctrl.createReceipt);
router.get('/receipts',      authenticate, ctrl.listReceipts);
router.get('/receipts/:id',  authenticate, ctrl.getReceipt);
router.post('/receipts/:id/approve', authenticate, authorize('Admin', 'Manager'), ctrl.approveReceipt);
router.post('/receipts/:id/reject',  authenticate, authorize('Admin', 'Manager'), ctrl.rejectReceipt);
router.post('/receipts/:id/cancel',  authenticate, authorize('Admin', 'Manager'), ctrl.cancelReceipt);

// Xem lịch sử + cảnh báo: cần đăng nhập
router.get('/movements', authenticate, ctrl.getMovements);
router.get('/low',       authenticate, ctrl.getLowStock);

module.exports = router;