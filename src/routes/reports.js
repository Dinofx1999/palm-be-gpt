// ════════════════════════════════════════════════════════════════════════════
// reports.js — Routes cho các báo cáo
// ════════════════════════════════════════════════════════════════════════════
// Mount tại src/index.js:
//   app.use('/api/reports', require('./routes/reports'));
// ════════════════════════════════════════════════════════════════════════════

const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getStaffDiscountCharges } = require('../controllers/staffDiscountReport.controller');

// GET /api/reports/staff-discount-charges
// Query: branchId (required), from, to, staffId (optional)
router.get('/staff-discount-charges', authenticate, getStaffDiscountCharges);

module.exports = router;