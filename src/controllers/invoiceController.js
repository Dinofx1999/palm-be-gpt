const Invoice = require('../models/Invoice');
const Booking = require('../models/Booking');
const User    = require('../models/User');

let logAction = async () => {};
try {
  logAction = require('../utils/auditLogger').logAction;
} catch (e) {
  console.warn('[invoiceController] auditLogger not found — skipping audit logs');
}

// ⭐ NEW: Helper compute totals từ booking (xử lý cả single + group)
//   Group booking: tổng từ booking.rooms[] (chỉ active rooms, bỏ cancelled)
//   Single booking: dùng booking.roomAmount/servicesAmount/discount cấp top
//   Trả về: { roomAmount, servicesAmount, discount, totalAmount, items, roomNumber, isGroup, activeRooms }
const computeBookingTotals = (booking) => {
  const isGroup = Array.isArray(booking.rooms) && booking.rooms.length > 0
  if (!isGroup) {
    // Single booking
    const safeNights = Math.max(1, Number(booking.nights) || 1)
    const roomAmount = Number(booking.roomAmount) || 0
    const servicesAmount = Number(booking.servicesAmount) || 0
    const discount = Number(booking.discount) || 0
    const totalAmount = Math.max(0, roomAmount + servicesAmount - discount)

    return {
      roomAmount, servicesAmount, discount, totalAmount,
      items: [{
        description: `Phòng ${booking.roomNumber || '?'} – ${booking.roomType || 'Phòng'} × ${safeNights} đêm`,
        quantity:    safeNights,
        unitPrice:   Math.round(roomAmount / safeNights) || 0,
        amount:      roomAmount,
      }],
      roomNumber: booking.roomNumber || '',
      isGroup: false,
      activeRooms: [],
    }
  }

  // ⭐ Group booking: tính tổng từ booking.rooms[] — KHÔNG dùng booking.roomAmount cấp top
  //   Bỏ qua phòng cancelled
  const activeRooms = booking.rooms.filter(r => r.status !== 'cancelled')

  let roomAmount = 0
  let servicesAmount = 0
  let discount = 0
  const items = []

  for (const sr of activeRooms) {
    const subRoom = Number(sr.roomAmount) || 0
    const subServ = Number(sr.servicesAmount) || 0
    const subDisc = Number(sr.discountAmount) || 0
    const subNights = Math.max(1, Number(sr.nights) || Number(booking.nights) || 1)

    roomAmount += subRoom
    servicesAmount += subServ
    discount += subDisc

    items.push({
      description: `Phòng ${sr.roomNumber || '?'} – ${sr.roomType || 'Phòng'} × ${subNights} đêm`,
      quantity:    subNights,
      unitPrice:   Math.round(subRoom / subNights) || 0,
      amount:      subRoom,
    })

    // Nếu phòng có dịch vụ — thêm line riêng
    if (subServ > 0) {
      items.push({
        description: `Dịch vụ phòng ${sr.roomNumber || '?'}`,
        quantity:    1,
        unitPrice:   subServ,
        amount:      subServ,
      })
    }
  }

  // Cộng thêm dịch vụ + discount cấp top (nếu có — cho group dùng chung)
  servicesAmount += Number(booking.servicesAmount) || 0
  if (Number(booking.servicesAmount) > 0) {
    items.push({
      description: 'Dịch vụ chung của đoàn',
      quantity:    1,
      unitPrice:   Number(booking.servicesAmount),
      amount:      Number(booking.servicesAmount),
    })
  }

  // Discount cấp booking (chiết khấu chung)
  discount += Number(booking.discount) || 0

  const totalAmount = Math.max(0, roomAmount + servicesAmount - discount)

  // Room number cho hiển thị: nếu đoàn → ghép "203, 204, 401"
  const roomNumber = activeRooms.map(r => r.roomNumber).filter(Boolean).join(', ')

  return {
    roomAmount, servicesAmount, discount, totalAmount,
    items, roomNumber, isGroup: true, activeRooms,
  }
}

const allocatePaymentToRoomsHelper = (booking, amount, targetRoomId = null) => {
  if (!Array.isArray(booking.rooms) || booking.rooms.length === 0) {
    return { allocations: [], remaining: amount }
  }

  const subRemaining = (sr) => {
    const total = (sr.roomAmount ?? 0) + (sr.servicesAmount ?? 0) - (sr.discountAmount ?? 0)
    return Math.max(0, total - (sr.paidAmount ?? 0))
  }

  const ordered = []
  if (targetRoomId) {
    const targetIdx = booking.rooms.findIndex(sr =>
      String(sr.roomId?._id ?? sr.roomId) === String(targetRoomId)
    )
    if (targetIdx >= 0) ordered.push(targetIdx)
  }
  for (let i = 0; i < booking.rooms.length; i++) {
    if (!ordered.includes(i)) ordered.push(i)
  }

  let remaining = amount
  const allocations = []

  for (const idx of ordered) {
    if (remaining <= 0) break
    const sr = booking.rooms[idx]
    if (sr.status === 'cancelled') continue

    const need = subRemaining(sr)
    if (need <= 0) continue

    const allocate = Math.min(need, remaining)
    sr.paidAmount = (sr.paidAmount ?? 0) + allocate
    remaining -= allocate

    allocations.push({
      roomId:     String(sr.roomId?._id ?? sr.roomId),
      roomNumber: sr.roomNumber,
      amount:     allocate,
    })
  }

  return { allocations, remaining }
}

const safe = (fn, label) => async (req, res, next) => {
  try {
    await fn(req, res, next)
  } catch (err) {
    console.error('═══════════════════════════════════════════════')
    console.error(`[${label}] ERROR caught in safe wrapper:`)
    console.error('  URL:    ', req.method, req.originalUrl)
    console.error('  Message:', err.message)
    console.error('  Name:   ', err.name)
    if (err.code)   console.error('  Code:   ', err.code)
    if (err.errors) console.error('  Errors: ', JSON.stringify(err.errors, null, 2))
    console.error('  Stack:  ', err.stack)
    console.error('═══════════════════════════════════════════════')

    if (res.headersSent) return

    if (err.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Dữ liệu không hợp lệ',
        errors: Object.fromEntries(
          Object.entries(err.errors || {}).map(([k, v]) => [k, v.message])
        ),
      })
    }
    if (err.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: `${err.path} không hợp lệ: ${err.value}`,
      })
    }
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || 'field'
      return res.status(409).json({
        success: false,
        message: `Trùng giá trị "${field}". Vui lòng thử lại.`,
        field,
      })
    }
    return res.status(500).json({
      success: false,
      message: err.message || 'Lỗi server',
      error:   err.message,
      name:    err.name,
    })
  }
}

const enrichInvoice = async (invoice) => {
  if (!invoice) return invoice
  const obj = invoice.toObject ? invoice.toObject() : invoice

  const userIds = [...new Set(
    (obj.payments ?? [])
      .map(p => p.createdBy?.toString())
      .filter(Boolean)
  )]
  let users = []
  if (userIds.length > 0) {
    try {
      users = await User.find({ _id: { $in: userIds } }).select('email fullName username')
    } catch (_) { users = [] }
  }
  const userMap = {}
  users.forEach(u => { userMap[u._id.toString()] = u })

  obj.payments = (obj.payments ?? []).map(p => ({
    ...p,
    createdByUser: p.createdBy ? userMap[p.createdBy.toString()] ?? null : null,
  }))

  if (obj.bookingId) {
    try {
      const booking = await Booking.findById(obj.bookingId).select('roomNumber roomType rooms')
      if (booking) {
        // Với group: ghép roomNumber từ rooms[]
        if (Array.isArray(booking.rooms) && booking.rooms.length > 0) {
          const activeRooms = booking.rooms.filter(r => r.status !== 'cancelled')
          obj.roomNumber = obj.roomNumber || activeRooms.map(r => r.roomNumber).filter(Boolean).join(', ')
        } else {
          obj.roomNumber = obj.roomNumber || booking.roomNumber
          obj.roomType   = booking.roomType
        }
      }
    } catch (_) {}
  }

  return obj
}

// ═══════════════════════════════════════════════════════════════

// ⭐ FIX: getAll thêm filter branchId + customerName search
const getAll = safe(async (req, res) => {
  const { customerId, paymentStatus, branchId, search, page = 1, limit = 20 } = req.query

  // ⭐ FIX: Dùng aggregate pipeline để filter theo branchId
  //   Lý do: invoice cũ trong DB CHƯA có field branchId (chỉ invoice mới mới có).
  //   Solution: $lookup vào bookings để lấy branchId từ booking nếu invoice không có.
  //   → Filter được cả invoice cũ lẫn mới mà KHÔNG cần migration.

  const matchStage = {}
  if (customerId)    matchStage.customerId    = new (require('mongoose').Types.ObjectId)(customerId)
  if (paymentStatus) matchStage.paymentStatus = paymentStatus
  if (search) {
    matchStage.$or = [
      { customerName: { $regex: search, $options: 'i' } },
      { invoiceCode:  { $regex: search, $options: 'i' } },
      { roomNumber:   { $regex: search, $options: 'i' } },
    ]
  }

  // ⭐ Pipeline:
  //   1. Match các filter cơ bản (customerId, paymentStatus, search)
  //   2. Lookup booking để có branch info
  //   3. Add field effectiveBranchId = invoice.branchId ?? booking.branchId
  //   4. Match theo effectiveBranchId nếu user truyền branchId
  //   5. Sort + paginate
  const pipeline = [
    { $match: matchStage },
    {
      $lookup: {
        from:         'bookings',
        localField:   'bookingId',
        foreignField: '_id',
        as:           '_booking',
        pipeline:     [{ $project: { branchId: 1 } }],
      },
    },
    {
      $addFields: {
        // Ưu tiên invoice.branchId, fallback sang booking.branchId
        effectiveBranchId: {
          $ifNull: ['$branchId', { $arrayElemAt: ['$_booking.branchId', 0] }],
        },
      },
    },
  ]

  // ⭐ Filter theo branch (sau khi đã có effectiveBranchId)
  if (branchId) {
    pipeline.push({
      $match: {
        effectiveBranchId: new (require('mongoose').Types.ObjectId)(branchId),
      },
    })
  }

  // Sort newest first
  pipeline.push({ $sort: { createdAt: -1 } })

  // Count tổng (clone pipeline trước khi limit)
  const countPipeline = [...pipeline, { $count: 'total' }]
  const totalResult = await Invoice.aggregate(countPipeline)
  const total = totalResult[0]?.total ?? 0

  // Pagination
  pipeline.push({ $skip: (+page - 1) * +limit })
  pipeline.push({ $limit: +limit })

  // Cleanup field tạm trước khi return cho FE (giữ effectiveBranchId là branchId chính)
  pipeline.push({
    $addFields: { branchId: '$effectiveBranchId' },
  })
  pipeline.push({
    $project: { _booking: 0, effectiveBranchId: 0 },
  })

  const data = await Invoice.aggregate(pipeline)

  res.json({ success: true, data: { data, total, page: +page, limit: +limit } })
}, 'getAll')

const getOne = safe(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id)
  if (!invoice) return res.status(404).json({ success: false, message: 'Không tìm thấy hoá đơn' })
  const enriched = await enrichInvoice(invoice)
  res.json({ success: true, data: { invoice: enriched } })
}, 'getOne')

// ⭐ FIX: getOrCreateForBooking dùng computeBookingTotals
const getOrCreateForBooking = safe(async (req, res) => {
  const { bookingId } = req.params

  if (!bookingId || !bookingId.match(/^[a-f0-9]{24}$/i)) {
    return res.status(400).json({ success: false, message: 'bookingId không hợp lệ' })
  }

  const booking = await Booking.findById(bookingId)
  if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

  // ⭐ Compute totals từ booking (xử lý cả single + group)
  const totals = computeBookingTotals(booking)
  const customerName = booking.customerName || booking.customerPhone || 'Khách'

  let invoice = await Invoice.findOne({ bookingId: booking._id })

  if (!invoice) {
    // CREATE
    let attempts = 0
    let lastErr  = null
    while (attempts < 3 && !invoice) {
      try {
        invoice = await Invoice.create({
          bookingId:       booking._id,
          customerId:      booking.customerId ?? null,
          customerName,
          roomNumber:      totals.roomNumber,
          roomAmount:      totals.roomAmount,
          servicesAmount:  totals.servicesAmount,
          discount:        totals.discount,
          totalAmount:     totals.totalAmount,
          paidAmount:      0,
          remainingAmount: totals.totalAmount,
          paymentStatus:   'unpaid',
          // ⭐ NEW: branchId từ booking
          branchId:        booking.branchId ?? null,
          issuedBy:        req.user?.id ?? req.user?._id ?? null,
          items:           totals.items,
        })
      } catch (createErr) {
        lastErr = createErr
        if (createErr.code === 11000 && createErr.keyPattern?.invoiceCode) {
          attempts++
          await new Promise(r => setTimeout(r, 50 * attempts))
          continue
        }
        throw createErr
      }
    }

    if (!invoice) throw lastErr ?? new Error('Không tạo được invoice')
  } else {
    // ⭐ UPDATE: ALWAYS recalc từ totals (trước đây chỉ check khác mới update)
    //   Bug cũ: nếu booking đoàn add thêm phòng, totalAmount cũ giữ nguyên 1 phòng
    //   Fix: luôn ghi đè từ totals tính lại
    const needRecalc =
      invoice.totalAmount     !== totals.totalAmount ||
      invoice.roomAmount      !== totals.roomAmount ||
      invoice.servicesAmount  !== totals.servicesAmount ||
      invoice.discount        !== totals.discount ||
      (invoice.items ?? []).length !== totals.items.length

    if (needRecalc) {
      console.log(`[invoice recalc] booking=${booking._id}`, {
        old: { total: invoice.totalAmount, rooms: invoice.roomAmount, items: (invoice.items ?? []).length },
        new: { total: totals.totalAmount,  rooms: totals.roomAmount,  items: totals.items.length },
      })

      invoice.roomAmount      = totals.roomAmount
      invoice.servicesAmount  = totals.servicesAmount
      invoice.discount        = totals.discount
      invoice.totalAmount     = totals.totalAmount
      invoice.roomNumber      = totals.roomNumber
      invoice.items           = totals.items
      invoice.remainingAmount = Math.max(0, totals.totalAmount - (invoice.paidAmount ?? 0))
      invoice.paymentStatus   =
        (invoice.paidAmount ?? 0) >= totals.totalAmount ? 'paid'
        : (invoice.paidAmount ?? 0) > 0                 ? 'partial'
        :                                                 'unpaid'

      // ⭐ Nếu invoice cũ chưa có branchId — backfill từ booking
      if (!invoice.branchId && booking.branchId) {
        invoice.branchId = booking.branchId
      }

      await invoice.save()
    }
  }

  let enriched
  try {
    enriched = await enrichInvoice(invoice)
  } catch (enrichErr) {
    console.error('[getOrCreateForBooking] enrichInvoice failed (non-fatal):', enrichErr.message)
    enriched = invoice.toObject ? invoice.toObject() : invoice
  }

  res.json({ success: true, data: { invoice: enriched } })
}, 'getOrCreateForBooking')

const addPayment = safe(async (req, res) => {
  const { amount, method, note = '', type = 'payment', targetRoomId = null } = req.body
  if (!amount || amount <= 0)
    return res.status(400).json({ success: false, message: 'Số tiền không hợp lệ' })
  if (!['payment', 'refund'].includes(type))
    return res.status(400).json({ success: false, message: 'type phải là payment hoặc refund' })

  const invoice = await Invoice.findById(req.params.id)
  if (!invoice) return res.status(404).json({ success: false, message: 'Không tìm thấy hoá đơn' })

  if (!Array.isArray(invoice.payments)) invoice.payments = []
  invoice.payments.push({
    amount: type === 'refund' ? -Math.abs(amount) : Math.abs(amount),
    method: method ?? 'cash',
    note,
    type,
    paidAt: new Date(),
    createdBy: req.user?.id ?? req.user?._id ?? null,
    targetRoomId: targetRoomId ?? null,
  })

  const paidAmount = invoice.payments.reduce((s, p) => s + (p.amount ?? 0), 0)
  invoice.paidAmount      = paidAmount
  invoice.remainingAmount = Math.max(0, (invoice.totalAmount ?? 0) - paidAmount)
  invoice.paymentStatus   = paidAmount >= (invoice.totalAmount ?? 0) ? 'paid' :
                            paidAmount > 0 ? 'partial' : 'unpaid'
  invoice.paymentMethod   = method ?? invoice.paymentMethod
  await invoice.save()

  let allocations = []
  if (invoice.bookingId && type === 'payment') {
    try {
      const booking = await Booking.findById(invoice.bookingId)
      if (booking && Array.isArray(booking.rooms) && booking.rooms.length > 1) {
        const result = allocatePaymentToRoomsHelper(booking, Math.abs(amount), targetRoomId)
        allocations = result.allocations
        await booking.save()
      }
    } catch (allocErr) {
      console.error('[addPayment] allocate to sub-rooms failed (non-fatal):', allocErr.message)
    }
  } else if (invoice.bookingId && type === 'refund') {
    try {
      const booking = await Booking.findById(invoice.bookingId)
      if (booking && Array.isArray(booking.rooms) && booking.rooms.length > 1) {
        let toRefund = Math.abs(amount)

        const ordered = []
        if (targetRoomId) {
          const targetIdx = booking.rooms.findIndex(sr =>
            String(sr.roomId?._id ?? sr.roomId) === String(targetRoomId)
          )
          if (targetIdx >= 0) ordered.push(targetIdx)
        }
        for (let i = booking.rooms.length - 1; i >= 0; i--) {
          if (!ordered.includes(i)) ordered.push(i)
        }

        for (const i of ordered) {
          if (toRefund <= 0) break
          const sr = booking.rooms[i]
          const paid = sr.paidAmount ?? 0
          if (paid <= 0) continue
          const sub = Math.min(paid, toRefund)
          sr.paidAmount = paid - sub
          toRefund -= sub
        }
        await booking.save()
      }
    } catch (refundErr) {
      console.error('[addPayment] refund allocate failed (non-fatal):', refundErr.message)
    }
  }

  if (invoice.bookingId) {
    try {
      await Booking.findByIdAndUpdate(invoice.bookingId, { paymentStatus: invoice.paymentStatus })
    } catch (e) {
      console.error('[addPayment] update booking status failed (non-fatal):', e.message)
    }
  }

  try {
    const booking = invoice.bookingId ? await Booking.findById(invoice.bookingId).select('roomNumber branchId customerName') : null
    await logAction({
      entityType: 'Invoice', entityId: invoice._id,
      action: type === 'refund' ? 'refund' : 'payment',
      description: type === 'refund'
        ? `Hoàn ${Math.abs(amount).toLocaleString('vi-VN')}đ cho ${booking?.customerName ?? 'khách'} (${booking?.roomNumber ?? '?'})${note ? ` — ${note}` : ''}`
        : `Thu ${amount.toLocaleString('vi-VN')}đ từ ${booking?.customerName ?? 'khách'} (${booking?.roomNumber ?? '?'})${note ? ` — ${note}` : ''}`,
      user: req.user, branchId: booking?.branchId,
      metadata: {
        invoiceCode: invoice.invoiceCode, amount, method, type, note,
        bookingId: invoice.bookingId, roomNumber: booking?.roomNumber,
        paidAmount: invoice.paidAmount, totalAmount: invoice.totalAmount,
      },
    })
  } catch (auditErr) {
    console.error('[addPayment] audit log failed (non-fatal):', auditErr.message)
  }

  let enriched
  try {
    enriched = await enrichInvoice(invoice)
  } catch (enrichErr) {
    console.error('[addPayment] enrichInvoice failed (non-fatal):', enrichErr.message)
    enriched = invoice.toObject ? invoice.toObject() : invoice
  }

  return res.json({
    success: true,
    message: type === 'refund' ? 'Đã hoàn tiền' : 'Đã ghi nhận thanh toán',
    data: { invoice: enriched },
  })
}, 'addPayment')

const update = safe(async (req, res) => {
  const allowed = ['discount', 'notes', 'paymentMethod']
  const payload = {}
  allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k] })

  const invoice = await Invoice.findByIdAndUpdate(req.params.id, payload, { new: true })
  if (!invoice) return res.status(404).json({ success: false, message: 'Không tìm thấy hoá đơn' })
  res.json({ success: true, message: 'Cập nhật thành công', data: { invoice } })
}, 'update')

module.exports = { getAll, getOne, getOrCreateForBooking, addPayment, update }