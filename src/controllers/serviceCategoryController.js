// src/controllers/serviceCategoryController.js
// CRUD cho ServiceCategory + endpoint copy-to-branch

const ServiceCategory = require('../models/ServiceCategory')
const Service         = require('../models/Service')
const { logAction }   = require('../utils/auditLogger')

// ── GET ALL ───────────────────────────────────────────
// Query: ?branchId=xxx (BẮT BUỘC) — list category của 1 chi nhánh
//        ?status=active|inactive — filter status
const getAll = async (req, res, next) => {
  try {
    const { branchId, status, search } = req.query
    if (!branchId) {
      return res.status(400).json({ success: false, message: 'Thiếu branchId' })
    }

    const filter = { branchId }
    if (status) filter.status = status
    if (search && search.trim()) {
      const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.name = re
    }

    const data = await ServiceCategory.find(filter)
      .sort({ sortOrder: 1, name: 1 })

    // Count service per category (cho UI hiển thị "X dịch vụ")
    const ids = data.map(c => c._id)
    const counts = await Service.aggregate([
      { $match: { categoryId: { $in: ids } } },
      { $group: { _id: '$categoryId', count: { $sum: 1 } } },
    ])
    const countMap = Object.fromEntries(counts.map(c => [String(c._id), c.count]))

    const result = data.map(c => ({
      ...c.toObject(),
      serviceCount: countMap[String(c._id)] ?? 0,
    }))

    res.json({ success: true, data: { data: result, total: result.length } })
  } catch (err) { next(err) }
}

// ── GET ONE ───────────────────────────────────────────
const getOne = async (req, res, next) => {
  try {
    const cat = await ServiceCategory.findById(req.params.id)
    if (!cat) return res.status(404).json({ success: false, message: 'Không tìm thấy danh mục' })
    res.json({ success: true, data: { category: cat } })
  } catch (err) { next(err) }
}

// ── CREATE ────────────────────────────────────────────
const create = async (req, res, next) => {
  try {
    const { name, icon = '📦', sortOrder = 0, branchId, status = 'active' } = req.body

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Tên danh mục bắt buộc' })
    }
    if (!branchId) {
      return res.status(400).json({ success: false, message: 'Thiếu branchId' })
    }

    // Check trùng (case-insensitive)
    const dup = await ServiceCategory.findOne({
      branchId,
      name: new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    })
    if (dup) {
      return res.status(400).json({
        success: false,
        code: 'DUPLICATE_CATEGORY',
        message: `Danh mục "${name}" đã tồn tại trong chi nhánh này`,
      })
    }

    const cat = await ServiceCategory.create({
      name:      name.trim(),
      icon:      icon.trim(),
      sortOrder: Number(sortOrder) || 0,
      branchId,
      status,
      createdBy: req.user?.id,
      updatedBy: req.user?.id,
    })

    await logAction({
      entityType: 'ServiceCategory', entityId: cat._id,
      action: 'create',
      description: `Tạo danh mục dịch vụ "${cat.name}" ${cat.icon}`,
      user: req.user, branchId,
      metadata: { name: cat.name, icon: cat.icon },
    })

    res.status(201).json({ success: true, message: 'Đã tạo danh mục', data: { category: cat } })
  } catch (err) {
    // Bắt duplicate key error
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        code: 'DUPLICATE_CATEGORY',
        message: 'Danh mục đã tồn tại',
      })
    }
    next(err)
  }
}

// ── UPDATE ────────────────────────────────────────────
const update = async (req, res, next) => {
  try {
    const cat = await ServiceCategory.findById(req.params.id)
    if (!cat) return res.status(404).json({ success: false, message: 'Không tìm thấy danh mục' })

    const allowed = ['name', 'icon', 'sortOrder', 'status']
    const payload = { updatedBy: req.user?.id }
    allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k] })

    if (payload.name !== undefined) {
      if (!payload.name.trim()) {
        return res.status(400).json({ success: false, message: 'Tên danh mục không được rỗng' })
      }
      payload.name = payload.name.trim()

      // Check trùng tên với category khác trong cùng branch
      const dup = await ServiceCategory.findOne({
        _id:      { $ne: cat._id },
        branchId: cat.branchId,
        name:     new RegExp(`^${payload.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      })
      if (dup) {
        return res.status(400).json({
          success: false,
          code: 'DUPLICATE_CATEGORY',
          message: `Danh mục "${payload.name}" đã tồn tại trong chi nhánh này`,
        })
      }
    }

    const oldName = cat.name
    Object.assign(cat, payload)
    await cat.save()

    // ⭐ Nếu đổi tên: cập nhật snapshot `category` (string) của các service đang dùng
    if (payload.name && payload.name !== oldName) {
      await Service.updateMany(
        { categoryId: cat._id },
        { $set: { category: payload.name } }
      )
    }

    await logAction({
      entityType: 'ServiceCategory', entityId: cat._id,
      action: 'update',
      description: `Cập nhật danh mục "${cat.name}"`,
      user: req.user, branchId: cat.branchId,
      metadata: { changedFields: Object.keys(payload).filter(k => k !== 'updatedBy'), payload },
    })

    res.json({ success: true, message: 'Đã cập nhật', data: { category: cat } })
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        code: 'DUPLICATE_CATEGORY',
        message: 'Danh mục đã tồn tại',
      })
    }
    next(err)
  }
}

// ── DELETE ────────────────────────────────────────────
// ⭐ Cho phép xóa luôn — service vẫn giữ snapshot category (string) để không mất giá/info
//   chỉ là categoryId của service bị set = null
const remove = async (req, res, next) => {
  try {
    const cat = await ServiceCategory.findById(req.params.id)
    if (!cat) return res.status(404).json({ success: false, message: 'Không tìm thấy danh mục' })

    // Set categoryId = null cho các service đang dùng (giữ snapshot category string)
    const updateResult = await Service.updateMany(
      { categoryId: cat._id },
      { $set: { categoryId: null } }
    )

    await cat.deleteOne()

    await logAction({
      entityType: 'ServiceCategory', entityId: cat._id,
      action: 'delete',
      description: `Xóa danh mục "${cat.name}" (${updateResult.modifiedCount} dịch vụ chuyển sang chưa phân loại nhưng vẫn giữ tên category "${cat.name}")`,
      user: req.user, branchId: cat.branchId,
      metadata: { name: cat.name, affectedServices: updateResult.modifiedCount },
    })

    res.json({
      success: true,
      message: `Đã xóa danh mục${updateResult.modifiedCount > 0 ? ` (${updateResult.modifiedCount} dịch vụ vẫn giữ tên danh mục này như snapshot)` : ''}`,
      data: { affectedServices: updateResult.modifiedCount },
    })
  } catch (err) { next(err) }
}

// ── COPY TO BRANCH ────────────────────────────────────
// POST /service-categories/:id/copy-to-branch
// Body: { targetBranchIds: [bid1, bid2, ...] }
// → Copy 1 category sang nhiều chi nhánh khác. Nếu trùng tên ở branch đích → skip
const copyToBranch = async (req, res, next) => {
  try {
    const { targetBranchIds } = req.body
    if (!Array.isArray(targetBranchIds) || targetBranchIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Cần ít nhất 1 chi nhánh đích' })
    }

    const source = await ServiceCategory.findById(req.params.id)
    if (!source) return res.status(404).json({ success: false, message: 'Không tìm thấy danh mục nguồn' })

    const results = []
    for (const bid of targetBranchIds) {
      if (String(bid) === String(source.branchId)) {
        results.push({ branchId: bid, success: false, reason: 'Trùng chi nhánh nguồn' })
        continue
      }
      try {
        const existing = await ServiceCategory.findOne({
          branchId: bid,
          name:     new RegExp(`^${source.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        })
        if (existing) {
          results.push({ branchId: bid, success: false, reason: 'Đã tồn tại tại chi nhánh đích' })
          continue
        }

        const copy = await ServiceCategory.create({
          name:      source.name,
          icon:      source.icon,
          sortOrder: source.sortOrder,
          status:    source.status,
          branchId:  bid,
          createdBy: req.user?.id,
          updatedBy: req.user?.id,
        })
        results.push({ branchId: bid, success: true, newCategoryId: copy._id })
      } catch (err) {
        results.push({ branchId: bid, success: false, reason: err.message })
      }
    }

    const ok = results.filter(r => r.success).length
    await logAction({
      entityType: 'ServiceCategory', entityId: source._id,
      action: 'copy_to_branch',
      description: `Copy danh mục "${source.name}" sang ${ok}/${targetBranchIds.length} chi nhánh`,
      user: req.user, branchId: source.branchId,
      metadata: { results, targetBranchIds },
    })

    res.json({
      success: true,
      message: `Đã copy sang ${ok}/${targetBranchIds.length} chi nhánh`,
      data: { results },
    })
  } catch (err) { next(err) }
}

module.exports = { getAll, getOne, create, update, remove, copyToBranch }