// src/routes/serviceCategoryRoutes.js
const express = require('express')
const ctrl    = require('../controllers/serviceCategoryController')
// const { authenticate } = require('../middleware/auth')   // ⭐ uncomment nếu app có middleware auth

const router = express.Router()

// router.use(authenticate)   // ⭐ uncomment nếu cần auth

router.get('/',          ctrl.getAll)
router.get('/:id',       ctrl.getOne)
router.post('/',         ctrl.create)
router.put('/:id',       ctrl.update)
router.delete('/:id',    ctrl.remove)
router.post('/:id/copy-to-branch', ctrl.copyToBranch)

module.exports = router