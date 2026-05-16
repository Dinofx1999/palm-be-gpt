const Invoice = require('../models/Invoice');
const Booking = require('../models/Booking');
const User    = require('../models/User');
const Transaction = require('../models/Transaction');
const Shift = require('../models/Shift');

// ⭐ NEW 14/05/2026: Auto-sync transaction khi thanh toán/hoàn tiền
const {
  syncInvoicePayment,
  removeInvoicePayment,
} = require('../utils/invoiceTransactionHelper');

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

  // ⭐ NEW 16/05/2026: Enrich lockInfo cho từng payment
  //   FE dùng để ẩn nút Sửa/Huỷ khi payment thuộc ca đã settle
  try {
    const paymentIds = (obj.payments ?? [])
      .filter(p => !p.isDeleted)
      .map(p => p._id);
    if (paymentIds.length > 0) {
      // Bulk lookup transactions linked to these payments
      const txs = await Transaction.find({
        relatedType: 'invoice_payment',
        relatedId: { $in: paymentIds },
        isCancelled: { $ne: true },
      }).select('relatedId shiftId').lean();
      const txMap = new Map(txs.map(t => [String(t.relatedId), t.shiftId]));

      const shiftIds = [...new Set(txs.map(t => String(t.shiftId)).filter(Boolean))];
      let shiftMap = new Map();
      if (shiftIds.length > 0) {
        const shifts = await Shift.find({ _id: { $in: shiftIds } })
          .select('shiftCode status').lean();
        shiftMap = new Map(shifts.map(s => [String(s._id), s]));
      }

      const LOCKED = ['handed_over', 'reconciled', 'resolved', 'disputed'];
      const LABELS = {
        handed_over: 'đã bàn giao',
        reconciled:  'đã duyệt',
        resolved:    'đã giải quyết tranh chấp',
        disputed:    'đang tranh chấp',
      };

      obj.payments = obj.payments.map(p => {
        if (p.isDeleted) return { ...p, lockInfo: { isLocked: false } };
        const shiftId = txMap.get(String(p._id));
        if (!shiftId) return { ...p, lockInfo: { isLocked: false } };
        const sh = shiftMap.get(String(shiftId));
        if (!sh) return { ...p, lockInfo: { isLocked: false } };
        return {
          ...p,
          lockInfo: LOCKED.includes(sh.status)
            ? {
                isLocked: true,
                shiftCode: sh.shiftCode,
                shiftStatus: sh.status,
                statusLabel: LABELS[sh.status] || sh.status,
              }
            : { isLocked: false, shiftCode: sh.shiftCode, shiftStatus: sh.status },
        };
      });
    }
  } catch (lockErr) {
    console.error('[enrichInvoice] Enrich lockInfo failed (non-fatal):', lockErr.message);
  }

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
        effectiveBranchId: {
          $ifNull: ['$branchId', { $arrayElemAt: ['$_booking.branchId', 0] }],
        },
      },
    },
  ]

  if (branchId) {
    pipeline.push({
      $match: {
        effectiveBranchId: new (require('mongoose').Types.ObjectId)(branchId),
      },
    })
  }

  pipeline.push({ $sort: { createdAt: -1 } })

  const countPipeline = [...pipeline, { $count: 'total' }]
  const totalResult = await Invoice.aggregate(countPipeline)
  const total = totalResult[0]?.total ?? 0

  pipeline.push({ $skip: (+page - 1) * +limit })
  pipeline.push({ $limit: +limit })

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

  const totals = computeBookingTotals(booking)
  const customerName = booking.customerName || booking.customerPhone || 'Khách'

  let invoice = await Invoice.findOne({ bookingId: booking._id })

  if (!invoice) {
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
      // ⭐ FIX 15/05/2026: Dùng helper để filter isDeleted khi tính paidAmount
      recomputeInvoiceTotals(invoice)

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

  // ⭐ FIX 15/05/2026: Dùng helper recomputeInvoiceTotals — filter isDeleted
  //   (Trước đây cộng cả payment đã huỷ → tổng sai)
  recomputeInvoiceTotals(invoice)
  invoice.paymentMethod = method ?? invoice.paymentMethod
  await invoice.save()

  // ⭐ NEW 14/05/2026: Auto-sync transaction vào module Thu/Chi
  //   Mỗi payment thành 1 transaction riêng (idempotent theo payment._id)
  //   - type='payment' → Transaction { type:'income', category:'Tiền phòng' }
  //   - type='refund'  → Transaction { type:'expense', category:'Hoàn tiền khách' }
  //   Errors KHÔNG chặn payment flow (non-fatal)
  try {
    const savedPayment = invoice.payments[invoice.payments.length - 1]
    const syncResult = await syncInvoicePayment(invoice, savedPayment, {
      userId: req.user?.id ?? req.user?._id ?? null,
    })
    console.log('[addPayment] Sync transaction:', syncResult)
  } catch (syncErr) {
    console.error('[addPayment] Sync transaction lỗi (non-fatal):', syncErr.message)
  }

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

// ─────────────────────────────────────────────────────────────────
// ⭐ NEW 15/05/2026: Edit + Delete payment + History
// ─────────────────────────────────────────────────────────────────

/**
 * Helper: tính lại paidAmount/remaining/status từ payments[]
 *   Bỏ qua các payment đã isDeleted
 */
function recomputeInvoiceTotals(invoice) {
  const validPayments = (invoice.payments ?? []).filter(p => !p.isDeleted)
  const paidAmount = validPayments.reduce((s, p) => s + (p.amount ?? 0), 0)
  invoice.paidAmount = paidAmount
  invoice.remainingAmount = Math.max(0, (invoice.totalAmount ?? 0) - paidAmount)
  invoice.paymentStatus =
    paidAmount >= (invoice.totalAmount ?? 0) ? 'paid'
    : paidAmount > 0 ? 'partial'
    : 'unpaid'
}

/**
 * Helper: check permission — cho phép nếu cùng branch
 *   - Admin: mọi branch
 *   - Khác: phải cùng branch của invoice
 */
const canModifyPayment = (user, invoice) => {
  if (user.role === 'Admin') return true
  const userBranchId = String(user.branchId?._id ?? user.branchId ?? '')
  const invoiceBranchId = String(invoice.branchId ?? '')
  return userBranchId && invoiceBranchId && userBranchId === invoiceBranchId
}

/**
 * ⭐ NEW 16/05/2026: Check payment có thuộc ca đã settle không?
 *   Ca đã settle = status ∈ ['handed_over', 'reconciled', 'resolved', 'disputed']
 *   Nghĩa là tiền đã được bàn giao thực tế / đã đối soát với QL / NH → không cho sửa.
 *
 * Logic kinh doanh: đã bàn giao = đã settle. Nếu khách cần thay đổi → tạo gd hoàn trả mới.
 *
 * @returns {Object|null} null nếu OK, ngược lại { blocked: true, shiftCode, status, reason }
 */
const STATUS_LABEL = {
  handed_over: 'đã bàn giao',
  reconciled:  'đã duyệt',
  resolved:    'đã giải quyết tranh chấp',
  disputed:    'đang tranh chấp',
}

async function checkPaymentLockedByShift(paymentId) {
  try {
    // Tìm Transaction liên kết với payment này
    const tx = await Transaction.findOne({
      relatedType: 'invoice_payment',
      relatedId: paymentId,
      isCancelled: { $ne: true },
    }).select('shiftId').lean()

    if (!tx?.shiftId) return null   // Không có ca → cho sửa

    const shift = await Shift.findById(tx.shiftId).select('shiftCode status').lean()
    if (!shift) return null

    const lockedStatuses = ['handed_over', 'reconciled', 'resolved', 'disputed']
    if (lockedStatuses.includes(shift.status)) {
      return {
        blocked: true,
        shiftCode: shift.shiftCode,
        status: shift.status,
        statusLabel: STATUS_LABEL[shift.status] || shift.status,
      }
    }
    return null
  } catch (err) {
    console.error('[checkPaymentLockedByShift]', err.message)
    return null   // fail-open để không block do lỗi tra cứu
  }
}

/**
 * PUT /api/invoices/:id/payments/:paymentId
 * Body: { amount?, method?, note?, reason }
 *   - reason: BẮT BUỘC (min 5 ký tự)
 *   - Chỉ field nào gửi mới được update
 */
const editPayment = safe(async (req, res) => {
  const { id, paymentId } = req.params
  const { amount, method, note, reason = '' } = req.body

  if (!reason || reason.trim().length < 5) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập lý do sửa (≥5 ký tự)' })
  }

  const invoice = await Invoice.findById(id)
  if (!invoice) return res.status(404).json({ success: false, message: 'Không tìm thấy hoá đơn' })

  if (!canModifyPayment(req.user, invoice)) {
    return res.status(403).json({ success: false, message: 'Không có quyền sửa thanh toán của chi nhánh khác' })
  }

  const payment = invoice.payments.id(paymentId)
  if (!payment) return res.status(404).json({ success: false, message: 'Không tìm thấy phiếu thanh toán' })

  if (payment.isDeleted) {
    return res.status(400).json({ success: false, message: 'Phiếu này đã bị huỷ, không thể sửa' })
  }

  // ⭐ NEW 16/05/2026: Block khi payment thuộc ca đã settle (bàn giao/duyệt/tranh chấp)
  //   Lý do: đã bàn giao = tiền đã thực sự chuyển/báo có → không thể "sửa số".
  //   Nếu khách cần thay đổi → tạo giao dịch hoàn trả mới ở ca hiện tại.
  const lockInfo = await checkPaymentLockedByShift(paymentId)
  if (lockInfo) {
    return res.status(409).json({
      success: false,
      code: 'PAYMENT_LOCKED_BY_SHIFT',
      message: `Phiếu thanh toán này thuộc ca ${lockInfo.shiftCode} đã ${lockInfo.statusLabel} — không thể sửa. Nếu cần điều chỉnh, vui lòng tạo giao dịch hoàn trả mới ở ca hiện tại.`,
      data: { shiftCode: lockInfo.shiftCode, shiftStatus: lockInfo.status },
    })
  }

  // ⭐ Validate giá trị mới
  const changes = {}
  let hasChange = false

  if (amount !== undefined) {
    const newAmount = Number(amount)
    if (!Number.isFinite(newAmount) || newAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Số tiền không hợp lệ' })
    }
    // Tôn trọng dấu: nếu payment cũ âm (refund) → giữ âm
    const signedNewAmount = payment.amount < 0 ? -Math.abs(newAmount) : Math.abs(newAmount)
    if (signedNewAmount !== payment.amount) {
      changes.amount = { from: payment.amount, to: signedNewAmount }
      payment.amount = signedNewAmount
      hasChange = true
    }
  }

  if (method !== undefined && method !== payment.method) {
    changes.method = { from: payment.method, to: String(method) }
    payment.method = String(method)
    hasChange = true
  }

  if (note !== undefined && String(note) !== (payment.note ?? '')) {
    changes.note = { from: payment.note ?? '', to: String(note) }
    payment.note = String(note)
    hasChange = true
  }

  if (!hasChange) {
    return res.status(400).json({ success: false, message: 'Không có thay đổi nào' })
  }

  // ⭐ Audit
  const userId = req.user?.id ?? req.user?._id
  let userName = req.user?.fullName ?? req.user?.username ?? ''
  if (!userName && userId) {
    try {
      const u = await User.findById(userId).select('fullName username').lean()
      userName = u?.fullName ?? u?.username ?? ''
    } catch (_) {}
  }

  payment.isEdited = true
  if (!Array.isArray(payment.editHistory)) payment.editHistory = []
  payment.editHistory.push({
    editedAt: new Date(),
    editedBy: userId,
    editedByName: userName,
    reason: String(reason).slice(0, 500),
    changes,
  })

  recomputeInvoiceTotals(invoice)
  await invoice.save()

  // ⭐ Sync Transaction: đánh dấu isEdited (transaction giữ nguyên amount cũ — Edit ko tạo gd mới)
  //   Nếu muốn re-sync hoàn toàn → gọi syncInvoicePayment ở đây
  try {
    const syncResult = await syncInvoicePayment(invoice, payment, {
      userId,
      isEdit: true,   // ⭐ flag cho helper: update Transaction thay vì create mới
    })
    console.log('[editPayment] re-sync transaction:', syncResult)
  } catch (syncErr) {
    console.error('[editPayment] re-sync transaction failed (non-fatal):', syncErr.message)
  }

  // Update booking sub-rooms (nếu group) — đơn giản: recompute từ payments
  if (invoice.bookingId) {
    try {
      await Booking.findByIdAndUpdate(invoice.bookingId, { paymentStatus: invoice.paymentStatus })
    } catch (_) {}
  }

  // ⭐ FIX 16/05/2026: Audit log đầy đủ — gắn bookingId vào metadata
  //   để Booking Detail audit tab có thể query thấy log này.
  //   Thêm customer/room info để description rõ ràng hơn.
  try {
    // Lookup booking để có customer name + room
    const booking = invoice.bookingId
      ? await Booking.findById(invoice.bookingId).select('customerName roomNumber').lean()
      : null
    const customerLabel = booking?.customerName
      ? `${booking.customerName}${booking.roomNumber ? ` (${booking.roomNumber})` : ''}`
      : (invoice.customerName || 'khách')

    // Mô tả thay đổi cụ thể
    const changeParts = []
    if (changes.amount) {
      changeParts.push(
        `số tiền: ${Math.abs(changes.amount.from).toLocaleString('vi-VN')}đ → ${Math.abs(changes.amount.to).toLocaleString('vi-VN')}đ`
      )
    }
    if (changes.method) {
      const methodLabel = (m) => ({ cash: 'Tiền mặt', transfer: 'Chuyển khoản', card: 'Thẻ' })[m] || m
      changeParts.push(`HTTT: ${methodLabel(changes.method.from)} → ${methodLabel(changes.method.to)}`)
    }
    if (changes.note) changeParts.push('ghi chú')

    await logAction({
      entityType: 'Invoice', entityId: invoice._id,
      action: 'edit_payment',
      description: `Sửa phiếu thanh toán của ${customerLabel} — ${changeParts.join(', ')} (lý do: ${reason})`,
      user: req.user, branchId: invoice.branchId,
      metadata: {
        paymentId, changes, reason,
        bookingId: invoice.bookingId,           // ⭐ cho /by-booking query
        invoiceCode: invoice.invoiceCode,
        customerName: booking?.customerName,
        roomNumber:   booking?.roomNumber,
      },
    })
  } catch (auditErr) {
    console.error('[editPayment] audit log failed (non-fatal):', auditErr.message)
  }

  const enriched = await enrichInvoice(invoice).catch(() => invoice.toObject())
  res.json({
    success: true,
    message: 'Đã sửa phiếu thanh toán',
    data: { invoice: enriched },
  })
}, 'editPayment')

/**
 * DELETE /api/invoices/:id/payments/:paymentId
 * Body: { reason }
 *   - Soft delete: payment.isDeleted = true
 *   - Trừ paidAmount khỏi invoice
 *   - Đánh dấu Transaction tương ứng isCancelled
 */
const deletePayment = safe(async (req, res) => {
  const { id, paymentId } = req.params
  const { reason = '' } = req.body

  if (!reason || reason.trim().length < 5) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập lý do huỷ (≥5 ký tự)' })
  }

  const invoice = await Invoice.findById(id)
  if (!invoice) return res.status(404).json({ success: false, message: 'Không tìm thấy hoá đơn' })

  if (!canModifyPayment(req.user, invoice)) {
    return res.status(403).json({ success: false, message: 'Không có quyền huỷ thanh toán của chi nhánh khác' })
  }

  const payment = invoice.payments.id(paymentId)
  if (!payment) return res.status(404).json({ success: false, message: 'Không tìm thấy phiếu thanh toán' })

  if (payment.isDeleted) {
    return res.status(400).json({ success: false, message: 'Phiếu này đã bị huỷ trước đó' })
  }

  // ⭐ NEW 16/05/2026: Block khi payment thuộc ca đã settle
  const lockInfo = await checkPaymentLockedByShift(paymentId)
  if (lockInfo) {
    return res.status(409).json({
      success: false,
      code: 'PAYMENT_LOCKED_BY_SHIFT',
      message: `Phiếu thanh toán này thuộc ca ${lockInfo.shiftCode} đã ${lockInfo.statusLabel} — không thể huỷ. Nếu cần điều chỉnh, vui lòng tạo giao dịch hoàn trả mới ở ca hiện tại.`,
      data: { shiftCode: lockInfo.shiftCode, shiftStatus: lockInfo.status },
    })
  }

  const userId = req.user?.id ?? req.user?._id
  let userName = req.user?.fullName ?? req.user?.username ?? ''
  if (!userName && userId) {
    try {
      const u = await User.findById(userId).select('fullName username').lean()
      userName = u?.fullName ?? u?.username ?? ''
    } catch (_) {}
  }

  // Soft delete
  payment.isDeleted = true
  payment.deletedAt = new Date()
  payment.deletedBy = userId
  payment.deletedByName = userName
  payment.deletedReason = String(reason).slice(0, 500)

  recomputeInvoiceTotals(invoice)
  await invoice.save()

  // Allocate ngược: trừ paidAmount khỏi sub-rooms (nếu booking group)
  if (invoice.bookingId) {
    try {
      const booking = await Booking.findById(invoice.bookingId)
      if (booking && Array.isArray(booking.rooms) && booking.rooms.length > 0) {
        let toReverse = Math.abs(payment.amount)
        // Trừ từ phòng có paidAmount > 0
        for (const sr of booking.rooms) {
          if (toReverse <= 0) break
          const paid = sr.paidAmount ?? 0
          if (paid <= 0) continue
          const sub = Math.min(paid, toReverse)
          sr.paidAmount = paid - sub
          toReverse -= sub
        }
        booking.paymentStatus = invoice.paymentStatus
        await booking.save()
      } else if (booking) {
        booking.paymentStatus = invoice.paymentStatus
        await booking.save()
      }
    } catch (e) {
      console.error('[deletePayment] reverse allocate failed (non-fatal):', e.message)
    }
  }

  // ⭐ Sync Transaction: đánh dấu Cancelled
  try {
    await removeInvoicePayment(invoice, payment, {
      userId,
      reason: payment.deletedReason,
    })
  } catch (syncErr) {
    console.error('[deletePayment] cancel transaction failed (non-fatal):', syncErr.message)
  }

  // ⭐ FIX 16/05/2026: Audit log đầy đủ — gắn bookingId vào metadata
  try {
    const booking = invoice.bookingId
      ? await Booking.findById(invoice.bookingId).select('customerName roomNumber').lean()
      : null
    const customerLabel = booking?.customerName
      ? `${booking.customerName}${booking.roomNumber ? ` (${booking.roomNumber})` : ''}`
      : (invoice.customerName || 'khách')

    const methodLabel = (m) => ({ cash: 'Tiền mặt', transfer: 'Chuyển khoản', card: 'Thẻ' })[m] || m

    await logAction({
      entityType: 'Invoice', entityId: invoice._id,
      action: 'cancel_payment',
      description: `Huỷ phiếu thanh toán ${Math.abs(payment.amount).toLocaleString('vi-VN')}đ (${methodLabel(payment.method)}) của ${customerLabel} — lý do: ${reason}`,
      user: req.user, branchId: invoice.branchId,
      metadata: {
        paymentId,
        amount: payment.amount,
        method: payment.method,
        reason,
        bookingId: invoice.bookingId,          // ⭐ cho /by-booking query
        invoiceCode: invoice.invoiceCode,
        customerName: booking?.customerName,
        roomNumber:   booking?.roomNumber,
      },
    })
  } catch (auditErr) {
    console.error('[deletePayment] audit log failed (non-fatal):', auditErr.message)
  }

  const enriched = await enrichInvoice(invoice).catch(() => invoice.toObject())
  res.json({
    success: true,
    message: 'Đã huỷ phiếu thanh toán',
    data: { invoice: enriched },
  })
}, 'deletePayment')

/**
 * GET /api/invoices/:id/payments/:paymentId/history
 * Trả về editHistory + deletedBy info của 1 payment
 */
const getPaymentHistory = safe(async (req, res) => {
  const { id, paymentId } = req.params

  const invoice = await Invoice.findById(id)
  if (!invoice) return res.status(404).json({ success: false, message: 'Không tìm thấy hoá đơn' })

  const payment = invoice.payments.id(paymentId)
  if (!payment) return res.status(404).json({ success: false, message: 'Không tìm thấy phiếu thanh toán' })

  res.json({
    success: true,
    data: {
      paymentId: payment._id,
      isEdited: !!payment.isEdited,
      editHistory: payment.editHistory ?? [],
      isDeleted: !!payment.isDeleted,
      deletedAt: payment.deletedAt,
      deletedBy: payment.deletedBy,
      deletedByName: payment.deletedByName,
      deletedReason: payment.deletedReason,
    },
  })
}, 'getPaymentHistory')

module.exports = { getAll, getOne, getOrCreateForBooking, addPayment, update, editPayment, deletePayment, getPaymentHistory }