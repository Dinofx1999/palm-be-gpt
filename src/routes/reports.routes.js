// ════════════════════════════════════════════════════════════════════════════
// ROUTES — thêm vào src/routes/reports.routes.js (hoặc tạo mới)
// ════════════════════════════════════════════════════════════════════════════
//
const express = require('express')
const router = express.Router()
const { authenticate } = require('../middlewares/auth')
const { getStaffDiscountCharges } = require('../controllers/staffDiscountReport.controller')

// Yêu cầu role admin hoặc manager mới được xem báo cáo
router.get('/staff-discount-charges',
  authenticate,
  // optional: thêm middleware requireRole(['admin', 'manager'])
  getStaffDiscountCharges,
)

module.exports = router

// Trong app.js:
  app.use('/reports', require('./routes/reports.routes'))