const Service        = require('../models/Service');
const BookingService = require('../models/BookingService');
const Booking        = require('../models/Booking');
const { logAction }  = require('../utils/auditLogger');

// ── GET ALL SERVICES ──
const getAll = async (req, res, next) => {
  try {
    const { status, branchId, category, search } = req.query
    const filter = {}
    if (status)   filter.status   = status
    if (branchId) filter.branchId = branchId
    if (category && category !== 'all') filter.category = category
    if (search && search.trim()) {
      const q = search.trim()
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ name: re }, { category: re }, { unit: re }]
    }
    const data = await Service.find(filter).sort({ name: 1 })
    res.json({ success: true, data: { data, total: data.length } })
  } catch (err) { next(err) }
}

// ⭐ NEW: GET ONE
const getOne = async (req, res, next) => {
  try {
    const service = await Service.findById(req.params.id)
    if (!service) return res.status(404).json({ success: false, message: 'Không tìm thấy dịch vụ' })
    res.json({ success: true, data: { service } })
  } catch (err) { next(err) }
}

// ⭐ NEW: CREATE
const create = async (req, res, next) => {
  try {
    const { name, category = 'Khác', price, unit = 'lần', description = '', status = 'active', branchId } = req.body
    if (!name || !name.trim())
      return res.status(400).json({ success: false, message: 'Tên dịch vụ bắt buộc' })
    if (price === undefined || price === null || isNaN(Number(price)) || Number(price) < 0)
      return res.status(400).json({ success: false, message: 'Đơn giá không hợp lệ' })

    // Check trùng tên (case-insensitive) trong cùng branch (nếu có)
    const dupFilter = { name: new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    if (branchId) dupFilter.branchId = branchId
    const dup = await Service.findOne(dupFilter)
    if (dup) return res.status(400).json({ success: false, message: `Dịch vụ "${name}" đã tồn tại` })

    const service = await Service.create({
      name:     name.trim(),
      category: category.trim(),
      price:    Number(price),
      unit:     unit.trim(),
      description, status,
      branchId: branchId ?? null,
      createdBy: req.user?.id,
      updatedBy: req.user?.id,
    })

    await logAction({
      entityType: 'Service', entityId: service._id,
      action: 'create',
      description: `Tạo dịch vụ "${service.name}" — ${(service.price ?? 0).toLocaleString('vi-VN')}đ/${service.unit}`,
      user: req.user,
      metadata: { name: service.name, price: service.price, category: service.category },
    })

    res.status(201).json({ success: true, message: 'Đã tạo dịch vụ', data: { service } })
  } catch (err) { next(err) }
}

// ⭐ NEW: UPDATE
const update = async (req, res, next) => {
  try {
    const allowed = ['name', 'category', 'price', 'unit', 'description', 'status', 'branchId']
    const payload = { updatedBy: req.user?.id }
    allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k] })

    if (payload.name !== undefined) {
      if (!payload.name.trim())
        return res.status(400).json({ success: false, message: 'Tên dịch vụ không được rỗng' })
      payload.name = payload.name.trim()
    }
    if (payload.price !== undefined) {
      if (isNaN(Number(payload.price)) || Number(payload.price) < 0)
        return res.status(400).json({ success: false, message: 'Đơn giá không hợp lệ' })
      payload.price = Number(payload.price)
    }

    const service = await Service.findByIdAndUpdate(req.params.id, payload, { new: true })
    if (!service) return res.status(404).json({ success: false, message: 'Không tìm thấy dịch vụ' })

    await logAction({
      entityType: 'Service', entityId: service._id,
      action: 'update',
      description: `Cập nhật dịch vụ "${service.name}"`,
      user: req.user,
      metadata: { changedFields: Object.keys(payload).filter(k => k !== 'updatedBy'), payload },
    })

    res.json({ success: true, message: 'Đã cập nhật', data: { service } })
  } catch (err) { next(err) }
}

// ⭐ NEW: DELETE
// Quy tắc: nếu DV đã được dùng trong booking nào → không cho xoá, gợi ý "Tạm dừng"
const remove = async (req, res, next) => {
  try {
    const used = await BookingService.countDocuments({ serviceId: req.params.id })
    if (used > 0) {
      return res.status(400).json({
        success: false,
        message: `Không thể xoá: dịch vụ này đã được dùng trong ${used} đặt phòng. Hãy "Tạm dừng" thay vì xoá.`,
      })
    }
    const service = await Service.findByIdAndDelete(req.params.id)
    if (!service) return res.status(404).json({ success: false, message: 'Không tìm thấy dịch vụ' })

    await logAction({
      entityType: 'Service', entityId: service._id,
      action: 'delete',
      description: `Xoá dịch vụ "${service.name}"`,
      user: req.user,
      metadata: { name: service.name, price: service.price },
    })

    res.json({ success: true, message: 'Đã xoá dịch vụ' })
  } catch (err) { next(err) }
}

// ── ADD SERVICE TO BOOKING ──
// ⭐ Helper: Sync servicesAmount + totalAmount của booking và sub-room (nếu có)
//   Tính lại từ tất cả BookingService liên quan
async function syncBookingAfterServiceChange(bookingId) {
  const booking = await Booking.findById(bookingId)
  if (!booking) return null

  const allServices = await BookingService.find({ bookingId })

  // Tổng dịch vụ toàn booking
  const servicesAmount = allServices.reduce((s, x) => s + (x.totalPrice ?? 0), 0)
  booking.servicesAmount = servicesAmount

  // ⭐ Tổng dịch vụ PER-ROOM (chỉ tính subRoomId match)
  if (Array.isArray(booking.rooms) && booking.rooms.length > 0) {
    for (const sr of booking.rooms) {
      const srSubId = String(sr.roomId?._id ?? sr.roomId)
      const subServicesAmount = allServices
        .filter(x => x.subRoomId && String(x.subRoomId) === srSubId)
        .reduce((s, x) => s + (x.totalPrice ?? 0), 0)
      sr.servicesAmount = subServicesAmount
    }
  }

  booking.totalAmount = (booking.roomAmount ?? 0) + servicesAmount - (booking.discount ?? 0) + (booking.transferFee ?? 0)
  await booking.save()

  // Đồng bộ Invoice
  const Invoice = require('../models/Invoice')
  const invoice = await Invoice.findOne({ bookingId })
  if (invoice) {
    invoice.servicesAmount  = servicesAmount
    invoice.totalAmount     = booking.totalAmount
    invoice.remainingAmount = Math.max(0, invoice.totalAmount - (invoice.paidAmount ?? 0))
    invoice.paymentStatus   = invoice.paidAmount >= invoice.totalAmount ? 'paid' :
                              invoice.paidAmount > 0 ? 'partial' : 'unpaid'
    await invoice.save()
  }

  return booking
}

const addToBooking = async (req, res, next) => {
  try {
    // ⭐ NEW: subRoomId = roomId của phòng cụ thể (mode single-in-group)
    //   Nếu không truyền → dịch vụ thuộc về booking chung (booking đơn hoặc dịch vụ chung của đoàn)
    const { bookingId, serviceId, quantity = 1, notes = '', subRoomId = null } = req.body
    if (!bookingId || !serviceId)
      return res.status(400).json({ success: false, message: 'Thiếu bookingId hoặc serviceId' })

    const booking = await Booking.findById(bookingId)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy booking' })

    const service = await Service.findById(serviceId)
    if (!service) return res.status(404).json({ success: false, message: 'Không tìm thấy dịch vụ' })

    const qty = Math.max(1, Number(quantity) || 1)
    const totalPrice = (service.price ?? 0) * qty

    // ⭐ Validate subRoomId nếu có — phải thuộc booking.rooms
    let subRoomNumber = ''
    if (subRoomId) {
      const sr = (booking.rooms ?? []).find(r => String(r.roomId?._id ?? r.roomId) === String(subRoomId))
      if (!sr) {
        return res.status(400).json({ success: false, message: 'Phòng không thuộc booking này' })
      }
      subRoomNumber = sr.roomNumber ?? ''
    }

    const bs = await BookingService.create({
      bookingId, serviceId,
      subRoomId,
      subRoomNumber,
      serviceName: service.name,
      unit:        service.unit ?? '',
      unitPrice:   service.price ?? 0,
      quantity:    qty,
      totalPrice,
      notes,
      addedBy:     req.user?.id,
    })

    await syncBookingAfterServiceChange(bookingId)

    // Mô tả audit
    const roomLabel = subRoomNumber ? `phòng ${subRoomNumber}` : `phòng ${booking.roomNumber}`
    await logAction({
      entityType: 'Booking', entityId: bookingId,
      action: 'add_service',
      description: `Thêm dịch vụ "${service.name}" × ${qty} = ${totalPrice.toLocaleString('vi-VN')}đ vào ${roomLabel}`,
      user: req.user, branchId: booking.branchId,
      metadata: { serviceName: service.name, quantity: qty, totalPrice, bookingServiceId: bs._id, subRoomId, subRoomNumber },
    })

    res.status(201).json({ success: true, message: 'Đã thêm dịch vụ', data: { bookingService: bs } })
  } catch (err) { next(err) }
}

// ⭐ GET dịch vụ của 1 booking — hỗ trợ filter theo subRoomId
//   Query: ?subRoomId=xxx (chỉ dịch vụ phòng đó)
//          ?subRoomId=null (chỉ dịch vụ chung — chưa gắn phòng nào)
//          (không truyền) → tất cả
const getByBooking = async (req, res, next) => {
  try {
    const filter = { bookingId: req.params.bookingId }
    const { subRoomId } = req.query
    if (subRoomId !== undefined) {
      if (subRoomId === 'null' || subRoomId === '') {
        filter.subRoomId = null
      } else {
        filter.subRoomId = subRoomId
      }
    }

    const list = await BookingService.find(filter).sort({ addedAt: 1 })
    res.json({ success: true, data: { data: list, total: list.length } })
  } catch (err) { next(err) }
}

// REMOVE dịch vụ khỏi booking
const removeFromBooking = async (req, res, next) => {
  try {
    const bs = await BookingService.findById(req.params.id)
    if (!bs) return res.status(404).json({ success: false, message: 'Không tìm thấy dịch vụ' })

    const bookingId = bs.bookingId
    const subRoomNumber = bs.subRoomNumber
    await bs.deleteOne()

    const booking = await syncBookingAfterServiceChange(bookingId)

    if (booking) {
      const roomLabel = subRoomNumber ? `phòng ${subRoomNumber}` : `phòng ${booking.roomNumber}`
      await logAction({
        entityType: 'Booking', entityId: bookingId,
        action: 'remove_service',
        description: `Xoá dịch vụ "${bs.serviceName}" × ${bs.quantity} khỏi ${roomLabel}`,
        user: req.user, branchId: booking.branchId,
        metadata: { serviceName: bs.serviceName, quantity: bs.quantity, totalPrice: bs.totalPrice, subRoomId: bs.subRoomId, subRoomNumber },
      })
    }

    res.json({ success: true, message: 'Đã xoá dịch vụ' })
  } catch (err) { next(err) }
}

// UPDATE quantity của dịch vụ
const updateBookingService = async (req, res, next) => {
  try {
    const { quantity, notes } = req.body
    const bs = await BookingService.findById(req.params.id)
    if (!bs) return res.status(404).json({ success: false, message: 'Không tìm thấy dịch vụ' })

    if (quantity !== undefined) {
      bs.quantity = Math.max(1, Number(quantity) || 1)
      bs.totalPrice = bs.unitPrice * bs.quantity
    }
    if (notes !== undefined) bs.notes = notes
    await bs.save()

    const booking = await syncBookingAfterServiceChange(bs.bookingId)

    if (booking) {
      const roomLabel = bs.subRoomNumber ? `phòng ${bs.subRoomNumber}` : `phòng ${booking.roomNumber}`
      await logAction({
        entityType: 'Booking', entityId: bs.bookingId,
        action: 'update_service_qty',
        description: `Cập nhật dịch vụ "${bs.serviceName}" tại ${roomLabel} → SL ${bs.quantity} = ${bs.totalPrice.toLocaleString('vi-VN')}đ`,
        user: req.user, branchId: booking.branchId,
        metadata: { serviceName: bs.serviceName, quantity: bs.quantity, totalPrice: bs.totalPrice, subRoomId: bs.subRoomId, subRoomNumber: bs.subRoomNumber },
      })
    }

    res.json({ success: true, message: 'Đã cập nhật', data: { bookingService: bs } })
  } catch (err) { next(err) }
}

module.exports = {
  // CRUD Service
  getAll, getOne, create, update, remove,
  // BookingService operations
  addToBooking, getByBooking, removeFromBooking, updateBookingService,
}