// backend/src/routes/salaryAdvanceRoutes.js
//
// ⭐ NEW 11/05/2026: Routes lương ứng
//
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/salaryAdvanceController');
const { authenticate } = require('../middleware/auth');

// GET list ứng theo NV/tháng
router.get('/by-user/:userId',       authenticate, ctrl.getByUser);

// GET info giới hạn ứng (max %, đã ứng, còn lại)
router.get('/by-user/:userId/limit', authenticate, ctrl.getLimit);

// CRUD — Admin/Manager only (controller tự check permission)
router.post('/',      authenticate, ctrl.create);
router.delete('/:id', authenticate, ctrl.remove);
router.patch('/:id',  authenticate, ctrl.update);

module.exports = router;