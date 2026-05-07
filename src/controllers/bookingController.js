const Booking      = require('../models/Booking');
const Room         = require('../models/Room');
const Customer     = require('../models/Customer');
const Invoice      = require('../models/Invoice');
const Branch       = require('../models/Branch');
const PricePolicy  = require('../models/PricePolicy');
const AuditLog     = require('../models/AuditLog');
const { calculatePrice } = require('../utils/priceCalculator');
const { logAction }      = require('../utils/auditLogger');
const { buildPolicySnapshot } = require('../utils/policySnapshot');

// ⭐ Role guard cho undo check-in/check-out — chỉ Admin/Manager
const ALLOWED_UNDO_ROLES = ['Admin', 'Manager']

// ⭐ Roles được phép set giờ checkout quá khứ với BẤT KỲ phòng nào
//    Roles khác chỉ được phép nếu phòng ĐÃ TỪNG checkout (qua audit log)
const PRIVILEGED_PAST_ROLES = ['Admin', 'Manager']

const checkUndoPermission = (user) => {
  if (!user) {
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHENTICATED',
      message: 'Cần đăng nhập để hoàn tác',
    }
  }
  if (!ALLOWED_UNDO_ROLES.includes(user.role)) {
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN_ROLE',
      message: `Chỉ Admin/Manager mới được quyền hoàn tác (vai trò hiện tại: ${user.role || 'unknown'})`,
    }
  }
  return { ok: true }
}

// ⭐ Lấy log checkout gần nhất của 1 booking
const getLastCheckoutLog = async (bookingId, roomNumber = null) => {
  try {
    const filter = {
      entityType: 'Booking',
      entityId:   bookingId,
      action:     { $in: ['checkout', 'checkout_room'] },
    }
    if (roomNumber) {
      filter['metadata.roomNumber'] = String(roomNumber)
    }
    const log = await AuditLog.findOne(filter)
      .sort({ createdAt: -1 })
      .select('_id createdAt action metadata')
      .lean()
    return log ?? null
  } catch (err) {
    console.error('[getLastCheckoutLog] error:', err.message)
    return null
  }
}

const hasBookingBeenCheckedOut = async (bookingId, roomNumber = null) => {
  const log = await getLastCheckoutLog(bookingId, roomNumber)
  return !!log
}

// ⭐ Phân quyền "set giờ quá khứ"
const canSetPastTime = async (user, bookingId, roomNumber = null) => {
  if (!user) {
    return { canSetPast: false, reason: 'Cần đăng nhập', lastCheckoutAt: null }
  }
  if (PRIVILEGED_PAST_ROLES.includes(user.role)) {
    const log = await getLastCheckoutLog(bookingId, roomNumber)
    return {
      canSetPast: true,
      lastCheckoutAt: log?.metadata?.actualCheckOut ?? null,
    }
  }
  const log = await getLastCheckoutLog(bookingId, roomNumber)
  if (log) {
    return {
      canSetPast: true,
      lastCheckoutAt: log.metadata?.actualCheckOut ?? null,
    }
  }
  return {
    canSetPast: false,
    reason: 'Chỉ Admin/Manager được phép set giờ trả phòng quá khứ. Nhân viên chỉ được sửa nếu phòng đã từng trả phòng (đã từng checkout).',
    lastCheckoutAt: null,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ⭐ FIX TRIỆT ĐỂ: Tìm booking conflict THẬT SỰ trên 1 phòng cụ thể
//
// VẤN ĐỀ CŨ:
// - Query include status 'checked_out' → match cả booking đã trả rồi
// - So sánh dùng checkIn/checkOut DỰ KIẾN cấp booking
//   → 2 booking liên tiếp trong cùng ngày bị xem là conflict dù thực tế không overlap
//
// LOGIC MỚI:
// 1. Chỉ status active: confirmed/reserved/checked_in (BỎ checked_out)
// 2. Resolve interval THỰC TẾ của candidate:
//    [actualCheckIn ?? checkIn, actualCheckOut ?? checkOut]
// 3. Bỏ qua sub-room đã checked_out trong booking đoàn
// 4. So sánh overlap chuẩn: a < d && c < b
// ════════════════════════════════════════════════════════════════════════════
const findActiveConflictForRoom = async ({
  bookingId, roomId, intervalStart, intervalEnd,
}) => {
  const candidates = await Booking.find({
    _id:    { $ne: bookingId },
    $or: [
      { roomId },
      { 'rooms.roomId': roomId },
    ],
    // ⭐ CHỈ status đang active — bỏ checked_out (phòng đã trống)
    status:   { $in: ['confirmed', 'reserved', 'checked_in'] },
  }).sort({ checkIn: 1 })

  for (const cand of candidates) {
    let candRoom    = null
    let candStatus  = cand.status
    let candStart   = null
    let candEnd     = null

    if (Array.isArray(cand.rooms) && cand.rooms.length > 0) {
      // Booking đoàn → tìm sub-room match roomId
      candRoom = cand.rooms.find(r =>
        String(r.roomId?._id ?? r.roomId) === String(roomId)
      )
      if (!candRoom) continue
      // Bỏ qua sub-room đã trả/cancel (phòng đã giải phóng)
      if (['checked_out', 'cancelled'].includes(candRoom.status)) continue
      candStatus = candRoom.status
      candStart  = candRoom.actualCheckIn  ?? candRoom.checkIn  ?? cand.checkIn
      candEnd    = candRoom.actualCheckOut ?? candRoom.checkOut ?? cand.checkOut
    } else {
      // Booking đơn — match qua cand.roomId
      if (String(cand.roomId) !== String(roomId)) continue
      candStart = cand.actualCheckIn  ?? cand.checkIn
      candEnd   = cand.actualCheckOut ?? cand.checkOut
    }

    if (!candStart || !candEnd) continue

    // ⭐ Overlap check chuẩn: [a,b] vs [c,d] overlap khi a < d && c < b
    const overlap = new Date(intervalStart) < new Date(candEnd) &&
                    new Date(candStart)     < new Date(intervalEnd)
    if (!overlap) continue

    return {
      conflict:        cand,
      conflictRoom:    candRoom,
      conflictStart:   candStart,
      conflictEnd:     candEnd,
      conflictStatus:  candStatus,
    }
  }

  return null
}

// ════════════════════════════════════════════════════════════════════════════
// ⭐ HELPER: Tìm conflict khi TẠO MỚI / ĐỔI NGÀY booking
//
// Khác với findActiveConflictForRoom:
// - Đây là check overlap [intervalStart, intervalEnd] với BẤT KỲ booking active
//   nào trên cùng phòng (xét cả actualCheckIn/actualCheckOut nếu có)
// - Tham số: bookingIds (mảng) — bỏ qua các booking này (vd update self)
//
// LOGIC:
// 1. Status active: confirmed/reserved/checked_in (BỎ checked_out, cancelled)
// 2. Resolve interval thực tế của candidate:
//    [actualCheckIn ?? checkIn, actualCheckOut ?? checkOut]
//    → Quan trọng: nếu khách check-in sớm (actualCheckIn=11:00 dù checkIn=14:00),
//      booking mới đặt 11:30 vẫn bị block đúng
// 3. Per-sub-room cho booking đoàn (skip checked_out/cancelled sub)
// 4. Overlap chuẩn: a < d && c < b (>=, <= không tính là overlap → cho phép
//    nối tiếp đúng giờ: A trả 12:00, B nhận 12:00 → OK)
// ════════════════════════════════════════════════════════════════════════════
const findOverlapForNewBooking = async ({
  roomId, intervalStart, intervalEnd,
  excludeBookingIds = [],
}) => {
  const filter = {
    $or: [
      { roomId },
      { 'rooms.roomId': roomId },
    ],
    status: { $in: ['confirmed', 'reserved', 'checked_in'] },
  }
  if (excludeBookingIds.length > 0) {
    filter._id = { $nin: excludeBookingIds }
  }

  const candidates = await Booking.find(filter).sort({ checkIn: 1 })

  for (const cand of candidates) {
    let candRoom    = null
    let candStart   = null
    let candEnd     = null
    let candStatus  = cand.status

    if (Array.isArray(cand.rooms) && cand.rooms.length > 0) {
      // Booking đoàn — tìm sub-room cụ thể
      candRoom = cand.rooms.find(r =>
        String(r.roomId?._id ?? r.roomId) === String(roomId)
      )
      if (!candRoom) continue
      // Bỏ qua sub-room đã trả/hủy
      if (['checked_out', 'cancelled'].includes(candRoom.status)) continue
      candStatus = candRoom.status
      candStart  = candRoom.actualCheckIn  ?? candRoom.checkIn  ?? cand.checkIn
      candEnd    = candRoom.actualCheckOut ?? candRoom.checkOut ?? cand.checkOut
    } else {
      // Booking đơn — match qua cand.roomId
      if (String(cand.roomId) !== String(roomId)) continue
      candStart = cand.actualCheckIn  ?? cand.checkIn
      candEnd   = cand.actualCheckOut ?? cand.checkOut
    }

    if (!candStart || !candEnd) continue

    // Overlap chuẩn: [a,b] vs [c,d] overlap khi a < d && c < b
    // Khoảng nối tiếp đúng giờ (A trả 12:00, B nhận 12:00) KHÔNG tính overlap
    const overlap = new Date(intervalStart) < new Date(candEnd) &&
                    new Date(candStart)     < new Date(intervalEnd)
    if (!overlap) continue

    return {
      conflict:       cand,
      conflictRoom:   candRoom,
      conflictStart:  candStart,
      conflictEnd:    candEnd,
      conflictStatus: candStatus,
    }
  }

  return null
}

// ── GET ALL ───────────────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    const { status, paymentStatus, customerId, roomId, branchId, page = 1, limit = 20 } = req.query
    const filter = {}
    if (status)        filter.status        = status
    if (paymentStatus) filter.paymentStatus = paymentStatus
    if (customerId)    filter.customerId    = customerId
    if (roomId)        filter.roomId        = roomId
    if (branchId)      filter.branchId      = branchId

    const total = await Booking.countDocuments(filter)
    const data  = await Booking.find(filter)
      .sort({ createdAt: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit)

    res.json({ success: true, data: { data, total, page: +page, limit: +limit } })
  } catch (err) { next(err) }
}

// ⭐ Helper build invoice items từ priceBreakdown thực tế
const buildInvoiceItemsFromBooking = (booking) => {
  const items = []
  const isGroup = Array.isArray(booking.rooms) && booking.rooms.length > 0

  if (isGroup) {
    for (const sub of booking.rooms) {
      if (sub.status === 'cancelled') continue
      const subBd = Array.isArray(sub.priceBreakdown) ? sub.priceBreakdown : []
      for (const b of subBd) {
        const seg = (b && typeof b.toObject === 'function') ? b.toObject() : b
        const rawLabel = String(seg.label ?? '').trim()
        const cleanLabel = rawLabel.replace(/^\[[^\]]+\]\s*/, '')
        items.push({
          description: `Phòng ${sub.roomNumber} – ${cleanLabel}`,
          quantity:    1,
          unitPrice:   Number(seg.amount ?? 0),
          amount:      Number(seg.amount ?? 0),
        })
      }
      if ((sub.servicesAmount ?? 0) > 0) {
        items.push({
          description: `Phòng ${sub.roomNumber} – Dịch vụ`,
          quantity:    1,
          unitPrice:   Number(sub.servicesAmount ?? 0),
          amount:      Number(sub.servicesAmount ?? 0),
        })
      }
    }
  } else {
    const bd = Array.isArray(booking.priceBreakdown) ? booking.priceBreakdown : []
    for (const b of bd) {
      const seg = (b && typeof b.toObject === 'function') ? b.toObject() : b
      items.push({
        description: `Phòng ${booking.roomNumber} – ${String(seg.label ?? '').trim()}`,
        quantity:    1,
        unitPrice:   Number(seg.amount ?? 0),
        amount:      Number(seg.amount ?? 0),
      })
    }
    if ((booking.servicesAmount ?? 0) > 0) {
      items.push({
        description: `Dịch vụ`,
        quantity:    1,
        unitPrice:   Number(booking.servicesAmount ?? 0),
        amount:      Number(booking.servicesAmount ?? 0),
      })
    }
  }

  if (items.length === 0) {
    items.push({
      description: `Phòng ${booking.roomNumber} – ${booking.roomType ?? ''} × ${booking.nights ?? 1} đêm`,
      quantity:    booking.nights ?? 1,
      unitPrice:   Math.round((booking.roomAmount ?? 0) / Math.max(1, booking.nights ?? 1)),
      amount:      booking.roomAmount ?? 0,
    })
  }

  return items
}

const getOne = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    res.json({ success: true, data: { booking } })
  } catch (err) { next(err) }
}

// ⭐ PREVIEW PRICE
const previewPrice = async (req, res, next) => {
  try {
    const {
      roomId, checkIn, checkOut, priceType = 'day',
      adults = 2, children = 0, policyId, confirmConvert = false,
    } = req.body
    if (!roomId || !checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin' })

    const room = await Room.findById(roomId).populate('typeId')
    if (!room) return res.status(404).json({ success: false, message: 'Không tìm thấy phòng' })

    const branch = await Branch.findById(room.branchId)

    let policy = policyId ? await PricePolicy.findById(policyId) : null
    if (!policy) policy = await PricePolicy.findOne({ roomTypeId: room.typeId, branchId: room.branchId, isActive: true })

    const maxAdults   = room.typeId?.maxAdults   ?? room.typeId?.capacity ?? 2
    const maxChildren = room.typeId?.maxChildren ?? 0

    const result = calculatePrice({
      checkIn:  new Date(checkIn),
      checkOut: new Date(checkOut),
      priceType, policy, branch, adults, children, maxAdults, maxChildren,
    })

    if (result.error) {
      return res.status(400).json({
        success: false,
        code:    result.error.code,
        message: result.error.message,
        data: {
          finalPriceType:  result.error.finalPriceType,
          availableTypes:  result.error.availableTypes,
          availableLabels: result.error.availableLabels,
          policyName:      policy?.name ?? '',
        },
      })
    }

    res.json({
      success: true,
      data: {
        ...result,
        totalAmount: result.roomAmount,
        policyId:    policy?._id ?? null,
        policyName:  policy?.name ?? '',
      },
    })
  } catch (err) { next(err) }
}

// ── CREATE ────────────────────────────────────────────
const create = async (req, res, next) => {
  try {
    const {
      customerName, roomId,
      checkIn, checkOut,
      priceType = 'day', adults = 2, children = 0,
      notes = '', source = 'Trực tiếp', discount = 0,
      policyId,
      status: requestedStatus,
      confirmConvert = false,
    } = req.body

    let customerPhone = (req.body.customerPhone ?? '').toString().trim()

    if (!customerName || !roomId || !checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc (tên khách / phòng / ngày)' })

    const room = await Room.findById(roomId).populate('typeId')
    if (!room) return res.status(404).json({ success: false, message: 'Không tìm thấy phòng' })
    if (room.roomStatus === 'inactive')    return res.status(400).json({ success: false, message: 'Phòng đã tạm ngưng hoạt động' })
    if (room.roomStatus === 'maintenance') return res.status(400).json({ success: false, message: 'Phòng đang bảo trì' })

    const checkInDate  = new Date(checkIn)
    const checkOutDate = new Date(checkOut)
    if (checkOutDate <= checkInDate)
      return res.status(400).json({ success: false, message: 'Ngày check-out phải sau check-in' })

    // ⭐ Determine effective interval cho conflict check
    //    - Nếu chỉ tạo booking (reserved/confirmed): check [checkIn, checkOut] dự kiến
    //    - Nếu tạo + check-in luôn (status='checked_in'): khách sẽ vào ngay lúc now
    //      → check [min(now, checkIn), checkOut] để bắt đè lên booking đang ở
    const validInitialEarly = ['reserved', 'confirmed', 'checked_in']
    const initialStatusEarly = validInitialEarly.includes(requestedStatus) ? requestedStatus : 'reserved'
    const willCheckInNow = initialStatusEarly === 'checked_in'
    const nowForCreate = new Date()
    const conflictIntervalStart = willCheckInNow && nowForCreate < checkInDate
      ? nowForCreate
      : checkInDate
    const conflictIntervalEnd = checkOutDate

    const conflictResult = await findOverlapForNewBooking({
      roomId,
      intervalStart: conflictIntervalStart,
      intervalEnd:   conflictIntervalEnd,
    })
    if (conflictResult) {
      const { conflict, conflictStart, conflictEnd, conflictStatus } = conflictResult
      const statusLabel = {
        reserved:   'đã đặt',
        confirmed:  'đã xác nhận',
        checked_in: 'đang ở',
      }[conflictStatus] ?? conflictStatus
      const actionLabel = willCheckInNow ? 'nhận phòng ngay' : 'đặt phòng'
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_OVERLAP',
        message: `Không thể ${actionLabel} — phòng đang có khách (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}.${willCheckInNow ? ` Bạn muốn nhận phòng từ ${nowForCreate.toLocaleString('vi-VN')} nhưng phòng đang bị chiếm.` : ' Vui lòng chọn khoảng giờ khác.'}`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          conflictCheckOut:     conflictEnd,
          conflictStatus,
          attemptedCheckInAt:   willCheckInNow ? nowForCreate : null,
          requestedCheckIn:     checkInDate,
          requestedCheckOut:    checkOutDate,
        },
      })
    }

    const branch = await Branch.findById(room.branchId)

    const applyTimeIfMidnight = (date, timeStr) => {
      const d = new Date(date)
      if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
        const [h, m] = String(timeStr ?? '14:00').split(':').map(Number)
        d.setHours(h, m, 0, 0)
      }
      return d
    }
    const checkInFinal  = applyTimeIfMidnight(checkInDate,  branch?.checkInTime  || '14:00')
    const checkOutFinal = applyTimeIfMidnight(checkOutDate, branch?.checkOutTime || '12:00')

    let policy = policyId ? await PricePolicy.findById(policyId) : null
    if (!policy) policy = await PricePolicy.findOne({ roomTypeId: room.typeId, branchId: room.branchId, isActive: true })

    const maxAdults   = room.typeId?.maxAdults   ?? room.typeId?.capacity ?? 2
    const maxChildren = room.typeId?.maxChildren ?? 0

    const priceResult = calculatePrice({
      checkIn:  checkInFinal,
      checkOut: checkOutFinal,
      priceType, policy, branch, adults, children, maxAdults, maxChildren,
    })

    if (priceResult.error) {
      return res.status(400).json({
        success: false,
        code:    priceResult.error.code,
        message: priceResult.error.message,
        data: {
          finalPriceType:  priceResult.error.finalPriceType,
          availableTypes:  priceResult.error.availableTypes,
          availableLabels: priceResult.error.availableLabels,
          policyName:      policy?.name ?? '',
        },
      })
    }

    if (priceResult.converted && !confirmConvert) {
      return res.status(422).json({
        success: false,
        code:    'NEEDS_CONFIRMATION',
        message: priceResult.notice,
        data: {
          ...priceResult,
          totalAmount: priceResult.roomAmount,
        },
      })
    }

    const roomAmount  = priceResult.roomAmount
    const totalAmount = roomAmount - (discount ?? 0)

    let customer
    if (customerPhone) {
      customer = await Customer.findOne({ phone: customerPhone })
      if (!customer) customer = await Customer.create({ name: customerName, phone: customerPhone })
    } else {
      customer = await Customer.create({ name: customerName })
    }

    const validInitial  = ['reserved', 'confirmed', 'checked_in']
    const initialStatus = validInitial.includes(requestedStatus) ? requestedStatus : 'reserved'

    const booking = await Booking.create({
      customerId:   customer._id,
      customerName, customerPhone,
      roomId:       room._id,
      roomNumber:   room.number,
      roomType:     room.typeName,
      branchId:     room.branchId,
      checkIn:      checkInFinal,
      checkOut:     checkOutFinal,
      nights:       priceResult.nights,
      priceType:    priceResult.finalPriceType,
      adults, children,
      notes, source,
      discount,
      discountPercent: 0,
      discountAmount:  discount ?? 0,
      isFreeRoom:      false,
      roomAmount, totalAmount,
      servicesAmount: 0,
      priceBreakdown: priceResult.breakdown,
      policyId:       policy?._id ?? null,
      policyName:     policy?.name ?? '',
      policySnapshot: policy ? buildPolicySnapshot(policy, room.typeId?.capacity ?? null) : null,
      status:         initialStatus,
      actualCheckIn:  initialStatus === 'checked_in' ? new Date() : null,
    })

    await Room.findByIdAndUpdate(roomId, {
      currentBookingId: booking._id,
      currentGuestName: customerName,
    })

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: initialStatus === 'checked_in' ? 'create_and_checkin' : 'create',
      description: initialStatus === 'checked_in'
        ? `Nhận phòng ${room.number} cho ${customerName}`
        : `Tạo đặt phòng ${room.number} cho ${customerName}`,
      user: req.user, branchId: room.branchId,
      metadata: {
        roomNumber: room.number, customerName,
        checkIn: checkInFinal, checkOut: checkOutFinal,
        totalAmount, status: initialStatus,
      },
    })

    res.status(201).json({
      success: true,
      message: initialStatus === 'checked_in' ? 'Nhận phòng thành công' : 'Tạo đặt phòng thành công',
      data: {
        booking,
        priceBreakdown: priceResult.breakdown,
        converted:      priceResult.converted,
        notice:         priceResult.notice,
      },
    })
  } catch (err) { next(err) }
}

// ── UPDATE ────────────────────────────────────────────
const update = async (req, res, next) => {
  try {
    const allowed = [
      'customerName', 'customerPhone', 'checkIn', 'checkOut',
      'adults', 'children', 'notes', 'source', 'discount', 'paymentStatus',
    ]
    const payload = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k] })

    if (payload.checkIn || payload.checkOut) {
      const booking = await Booking.findById(req.params.id)
      if (booking) {
        const checkIn  = new Date(payload.checkIn  ?? booking.checkIn)
        const checkOut = new Date(payload.checkOut ?? booking.checkOut)
        payload.nights      = Math.max(1, Math.ceil((checkOut - checkIn) / 86400000))
        payload.roomAmount  = booking.roomAmount / booking.nights * payload.nights
        payload.totalAmount = payload.roomAmount + (booking.servicesAmount ?? 0) - (payload.discount ?? booking.discount ?? 0)
      }
    }

    const booking = await Booking.findByIdAndUpdate(req.params.id, payload, { new: true })
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

    const changedFields = Object.keys(payload).filter(k => !['nights','roomAmount','totalAmount'].includes(k))
    if (changedFields.length > 0) {
      await logAction({
        entityType: 'Booking', entityId: booking._id,
        action: 'update',
        description: `Cập nhật ${changedFields.join(', ')}`,
        user: req.user, branchId: booking.branchId,
        metadata: { changedFields, payload },
      })
    }

    res.json({ success: true, message: 'Cập nhật thành công', data: { booking } })
  } catch (err) { next(err) }
}

// ── CHANGE DATES ──────────────────────────────────────
const changeDates = async (req, res, next) => {
  try {
    const { checkIn, checkOut, confirmConvert = false } = req.body
    if (!checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Thiếu checkIn/checkOut' })

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (['cancelled', 'checked_out'].includes(booking.status))
      return res.status(400).json({ success: false, message: `Không thể đổi ngày ở trạng thái: ${booking.status}` })

    const newCheckIn  = new Date(checkIn)
    const newCheckOut = new Date(checkOut)
    if (newCheckOut <= newCheckIn)
      return res.status(400).json({ success: false, message: 'Ngày check-out phải sau check-in' })

    const allRoomIds = [booking.roomId]
    if (Array.isArray(booking.rooms)) {
      for (const sr of booking.rooms) {
        if (sr.roomId) allRoomIds.push(sr.roomId)
      }
    }

    // ⭐ Check conflict cho từng phòng riêng biệt
    for (const rid of allRoomIds) {
      if (!rid) continue
      const conflictResult = await findOverlapForNewBooking({
        roomId:        rid,
        intervalStart: newCheckIn,
        intervalEnd:   newCheckOut,
        excludeBookingIds: [booking._id],
      })
      if (conflictResult) {
        const { conflict, conflictStart, conflictEnd, conflictStatus } = conflictResult
        const statusLabel = {
          reserved:   'đã đặt',
          confirmed:  'đã xác nhận',
          checked_in: 'đang ở',
        }[conflictStatus] ?? conflictStatus
        return res.status(400).json({
          success: false,
          code: 'CONFLICT_OVERLAP',
          message: `Trùng với đặt phòng khác (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}`,
          data: {
            conflictBookingId:    conflict._id,
            conflictCustomerName: conflict.customerName,
            conflictCheckIn:      conflictStart,
            conflictCheckOut:     conflictEnd,
            conflictStatus,
          },
        })
      }
    }

    const room   = await Room.findById(booking.roomId).populate('typeId')
    const branch = await Branch.findById(booking.branchId)
    const policy = booking.policyId ? await PricePolicy.findById(booking.policyId) : null
    const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
    const maxChildren = room?.typeId?.maxChildren ?? 0

    const priceResult = calculatePrice({
      checkIn: newCheckIn, checkOut: newCheckOut,
      priceType: booking.priceType, policy, branch,
      adults: booking.adults, children: booking.children, maxAdults, maxChildren,
    })

    if (priceResult.error) {
      return res.status(400).json({
        success: false,
        code:    priceResult.error.code,
        message: priceResult.error.message,
        data: {
          finalPriceType:  priceResult.error.finalPriceType,
          availableTypes:  priceResult.error.availableTypes,
          availableLabels: priceResult.error.availableLabels,
          policyName:      policy?.name ?? '',
        },
      })
    }

    if (priceResult.converted && !confirmConvert) {
      return res.status(422).json({
        success: false,
        code: 'NEEDS_CONFIRMATION',
        message: priceResult.notice,
        data: { ...priceResult, totalAmount: priceResult.roomAmount },
      })
    }

    booking.checkOut    = newCheckOut
    booking.nights      = priceResult.nights
    booking.priceType   = priceResult.finalPriceType
    booking.roomAmount  = priceResult.roomAmount
    booking.totalAmount = priceResult.roomAmount + (booking.servicesAmount ?? 0) - (booking.discount ?? 0)

    let updatedActualCheckIn = false
    if (booking.status === 'checked_in') {
      booking.actualCheckIn = newCheckIn
      updatedActualCheckIn  = true
    } else {
      booking.checkIn = newCheckIn
    }
    await booking.save()

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'change_dates',
      description: updatedActualCheckIn
        ? `Đổi giờ nhận phòng thực tế: ${new Date(newCheckIn).toLocaleString('vi-VN')} → trả: ${new Date(newCheckOut).toLocaleString('vi-VN')}`
        : `Đổi ngày ở: ${new Date(newCheckIn).toLocaleString('vi-VN')} → ${new Date(newCheckOut).toLocaleString('vi-VN')}`,
      user: req.user, branchId: booking.branchId,
      metadata: {
        newCheckIn, newCheckOut,
        nights: booking.nights,
        roomAmount: booking.roomAmount,
        updatedActualCheckIn,
      },
    })

    res.json({
      success: true,
      message: 'Đổi ngày thành công',
      data: { booking, priceBreakdown: priceResult.breakdown, notice: priceResult.notice },
    })
  } catch (err) { next(err) }
}

// ⭐ PATCH /bookings/:id/change-dates-room
const changeDatesRoom = async (req, res, next) => {
  try {
    const { roomId: subRoomId, checkIn, checkOut, confirmConvert = false } = req.body
    console.log('[changeDatesRoom] bookingId=', req.params.id, 'subRoomId=', subRoomId, 'checkIn=', checkIn, 'checkOut=', checkOut)
    if (!subRoomId || !checkIn || !checkOut) {
      return res.status(400).json({ success: false, message: 'Thiếu roomId/checkIn/checkOut' })
    }

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (['cancelled', 'checked_out'].includes(booking.status)) {
      return res.status(400).json({ success: false, message: `Không thể đổi ngày ở trạng thái: ${booking.status}` })
    }
    if (!Array.isArray(booking.rooms) || booking.rooms.length === 0) {
      return res.status(400).json({ success: false, message: 'Booking không có phòng đoàn' })
    }

    const subRoom = booking.rooms.find(sr => String(sr.roomId?._id ?? sr.roomId) === String(subRoomId))
    if (!subRoom) {
      return res.status(404).json({ success: false, message: 'Phòng không thuộc đoàn này' })
    }
    if (['cancelled', 'checked_out'].includes(subRoom.status)) {
      return res.status(400).json({ success: false, message: `Không thể đổi ngày phòng ở trạng thái: ${subRoom.status}` })
    }

    const newCheckIn  = new Date(checkIn)
    const newCheckOut = new Date(checkOut)
    if (newCheckOut <= newCheckIn) {
      return res.status(400).json({ success: false, message: 'Ngày check-out phải sau check-in' })
    }

    const conflictResult = await findOverlapForNewBooking({
      roomId:        subRoomId,
      intervalStart: newCheckIn,
      intervalEnd:   newCheckOut,
      excludeBookingIds: [booking._id],
    })
    if (conflictResult) {
      const { conflict, conflictStart, conflictEnd, conflictStatus } = conflictResult
      const statusLabel = {
        reserved:   'đã đặt',
        confirmed:  'đã xác nhận',
        checked_in: 'đang ở',
      }[conflictStatus] ?? conflictStatus
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_OVERLAP',
        message: `Phòng ${subRoom.roomNumber} bị trùng với đặt phòng khác (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          conflictCheckOut:     conflictEnd,
          conflictStatus,
        },
      })
    }

    const room   = await Room.findById(subRoom.roomId).populate('typeId')
    const branch = await Branch.findById(booking.branchId)
    const policy = subRoom.policyId ? await PricePolicy.findById(subRoom.policyId)
                  : booking.policyId ? await PricePolicy.findById(booking.policyId)
                  : null
    const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
    const maxChildren = room?.typeId?.maxChildren ?? 0

    const priceResult = calculatePrice({
      checkIn:   newCheckIn,
      checkOut:  newCheckOut,
      priceType: subRoom.priceType ?? booking.priceType,
      policy, branch,
      adults:    subRoom.adults    ?? booking.adults,
      children:  subRoom.children  ?? booking.children,
      maxAdults, maxChildren,
    })

    if (priceResult.error) {
      return res.status(400).json({
        success: false,
        code:    priceResult.error.code,
        message: priceResult.error.message,
        data: {
          finalPriceType:  priceResult.error.finalPriceType,
          availableTypes:  priceResult.error.availableTypes,
          availableLabels: priceResult.error.availableLabels,
          policyName:      policy?.name ?? '',
          roomNumber:      subRoom.roomNumber,
        },
      })
    }

    if (priceResult.converted && !confirmConvert) {
      return res.status(422).json({
        success: false,
        code: 'NEEDS_CONFIRMATION',
        message: priceResult.notice,
        data: { ...priceResult, totalAmount: priceResult.roomAmount },
      })
    }

    const oldCheckIn  = subRoom.checkIn  ?? booking.checkIn
    const oldCheckOut = subRoom.checkOut ?? booking.checkOut
    const oldActualCheckIn = subRoom.actualCheckIn ?? null

    let updatedActualCheckIn = false
    if (subRoom.status === 'checked_in') {
      subRoom.actualCheckIn = newCheckIn
      updatedActualCheckIn  = true
    } else {
      subRoom.checkIn = newCheckIn
    }
    subRoom.checkOut       = newCheckOut
    subRoom.nights         = priceResult.nights
    subRoom.priceType      = priceResult.finalPriceType
    subRoom.roomAmount     = priceResult.roomAmount
    subRoom.priceBreakdown = (priceResult.breakdown ?? []).map(b => ({
      label:  String(b.label ?? ''),
      amount: Number(b.amount ?? 0),
      type:   b.type === 'surcharge' ? 'surcharge' : 'base',
      meta:   { ...(b.meta || {}), roomNumber: subRoom.roomNumber },
    }))

    for (const other of booking.rooms) {
      if (other === subRoom) continue
      if (!other.checkIn)  other.checkIn  = booking.checkIn
      if (!other.checkOut) other.checkOut = booking.checkOut
      if (!other.nights)   other.nights   = booking.nights
    }

    booking.roomAmount = booking.rooms.reduce((s, sr) => s + (sr.roomAmount ?? 0), 0)
    booking.totalAmount = booking.roomAmount + (booking.servicesAmount ?? 0) - (booking.discount ?? 0) + (booking.transferFee ?? 0)

    const allCheckIns  = booking.rooms.map(sr => sr.checkIn  ?? booking.checkIn)
    const allCheckOuts = booking.rooms.map(sr => sr.checkOut ?? booking.checkOut)
    booking.checkIn  = new Date(Math.min(...allCheckIns.map(d => new Date(d).getTime())))
    booking.checkOut = new Date(Math.max(...allCheckOuts.map(d => new Date(d).getTime())))

    await booking.save()

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'change_dates',
      description: updatedActualCheckIn
        ? `Đổi giờ nhận phòng thực tế (${subRoom.roomNumber}): ${oldActualCheckIn ? new Date(oldActualCheckIn).toLocaleString('vi-VN') : '—'} → ${newCheckIn.toLocaleString('vi-VN')} | trả: ${newCheckOut.toLocaleString('vi-VN')}`
        : `Đổi ngày phòng ${subRoom.roomNumber}: ${new Date(oldCheckIn).toLocaleString('vi-VN')} → ${newCheckIn.toLocaleString('vi-VN')} | ${new Date(oldCheckOut).toLocaleString('vi-VN')} → ${newCheckOut.toLocaleString('vi-VN')}`,
      user: req.user, branchId: booking.branchId,
      metadata: {
        roomId: subRoomId, roomNumber: subRoom.roomNumber,
        oldCheckIn, oldCheckOut,
        oldActualCheckIn,
        newCheckIn, newCheckOut,
        nights: priceResult.nights, roomAmount: priceResult.roomAmount,
        bookingId: booking._id,
        updatedActualCheckIn,
      },
    })

    res.json({
      success: true,
      message: `Đã đổi ngày phòng ${subRoom.roomNumber}`,
      data: { booking, priceBreakdown: priceResult.breakdown, notice: priceResult.notice },
    })
  } catch (err) {
    console.error('[changeDatesRoom] error:', err)
    next(err)
  }
}

// ── MOVE ROOM ─────────────────────────────────────────
const moveRoom = async (req, res, next) => {
  try {
    const {
      roomId: newRoomId,
      subRoomId  = null,
      reason     = '',
      applyNewPrice = false,
      newPolicyId   = null,
      transferFee   = 0,
      transferAt    = null,
    } = req.body

    if (!newRoomId) return res.status(400).json({ success: false, message: 'Thiếu roomId mới' })

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (['cancelled', 'checked_out'].includes(booking.status))
      return res.status(400).json({ success: false, message: `Không thể chuyển phòng ở trạng thái: ${booking.status}` })

    const isGroup = Array.isArray(booking.rooms) && booking.rooms.length > 1
    const targetSubRoomId = isGroup ? (subRoomId || booking.roomId) : null

    let subRoomIdx = -1
    let subRoom    = null
    if (isGroup) {
      subRoomIdx = booking.rooms.findIndex(sr => String(sr.roomId) === String(targetSubRoomId))
      if (subRoomIdx < 0) {
        return res.status(400).json({ success: false, message: 'Không tìm thấy phòng nguồn trong đoàn' })
      }
      subRoom = booking.rooms[subRoomIdx]
      if (['cancelled', 'checked_out'].includes(subRoom.status)) {
        return res.status(400).json({ success: false, message: `Không thể chuyển phòng ở trạng thái: ${subRoom.status}` })
      }
      if (String(subRoom.roomId) === String(newRoomId)) {
        return res.status(400).json({ success: false, message: 'Phòng đích trùng phòng hiện tại' })
      }
    } else {
      if (booking.roomId.toString() === newRoomId)
        return res.status(400).json({ success: false, message: 'Phòng đích trùng phòng hiện tại' })
    }

    const newRoom = await Room.findById(newRoomId).populate('typeId')
    if (!newRoom) return res.status(404).json({ success: false, message: 'Không tìm thấy phòng đích' })
    if (newRoom.roomStatus !== 'active')
      return res.status(400).json({ success: false, message: 'Phòng đích không khả dụng' })

    const checkInRange  = (isGroup && subRoom?.checkIn)  ? subRoom.checkIn  : booking.checkIn
    const checkOutRange = (isGroup && subRoom?.checkOut) ? subRoom.checkOut : booking.checkOut

    const moveConflictResult = await findOverlapForNewBooking({
      roomId:        newRoomId,
      intervalStart: checkInRange,
      intervalEnd:   checkOutRange,
      excludeBookingIds: [booking._id],
    })
    if (moveConflictResult) {
      const { conflict, conflictStart, conflictEnd, conflictStatus } = moveConflictResult
      const statusLabel = {
        reserved:   'đã đặt',
        confirmed:  'đã xác nhận',
        checked_in: 'đang ở',
      }[conflictStatus] ?? conflictStatus
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_OVERLAP',
        message: `Phòng đích đã có khách (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          conflictCheckOut:     conflictEnd,
          conflictStatus,
        },
      })
    }

    const oldRoomId      = isGroup ? subRoom.roomId       : booking.roomId
    const oldRoomNumber  = isGroup ? subRoom.roomNumber   : booking.roomNumber
    const oldPolicyId    = isGroup ? subRoom.policyId     : booking.policyId
    const oldRoom        = await Room.findById(oldRoomId).populate('typeId')

    const recalcMoveBreakdown = async ({
      sourceCheckIn, sourceCheckOut, sourceActualCheckIn,
      sourcePolicySnapshot, sourcePolicyId,
      sourcePriceType, sourceAdults, sourceChildren,
      currentRoomAmount, currentNights,
    }) => {
      const newPolicy = await PricePolicy.findById(newPolicyId)
      if (!newPolicy) throw new Error('Không tìm thấy chính sách giá mới')

      const branch      = await Branch.findById(booking.branchId)
      const splitAt     = transferAt ? new Date(transferAt) : new Date()
      const newMaxAdults   = newRoom.typeId?.maxAdults   ?? newRoom.typeId?.capacity ?? 2
      const newMaxChildren = newRoom.typeId?.maxChildren ?? 0

      let oldPolicy = null
      const snap = sourcePolicySnapshot
        ? (sourcePolicySnapshot.toObject ? sourcePolicySnapshot.toObject() : sourcePolicySnapshot)
        : null

      if (snap && (snap.dayEnabled || snap.hourEnabled || snap.nightEnabled || (snap.dayPrice && snap.dayPrice > 0) || (snap.nightPrice && snap.nightPrice > 0))) {
        oldPolicy = snap
      } else if (sourcePolicyId) {
        oldPolicy = await PricePolicy.findById(sourcePolicyId)
      }

      const oldMaxAdults   = snap?.maxAdults   ?? oldRoom?.typeId?.maxAdults   ?? snap?.capacity ?? oldRoom?.typeId?.capacity ?? 2
      const oldMaxChildren = snap?.maxChildren ?? oldRoom?.typeId?.maxChildren ?? 0

      let resultAmount = 0
      let resultBreakdown = []
      let usedSplit = splitAt

      if (splitAt <= sourceCheckIn) {
        const result = calculatePrice({
          checkIn:   sourceActualCheckIn ?? sourceCheckIn,
          checkOut:  sourceCheckOut,
          priceType: sourcePriceType,
          policy:    newPolicy, branch,
          adults:    sourceAdults,
          children:  sourceChildren,
          maxAdults: newMaxAdults, maxChildren: newMaxChildren,
        })
        resultAmount    = result.roomAmount
        resultBreakdown = (result.breakdown ?? []).map(b => ({
          ...b,
          label: `[${newRoom.number}] ${b.label}`,
          meta:  { ...(b.meta || {}), segment: 2, roomNumber: newRoom.number, policyId: newPolicy._id },
        }))
      } else if (splitAt >= sourceCheckOut) {
        resultAmount = currentRoomAmount
      } else {
        const seg1CheckIn = sourceActualCheckIn ?? sourceCheckIn
        let seg1Amount = 0
        let seg1Items  = []

        if (oldPolicy) {
          const seg1Result = calculatePrice({
            checkIn:   seg1CheckIn,
            checkOut:  splitAt,
            priceType: sourcePriceType,
            policy:    oldPolicy, branch,
            adults:    sourceAdults,
            children:  sourceChildren,
            maxAdults: oldMaxAdults, maxChildren: oldMaxChildren,
          })
          const filteredBreakdown = (seg1Result.breakdown ?? []).filter(b => {
            const label = String(b.label || '')
            return !label.includes('Trả phòng muộn') && !label.includes('late_checkout')
          })
          seg1Amount = filteredBreakdown.reduce((s, b) => s + (b.amount ?? 0), 0)
          seg1Items  = filteredBreakdown.map(b => ({
            ...b,
            label: `[${oldRoomNumber}] ${b.label}`,
            meta:  { ...(b.meta || {}), segment: 1, roomNumber: oldRoomNumber, policyId: sourcePolicyId },
          }))
        } else {
          const oldNights = Math.max(1, currentNights || 1)
          if (sourcePriceType === 'hour') {
            const totalHours = Math.max(1, (sourceCheckOut - seg1CheckIn) / 3600000)
            const usedHours  = Math.max(0, (splitAt - seg1CheckIn) / 3600000)
            seg1Amount = Math.round(currentRoomAmount * (usedHours / totalHours))
            seg1Items  = [{
              label:  `[${oldRoomNumber}] Giá giờ (${usedHours.toFixed(1)}h)`,
              amount: seg1Amount, type: 'base',
              meta:   { segment: 1, roomNumber: oldRoomNumber, fallback: true },
            }]
          } else {
            const startMs    = new Date(seg1CheckIn).setHours(0,0,0,0)
            const splitMs    = new Date(splitAt).setHours(0,0,0,0)
            const usedNights = Math.max(0, Math.min(oldNights, Math.ceil((splitMs - startMs) / 86400000)))
            const pricePerNight = Math.round(currentRoomAmount / oldNights)
            seg1Amount = pricePerNight * usedNights
            seg1Items  = [{
              label:  `[${oldRoomNumber}] Giá phòng × ${usedNights} đêm × ${pricePerNight.toLocaleString('vi-VN')}đ`,
              amount: seg1Amount, type: 'base',
              meta:   { segment: 1, roomNumber: oldRoomNumber, fallback: true },
            }]
          }
        }

        const seg2Result = calculatePrice({
          checkIn:   splitAt,
          checkOut:  sourceCheckOut,
          priceType: sourcePriceType,
          policy:    newPolicy, branch,
          adults:    sourceAdults,
          children:  sourceChildren,
          maxAdults: newMaxAdults, maxChildren: newMaxChildren,
        })
        const filteredSeg2 = (seg2Result.breakdown ?? []).filter(b => {
          const label = String(b.label || '')
          return !label.includes('Nhận phòng sớm') && !label.includes('early_checkin')
        })
        const seg2Amount = filteredSeg2.reduce((s, b) => s + (b.amount ?? 0), 0)
        const seg2Items  = filteredSeg2.map(b => ({
          ...b,
          label: `[${newRoom.number}] ${b.label}`,
          meta:  { ...(b.meta || {}), segment: 2, roomNumber: newRoom.number, policyId: newPolicy._id },
        }))

        resultAmount    = seg1Amount + seg2Amount
        resultBreakdown = [...seg1Items, ...seg2Items]
      }

      return {
        roomAmount:     resultAmount,
        priceBreakdown: resultBreakdown,
        usedSplit,
        newPolicy,
        newMaxAdults,
        newMaxChildren,
      }
    }

    let policyChanged  = false
    let usedTransferAt = null
    const fee = Math.max(0, Number(transferFee) || 0)

    if (isGroup) {
      let newSubRoomAmount     = subRoom.roomAmount ?? 0
      let newSubPriceBreakdown = subRoom.priceBreakdown ?? []
      let newSubPolicyId       = subRoom.policyId
      let newSubPolicyName     = subRoom.policyName

      if (applyNewPrice && newPolicyId) {
        let sourceSnapshot = null
        const oldPolId = subRoom.policyId ?? booking.policyId
        if (oldPolId) {
          try {
            const oldPol = await PricePolicy.findById(oldPolId)
            if (oldPol) {
              const oldCap = oldRoom?.typeId?.capacity ?? booking.policySnapshot?.capacity ?? 2
              sourceSnapshot = buildPolicySnapshot(oldPol, oldCap)
            }
          } catch (e) {
            console.log('[moveRoom group] Error fetching oldPolicy:', e.message)
          }
        }
        if (!sourceSnapshot && booking.policySnapshot) {
          sourceSnapshot = booking.policySnapshot
        }

        const recalc = await recalcMoveBreakdown({
          sourceCheckIn:        subRoom.checkIn  ?? booking.checkIn,
          sourceCheckOut:       subRoom.checkOut ?? booking.checkOut,
          sourceActualCheckIn:  subRoom.actualCheckIn ?? null,
          sourcePolicySnapshot: sourceSnapshot,
          sourcePolicyId:       oldPolId,
          sourcePriceType:      subRoom.priceType ?? booking.priceType,
          sourceAdults:         subRoom.adults    ?? booking.adults,
          sourceChildren:       subRoom.children  ?? booking.children,
          currentRoomAmount:    subRoom.roomAmount ?? 0,
          currentNights:        subRoom.nights ?? booking.nights,
        })
        newSubRoomAmount     = recalc.roomAmount
        newSubPriceBreakdown = recalc.priceBreakdown
        newSubPolicyId       = recalc.newPolicy._id
        newSubPolicyName     = recalc.newPolicy.name
        usedTransferAt       = recalc.usedSplit
        policyChanged        = true
      }

      booking.rooms[subRoomIdx].roomId         = newRoom._id
      booking.rooms[subRoomIdx].roomNumber     = newRoom.number
      booking.rooms[subRoomIdx].roomType       = newRoom.typeName
      booking.rooms[subRoomIdx].typeId         = newRoom.typeId?._id ?? newRoom.typeId
      if (applyNewPrice && newPolicyId) {
        booking.rooms[subRoomIdx].policyId       = newSubPolicyId
        booking.rooms[subRoomIdx].policyName     = newSubPolicyName
        booking.rooms[subRoomIdx].roomAmount     = newSubRoomAmount
        booking.rooms[subRoomIdx].priceBreakdown = newSubPriceBreakdown
      }
      booking.markModified('rooms')

      if (String(booking.roomId) === String(oldRoomId)) {
        booking.roomId     = newRoom._id
        booking.roomNumber = newRoom.number
        booking.roomType   = newRoom.typeName
      }

      booking.transferFee = (booking.transferFee || 0) + fee
      const totalRoomAmount = booking.rooms.reduce((s, r) => s + (r.roomAmount ?? 0), 0)
      booking.roomAmount = totalRoomAmount

      let recalcDiscount = booking.discount ?? 0
      if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
        const roomPart = booking.isFreeRoom ? 0 : totalRoomAmount
        const sub = roomPart + (booking.servicesAmount ?? 0)
        const pctDisc = Math.round(sub * (booking.discountPercent ?? 0) / 100)
        recalcDiscount = pctDisc + (booking.discountAmount ?? 0)
      }
      booking.discount    = recalcDiscount
      const subtotal = totalRoomAmount + (booking.servicesAmount ?? 0)
      booking.totalAmount = Math.max(0, subtotal - recalcDiscount + booking.transferFee)

      booking.transferHistory = booking.transferHistory || []
      booking.transferHistory.push({
        fromRoomId:     oldRoomId,
        fromRoomNumber: oldRoomNumber,
        toRoomId:       newRoom._id,
        toRoomNumber:   newRoom.number,
        transferAt:     usedTransferAt ?? new Date(),
        fee,
        oldPolicyId:    oldPolicyId,
        newPolicyId:    policyChanged ? newPolicyId : oldPolicyId,
        reason,
        subRoomId:      newRoom._id,
        by:             req.user?.id ?? req.user?._id ?? null,
      })

      booking.notes = `${booking.notes || ''}\n[Chuyển phòng (đoàn) ${oldRoomNumber} → ${newRoom.number}${fee > 0 ? ` • Phí: ${fee.toLocaleString('vi-VN')}đ` : ''}${policyChanged ? ' • Đổi giá' : ''}${reason ? ': ' + reason : ''}]`.trim()
      await booking.save()

      const stillUsedByThisBooking = booking.rooms.some(sr => String(sr.roomId) === String(oldRoomId))
      if (!stillUsedByThisBooking) {
        const oldRoomUpdate = {
          currentBookingId: null,
          currentGuestName: null,
        }
        if (subRoom.status === 'checked_in') {
          oldRoomUpdate.roomStatus = 'inactive'
        }
        await Room.findByIdAndUpdate(oldRoomId, oldRoomUpdate)
      }
      await Room.findByIdAndUpdate(newRoomId, {
        currentBookingId: booking._id,
        currentGuestName: booking.customerName,
      })

      try {
        const invoice = await Invoice.findOne({ bookingId: booking._id })
        if (invoice) {
          invoice.roomAmount      = booking.roomAmount
          invoice.discount        = booking.discount
          invoice.totalAmount     = booking.totalAmount
          invoice.remainingAmount = Math.max(0, invoice.totalAmount - (invoice.paidAmount ?? 0))
          invoice.paymentStatus   = invoice.paidAmount >= invoice.totalAmount ? 'paid' :
                                    invoice.paidAmount > 0 ? 'partial' : 'unpaid'
          await invoice.save()
        }
      } catch (e) {
        console.error('[moveRoom group] sync invoice failed (non-fatal):', e.message)
      }

      const auditDesc = [
        `Chuyển phòng (đoàn) ${oldRoomNumber} → ${newRoom.number}`,
        fee > 0 && `Phí ${fee.toLocaleString('vi-VN')}đ`,
        policyChanged && `Đổi giá`,
        reason,
      ].filter(Boolean).join(' • ')

      await logAction({
        entityType: 'Booking', entityId: booking._id,
        action: 'move_room',
        description: auditDesc,
        user: req.user, branchId: booking.branchId,
        metadata: {
          oldRoomNumber, newRoomNumber: newRoom.number,
          fee, policyChanged, newPolicyId, transferAt: usedTransferAt,
          newSubRoomAmount, newTotalAmount: booking.totalAmount,
          subRoomId: String(newRoom._id), groupMode: true,
          reason,
        },
      })

      return res.json({
        success: true,
        message: `Chuyển phòng ${oldRoomNumber} → ${newRoom.number} thành công`,
        data: { booking },
      })
    }

    let newPriceBreakdown = booking.priceBreakdown
    let newRoomAmount     = booking.roomAmount

    if (applyNewPrice && newPolicyId) {
      const recalc = await recalcMoveBreakdown({
        sourceCheckIn:        booking.checkIn,
        sourceCheckOut:       booking.checkOut,
        sourceActualCheckIn:  booking.actualCheckIn,
        sourcePolicySnapshot: booking.policySnapshot,
        sourcePolicyId:       booking.policyId,
        sourcePriceType:      booking.priceType,
        sourceAdults:         booking.adults,
        sourceChildren:       booking.children,
        currentRoomAmount:    booking.roomAmount,
        currentNights:        booking.nights,
      })
      newRoomAmount     = recalc.roomAmount
      newPriceBreakdown = recalc.priceBreakdown
      usedTransferAt    = recalc.usedSplit
      booking.policyId       = recalc.newPolicy._id
      booking.policyName     = recalc.newPolicy.name
      booking.policySnapshot = buildPolicySnapshot(recalc.newPolicy, (recalc.newMaxAdults ?? 0) + (recalc.newMaxChildren ?? 0))
      policyChanged          = true
    }

    booking.transferFee = (booking.transferFee || 0) + fee
    booking.roomAmount     = newRoomAmount
    booking.priceBreakdown = newPriceBreakdown
    const subtotal = newRoomAmount + (booking.servicesAmount ?? 0)

    let recalcDiscount = booking.discount ?? 0
    if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
      const roomPart = booking.isFreeRoom ? 0 : newRoomAmount
      const sub = roomPart + (booking.servicesAmount ?? 0)
      const pctDisc = Math.round(sub * (booking.discountPercent ?? 0) / 100)
      recalcDiscount = pctDisc + (booking.discountAmount ?? 0)
    }
    booking.discount    = recalcDiscount
    booking.totalAmount = Math.max(0, subtotal - recalcDiscount + booking.transferFee)

    booking.transferHistory = booking.transferHistory || []
    booking.transferHistory.push({
      fromRoomId:     oldRoomId,
      fromRoomNumber: oldRoomNumber,
      toRoomId:       newRoom._id,
      toRoomNumber:   newRoom.number,
      transferAt:     usedTransferAt ?? new Date(),
      fee,
      oldPolicyId:    oldPolicyId,
      newPolicyId:    policyChanged ? newPolicyId : oldPolicyId,
      reason,
      by:             req.user?.id ?? req.user?._id ?? null,
    })

    booking.roomId     = newRoom._id
    booking.roomNumber = newRoom.number
    booking.roomType   = newRoom.typeName
    booking.notes      = `${booking.notes || ''}\n[Chuyển phòng ${oldRoomNumber} → ${newRoom.number}${fee > 0 ? ` • Phí: ${fee.toLocaleString('vi-VN')}đ` : ''}${policyChanged ? ' • Đổi giá' : ''}${reason ? ': ' + reason : ''}]`.trim()
    await booking.save()

    const oldRoomUpdate = { currentBookingId: null, currentGuestName: null }
    if (booking.status === 'checked_in') {
      oldRoomUpdate.roomStatus = 'inactive'
    }
    await Room.findByIdAndUpdate(oldRoomId, oldRoomUpdate)
    await Room.findByIdAndUpdate(newRoomId, { currentBookingId: booking._id, currentGuestName: booking.customerName })

    try {
      const invoice = await Invoice.findOne({ bookingId: booking._id })
      if (invoice) {
        invoice.roomAmount      = booking.roomAmount
        invoice.discount        = booking.discount
        invoice.totalAmount     = booking.totalAmount
        invoice.remainingAmount = Math.max(0, invoice.totalAmount - (invoice.paidAmount ?? 0))
        invoice.paymentStatus   = invoice.paidAmount >= invoice.totalAmount ? 'paid' :
                                  invoice.paidAmount > 0 ? 'partial' : 'unpaid'
        await invoice.save()
      }
    } catch (e) {
      console.error('[moveRoom] sync invoice failed (non-fatal):', e.message)
    }

    const auditDesc = [
      `Chuyển phòng ${oldRoomNumber} → ${newRoom.number}`,
      fee > 0 && `Phí ${fee.toLocaleString('vi-VN')}đ`,
      policyChanged && `Đổi giá`,
      reason,
    ].filter(Boolean).join(' • ')

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'move_room',
      description: auditDesc,
      user: req.user, branchId: booking.branchId,
      metadata: {
        oldRoomNumber, newRoomNumber: newRoom.number,
        fee, policyChanged, newPolicyId, transferAt: usedTransferAt,
        newRoomAmount, newTotalAmount: booking.totalAmount,
        reason,
      },
    })

    res.json({ success: true, message: 'Chuyển phòng thành công', data: { booking } })
  } catch (err) {
    console.error('[moveRoom] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

// ⭐ PATCH /bookings/:id/change-policy
const changePolicy = async (req, res, next) => {
  try {
    const {
      policyId,
      customRoomAmount = null,
      customBreakdown  = null,
      discountPercent  = null,
      discountAmount   = null,
      isFreeRoom       = null,
    } = req.body

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

    let newRoomAmount     = booking.roomAmount
    let newPriceBreakdown = booking.priceBreakdown

    if (customRoomAmount !== null && customRoomAmount !== undefined) {
      newRoomAmount = Number(customRoomAmount) || 0
      newPriceBreakdown = [{
        label:  `Giá phòng (tự nhập) × ${booking.nights} đêm`,
        amount: newRoomAmount,
        type:   'base',
        meta:   { custom: true },
      }]
      booking.policyId   = null
      booking.policyName = 'Giá tự nhập'
    } else if (Array.isArray(customBreakdown) && customBreakdown.length > 0) {
      newPriceBreakdown = customBreakdown.map(b => ({
        label:  String(b.label ?? ''),
        amount: Number(b.amount) || 0,
        type:   b.type === 'surcharge' ? 'surcharge' : 'base',
        meta:   { ...(b.meta || {}), customPrice: true },
      }))
      newRoomAmount = newPriceBreakdown.reduce((s, b) => s + (b.amount ?? 0), 0)
      if (policyId) {
        const policy = await PricePolicy.findById(policyId)
        if (policy) {
          const room   = await Room.findById(booking.roomId).populate('typeId')
          const cap    = room?.typeId?.capacity ?? 2
          booking.policyId       = policy._id
          booking.policyName     = policy.name
          booking.policySnapshot = buildPolicySnapshot(policy, cap)
        }
      }
    } else if (policyId) {
      const policy = await PricePolicy.findById(policyId)
      if (!policy) return res.status(404).json({ success: false, message: 'Không tìm thấy chính sách giá' })
      const room    = await Room.findById(booking.roomId).populate('typeId')
      const branch  = await Branch.findById(booking.branchId)
      const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
      const maxChildren = room?.typeId?.maxChildren ?? 0
      const capacity    = room?.typeId?.capacity ?? (maxAdults + maxChildren)

      const result = calculatePrice({
        checkIn:   booking.checkIn,
        checkOut:  booking.checkOut,
        priceType: booking.priceType,
        policy, branch,
        adults:    booking.adults,
        children:  booking.children,
        maxAdults, maxChildren,
      })

      if (result.error) {
        return res.status(400).json({
          success: false,
          code:    result.error.code,
          message: result.error.message,
          data: {
            finalPriceType:  result.error.finalPriceType,
            availableTypes:  result.error.availableTypes,
            availableLabels: result.error.availableLabels,
            policyName:      policy?.name ?? '',
          },
        })
      }

      newRoomAmount     = result.roomAmount
      newPriceBreakdown = result.breakdown
      booking.policyId       = policy._id
      booking.policyName     = policy.name
      booking.policySnapshot = buildPolicySnapshot(policy, capacity)
    }

    if (discountPercent !== null) booking.discountPercent = Number(discountPercent) || 0
    if (discountAmount  !== null) booking.discountAmount  = Number(discountAmount)  || 0
    if (isFreeRoom      !== null) booking.isFreeRoom      = !!isFreeRoom

    booking.roomAmount     = newRoomAmount
    booking.priceBreakdown = newPriceBreakdown

    const roomPart = booking.isFreeRoom ? 0 : newRoomAmount
    const subtotal = roomPart + (booking.servicesAmount ?? 0)
    const pctDisc  = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
    booking.discount    = pctDisc + (booking.discountAmount ?? 0)
    booking.totalAmount = Math.max(0, subtotal - booking.discount + (booking.transferFee || 0))

    await booking.save()

    try {
      const invoice = await Invoice.findOne({ bookingId: booking._id })
      if (invoice) {
        invoice.roomAmount      = booking.roomAmount
        invoice.discount        = booking.discount
        invoice.totalAmount     = booking.totalAmount
        invoice.remainingAmount = Math.max(0, invoice.totalAmount - (invoice.paidAmount ?? 0))
        invoice.paymentStatus   = invoice.paidAmount >= invoice.totalAmount ? 'paid' :
                                  invoice.paidAmount > 0 ? 'partial' : 'unpaid'
        await invoice.save()
      }
    } catch (e) {
      console.error('[changePolicy] sync invoice failed (non-fatal):', e.message)
    }

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'change_policy',
      description: customRoomAmount !== null
        ? `Đổi giá phòng (tự nhập): ${newRoomAmount.toLocaleString('vi-VN')}đ`
        : Array.isArray(customBreakdown) && customBreakdown.length > 0
          ? `Sửa giá thủ công từng dòng: ${newRoomAmount.toLocaleString('vi-VN')}đ (${customBreakdown.length} dòng)`
          : `Đổi chính sách giá → "${booking.policyName}" (${newRoomAmount.toLocaleString('vi-VN')}đ)`,
      user: req.user, branchId: booking.branchId,
      metadata: { policyId, policyName: booking.policyName, customRoomAmount, customBreakdownLen: customBreakdown?.length ?? 0, newRoomAmount, totalAmount: booking.totalAmount },
    })

    res.json({ success: true, message: 'Đã đổi giá phòng', data: { booking } })
  } catch (err) {
    console.error('[changePolicy] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

// ── CHECK-IN ──────────────────────────────────────────
const checkin = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (!['confirmed', 'reserved'].includes(booking.status))
      return res.status(400).json({ success: false, message: `Không thể check-in từ trạng thái: ${booking.status}` })

    const now = new Date()

    // ⭐ Logic check-in:
    //   - Quy ước: cho check-in bất kỳ lúc nào nếu không overlap với booking khác
    //   - Khoảng kiểm tra: [now hoặc booking.checkIn (chọn sớm hơn), booking.checkOut]
    //     → Vì khách sẽ thực sự ở phòng từ giờ check-in đến giờ trả
    //   - Nếu overlap → block
    //   - Nếu không overlap → cho check-in, set actualCheckIn = now
    const intervalStart = now < booking.checkIn ? now : booking.checkIn
    const intervalEnd   = booking.checkOut

    const checkConflictForCheckin = async (roomId, roomLabel) => {
      const conflictResult = await findOverlapForNewBooking({
        roomId,
        intervalStart,
        intervalEnd,
        excludeBookingIds: [booking._id],
      })
      if (conflictResult) {
        const { conflict, conflictStart, conflictEnd, conflictStatus } = conflictResult
        const statusLabel = {
          reserved:   'đã đặt',
          confirmed:  'đã xác nhận',
          checked_in: 'đang ở',
        }[conflictStatus] ?? conflictStatus
        return {
          success: false,
          code: 'CONFLICT_OVERLAP',
          message: `Không thể check-in${roomLabel ? ` phòng ${roomLabel}` : ''} vào lúc ${now.toLocaleString('vi-VN')} — phòng đang có khách (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}. Vui lòng đợi đến sau khi khách trên trả phòng hoặc đổi phòng khác.`,
          data: {
            conflictBookingId:    conflict._id,
            conflictCustomerName: conflict.customerName,
            conflictCheckIn:      conflictStart,
            conflictCheckOut:     conflictEnd,
            conflictStatus,
            attemptedCheckInAt:   now,
            bookingScheduledCheckIn: booking.checkIn,
          },
        }
      }
      return null
    }

    // Check tất cả phòng (đơn hoặc đoàn)
    const roomsToCheck = []
    if (Array.isArray(booking.rooms) && booking.rooms.length > 0) {
      for (const sr of booking.rooms) {
        if (['cancelled', 'checked_out'].includes(sr.status)) continue
        if (sr.roomId) roomsToCheck.push({
          id: String(sr.roomId._id ?? sr.roomId),
          number: sr.roomNumber,
        })
      }
    } else if (booking.roomId) {
      roomsToCheck.push({
        id: String(booking.roomId),
        number: booking.roomNumber,
      })
    }

    for (const r of roomsToCheck) {
      const err = await checkConflictForCheckin(r.id, roomsToCheck.length > 1 ? r.number : null)
      if (err) return res.status(400).json(err)
    }

    // ⭐ Quy ước: actualCheckIn = giờ thực tế khi bấm (kể cả check-in sớm)
    booking.status        = 'checked_in'
    booking.actualCheckIn = now

    if (Array.isArray(booking.rooms) && booking.rooms.length > 0) {
      for (const sr of booking.rooms) {
        if (sr.status === 'reserved' || sr.status === 'confirmed') {
          sr.status         = 'checked_in'
          sr.actualCheckIn  = now
        }
      }
    }
    await booking.save()

    const roomsToUpdate = []
    if (booking.roomId) roomsToUpdate.push(booking.roomId)
    if (Array.isArray(booking.rooms)) {
      for (const sr of booking.rooms) {
        if (!sr.roomId) continue
        const ridStr = String(sr.roomId._id ?? sr.roomId)
        const rootRid = booking.roomId ? String(booking.roomId._id ?? booking.roomId) : null
        if (ridStr === rootRid) continue
        roomsToUpdate.push(sr.roomId)
      }
    }

    if (roomsToUpdate.length > 0) {
      await Room.updateMany(
        { _id: { $in: roomsToUpdate } },
        {
          currentBookingId: booking._id,
          currentGuestName: booking.customerName,
        }
      )
    }

    const totalRooms = roomsToUpdate.length
    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'checkin',
      description: totalRooms > 1
        ? `Check-in đoàn ${booking.groupName || ''} (${totalRooms} phòng) cho ${booking.customerName}`
        : `Check-in phòng ${booking.roomNumber} cho ${booking.customerName}`,
      user: req.user, branchId: booking.branchId,
      metadata: { roomNumber: booking.roomNumber, customerName: booking.customerName, totalRooms },
    })

    res.json({
      success: true,
      message: totalRooms > 1 ? `Check-in đoàn (${totalRooms} phòng) thành công` : 'Check-in thành công',
      data: { booking },
    })
  } catch (err) { next(err) }
}

const checkinRoom = async (req, res, next) => {
  try {
    const { roomId } = req.body
    if (!roomId) return res.status(400).json({ success: false, message: 'Thiếu roomId' })

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

    if (!Array.isArray(booking.rooms) || booking.rooms.length === 0) {
      return res.status(400).json({ success: false, message: 'Booking này không phải đoàn — dùng /checkin' })
    }

    const sub = booking.rooms.find(r => String(r.roomId._id ?? r.roomId) === String(roomId))
    if (!sub) return res.status(404).json({ success: false, message: 'Không tìm thấy phòng trong đoàn' })

    if (!['reserved', 'confirmed'].includes(sub.status)) {
      return res.status(400).json({ success: false, message: `Phòng này không thể check-in từ trạng thái: ${sub.status}` })
    }

    const now = new Date()

    // ⭐ Logic check-in lẻ: tương tự checkin
    //    Khoảng kiểm tra: [now hoặc sub.checkIn (chọn sớm hơn), sub.checkOut]
    const subCheckIn  = sub.checkIn  ?? booking.checkIn
    const subCheckOut = sub.checkOut ?? booking.checkOut
    const intervalStart = now < subCheckIn ? now : subCheckIn
    const intervalEnd   = subCheckOut

    const conflictResult = await findOverlapForNewBooking({
      roomId:        String(sub.roomId._id ?? sub.roomId),
      intervalStart,
      intervalEnd,
      excludeBookingIds: [booking._id],
    })
    if (conflictResult) {
      const { conflict, conflictStart, conflictEnd, conflictStatus } = conflictResult
      const statusLabel = {
        reserved:   'đã đặt',
        confirmed:  'đã xác nhận',
        checked_in: 'đang ở',
      }[conflictStatus] ?? conflictStatus
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_OVERLAP',
        message: `Không thể check-in phòng ${sub.roomNumber} vào lúc ${now.toLocaleString('vi-VN')} — phòng đang có khách (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}.`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          conflictCheckOut:     conflictEnd,
          conflictStatus,
          attemptedCheckInAt:   now,
          bookingScheduledCheckIn: subCheckIn,
        },
      })
    }

    // ⭐ Quy ước: actualCheckIn = now (kể cả check-in sớm)
    sub.status        = 'checked_in'
    sub.actualCheckIn = now

    const anyCheckedIn = booking.rooms.some(r => r.status === 'checked_in')
    if (anyCheckedIn && booking.status !== 'checked_in') {
      booking.status        = 'checked_in'
      booking.actualCheckIn = booking.actualCheckIn ?? now
    }

    await booking.save()

    await Room.findByIdAndUpdate(roomId, {
      currentBookingId: booking._id,
      currentGuestName: booking.customerName,
    })

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'checkin_room',
      description: `Check-in lẻ phòng ${sub.roomNumber} (đoàn ${booking.groupName || ''}) cho ${booking.customerName}`,
      user: req.user, branchId: booking.branchId,
      metadata: { roomNumber: sub.roomNumber, customerName: booking.customerName },
    })

    res.json({
      success: true,
      message: `Check-in phòng ${sub.roomNumber} thành công`,
      data: { booking, subRoom: sub },
    })
  } catch (err) { next(err) }
}

// ════════════════════════════════════════════════════════════════════════════
// ⭐ CHECKOUT — ĐÃ FIX TRIỆT ĐỂ
// ════════════════════════════════════════════════════════════════════════════
const checkout = async (req, res, next) => {
  try {
    const { actualCheckOut } = req.body
    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (booking.status !== 'checked_in')
      return res.status(400).json({ success: false, message: `Không thể check-out từ trạng thái: ${booking.status}` })

    const actualCO = actualCheckOut ? new Date(actualCheckOut) : new Date()

    // Guard quyền checkout với giờ quá khứ
    if (actualCheckOut) {
      const now = new Date()
      if (actualCO.getTime() < now.getTime() - 60000) {
        const perm = await canSetPastTime(req.user, booking._id, null)
        if (!perm.canSetPast) {
          return res.status(403).json({
            success: false,
            code:    'FORBIDDEN_PAST_CHECKOUT',
            message: perm.reason,
            data: { userRole: req.user?.role ?? null, actualCheckOut },
          })
        }
      }
    }

    const refCheckIn = booking.actualCheckIn ?? booking.checkIn
    if (refCheckIn && actualCO < new Date(refCheckIn)) {
      return res.status(400).json({
        success: false,
        message: `Giờ trả phòng (${new Date(actualCO).toLocaleString('vi-VN')}) phải sau giờ nhận phòng (${new Date(refCheckIn).toLocaleString('vi-VN')})`,
      })
    }

    // ⭐ FIX: Conflict check chuẩn — chỉ block khi 2 booking THẬT SỰ overlap
    const conflictResult = await findActiveConflictForRoom({
      bookingId:      booking._id,
      roomId:         booking.roomId,
      intervalStart:  refCheckIn,
      intervalEnd:    actualCO,
    })

    if (conflictResult) {
      const { conflict, conflictStart } = conflictResult
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_NEW_BOOKING',
        message: `Phòng ${booking.roomNumber} đã có booking khác (${conflict.customerName}) nhận phòng lúc ${new Date(conflictStart).toLocaleString('vi-VN')}. Giờ trả phòng phải trước thời điểm này.`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          requestedCheckOut:    actualCO,
        },
      })
    }

    const hasCustomPriceItems = (booking.priceBreakdown ?? []).some(b => b.meta?.customPrice === true)
    const checkOutDiffMin = Math.abs((actualCO - booking.checkOut) / 60000)

    if (checkOutDiffMin > 1 && hasCustomPriceItems) {
      try {
        const parseRange = (b) => {
          if (b.meta?.startTime && b.meta?.endTime) {
            return { start: new Date(b.meta.startTime), end: new Date(b.meta.endTime) }
          }
          const label = String(b.label ?? '')
          const m = label.match(/\((\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})\)/)
          if (!m) return null
          const [, sd, sm, sh, smi, ed, em, eh, emi] = m
          const refDate = booking.checkIn ?? booking.actualCheckIn ?? new Date()
          const year = new Date(refDate).getFullYear()
          return {
            start: new Date(year, +sm - 1, +sd, +sh, +smi),
            end:   new Date(year, +em - 1, +ed, +eh, +emi),
          }
        }

        let nightsToCharge = 0
        const baseItems = (booking.priceBreakdown ?? []).filter(b => b.type === 'base')
        for (const b of baseItems) {
          const range = parseRange(b)
          if (!range) { nightsToCharge++; continue }
          if (actualCO >= range.end) {
            nightsToCharge++
          } else if (actualCO >= range.start) {
            nightsToCharge++
            break
          } else {
            const effCheckIn = booking.actualCheckIn ?? booking.checkIn
            if (effCheckIn && actualCO >= effCheckIn && nightsToCharge === 0) {
              nightsToCharge++
            }
            break
          }
        }

        const newBreakdown = []
        let baseCount = 0
        for (const b of (booking.priceBreakdown ?? [])) {
          if (b.type === 'base') {
            if (baseCount < nightsToCharge) {
              newBreakdown.push(b)
              baseCount++
            }
          } else {
            newBreakdown.push(b)
          }
        }

        const newRoomAmount = newBreakdown.reduce((s, b) => s + (b.amount ?? 0), 0)

        let recalcDiscount = booking.discount ?? 0
        if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
          const roomPart = booking.isFreeRoom ? 0 : newRoomAmount
          const subtotal = roomPart + (booking.servicesAmount ?? 0)
          const pctDiscount = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
          recalcDiscount = pctDiscount + (booking.discountAmount ?? 0)
        }

        const roomPart = booking.isFreeRoom ? 0 : newRoomAmount
        booking.roomAmount     = newRoomAmount
        booking.nights         = nightsToCharge || booking.nights
        booking.priceBreakdown = newBreakdown
        booking.discount       = recalcDiscount
        booking.totalAmount    = Math.max(0, roomPart + (booking.servicesAmount ?? 0) - recalcDiscount + (booking.transferFee || 0))
      } catch (calcErr) {
        console.error('Recalc custom price on checkout failed:', calcErr)
      }
    } else if (checkOutDiffMin > 1 && !hasCustomPriceItems) {
      try {
        const room   = await Room.findById(booking.roomId).populate('typeId')
        const branch = await Branch.findById(booking.branchId)
        const policy = booking.policyId ? await PricePolicy.findById(booking.policyId) : null
        const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
        const maxChildren = room?.typeId?.maxChildren ?? 0

        const priceResult = calculatePrice({
          checkIn:   booking.actualCheckIn ?? booking.checkIn,
          checkOut:  actualCO,
          priceType: booking.priceType,
          policy, branch,
          adults:    booking.adults,
          children:  booking.children,
          maxAdults, maxChildren,
        })

        if (priceResult.error) {
          console.warn('[checkout] Recalc skipped due to policy mismatch:', priceResult.error.message)
        } else {
          let recalcDiscount = booking.discount ?? 0
          if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
            const roomPart = booking.isFreeRoom ? 0 : priceResult.roomAmount
            const subtotal = roomPart + (booking.servicesAmount ?? 0)
            const pctDiscount = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
            recalcDiscount = pctDiscount + (booking.discountAmount ?? 0)
          }

          const roomPart = booking.isFreeRoom ? 0 : priceResult.roomAmount
          booking.roomAmount     = priceResult.roomAmount
          booking.nights         = priceResult.nights
          booking.priceBreakdown = priceResult.breakdown
          booking.discount       = recalcDiscount
          booking.totalAmount    = Math.max(0, roomPart + (booking.servicesAmount ?? 0) - recalcDiscount)
        }
      } catch (calcErr) {
        console.error('Recalc on checkout failed:', calcErr)
      }
    }

    // Recalc TẤT CẢ sub-rooms (group booking)
    if (Array.isArray(booking.rooms) && booking.rooms.length > 0) {
      try {
        const branch = await Branch.findById(booking.branchId)
        let groupRoomTotal = 0

        for (const sub of booking.rooms) {
          if (sub.status === 'checked_out' || sub.status === 'cancelled') {
            groupRoomTotal += sub.roomAmount ?? 0
            continue
          }

          const room   = await Room.findById(sub.roomId).populate('typeId')
          const policy = sub.policyId ? await PricePolicy.findById(sub.policyId) : null
          const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
          const maxChildren = room?.typeId?.maxChildren ?? 0

          const existingItems = Array.isArray(sub.priceBreakdown) ? sub.priceBreakdown : []
          const seg1Items = []
          let splitFromTime = null
          for (const b of existingItems) {
            const item = (b && typeof b.toObject === 'function') ? b.toObject() : b
            const isSeg1 = item?.meta?.segment === 1 ||
                           (item?.meta?.roomNumber && String(item.meta.roomNumber) !== String(sub.roomNumber))
            if (isSeg1) {
              seg1Items.push(item)
              if (item?.meta?.endTime) splitFromTime = item.meta.endTime
            }
          }

          let subPriceResult
          if (seg1Items.length > 0) {
            const splitAt = splitFromTime ? new Date(splitFromTime) : (sub.actualCheckIn ?? sub.checkIn ?? booking.checkIn)
            const seg2Result = calculatePrice({
              checkIn:   splitAt,
              checkOut:  actualCO,
              priceType: sub.priceType ?? booking.priceType,
              policy, branch,
              adults:    sub.adults   ?? booking.adults,
              children:  sub.children ?? booking.children,
              maxAdults, maxChildren,
            })
            const filteredSeg2 = (seg2Result.breakdown ?? []).filter(b => {
              const label = String(b.label || '')
              return !label.includes('Nhận phòng sớm') && !label.includes('early_checkin')
            })
            const seg1Amount = seg1Items.reduce((s, b) => s + Number(b.amount ?? 0), 0)
            const seg2Amount = filteredSeg2.reduce((s, b) => s + Number(b.amount ?? 0), 0)

            subPriceResult = {
              roomAmount: seg1Amount + seg2Amount,
              nights:     seg2Result.nights ?? sub.nights,
              breakdown:  [
                ...seg1Items,
                ...filteredSeg2.map(b => ({
                  ...b,
                  meta: { ...(b.meta || {}), segment: 2, roomNumber: sub.roomNumber },
                })),
              ],
            }
          } else {
            subPriceResult = calculatePrice({
              checkIn:   sub.actualCheckIn ?? sub.checkIn ?? booking.checkIn,
              checkOut:  actualCO,
              priceType: sub.priceType ?? booking.priceType,
              policy, branch,
              adults:    sub.adults   ?? booking.adults,
              children:  sub.children ?? booking.children,
              maxAdults, maxChildren,
            })

            if (subPriceResult.error) {
              console.warn(`[checkout][group] Recalc skipped for room ${sub.roomNumber}:`, subPriceResult.error.message)
              groupRoomTotal += sub.roomAmount ?? 0
              continue
            }
          }

          sub.roomAmount     = subPriceResult.roomAmount
          sub.nights         = subPriceResult.nights
          sub.priceBreakdown = (subPriceResult.breakdown ?? []).map(b => {
            const labelStr = String(b.label ?? '').replace(/^\[[^\]]+\]\s*/, '')
            return {
              label:  `[${sub.roomNumber}] ${labelStr}`,
              amount: Number(b.amount ?? 0),
              type:   b.type === 'surcharge' ? 'surcharge' : 'base',
              meta:   { ...(b.meta || {}), roomNumber: sub.roomNumber },
            }
          })

          groupRoomTotal += sub.roomAmount
        }

        booking.roomAmount = groupRoomTotal
        const subtotal = groupRoomTotal + (booking.servicesAmount ?? 0)
        const pctDisc  = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
        booking.discount    = pctDisc + (booking.discountAmount ?? 0)
        booking.totalAmount = Math.max(0, subtotal - booking.discount)
      } catch (groupErr) {
        console.error('[checkout][group] Recalc failed:', groupErr)
      }
    }

    const existingInvoice = await Invoice.findOne({ bookingId: booking._id })
    const newTotal = booking.totalAmount ?? 0
    const invPaid  = existingInvoice?.paidAmount ?? 0
    const owed = newTotal - invPaid
    if (owed > 0) {
      return res.status(400).json({
        success: false,
        message: `Không thể trả phòng — khách còn nợ ${owed.toLocaleString('vi-VN')} VND. Vui lòng thu đủ tiền trước.`,
        code: 'PAYMENT_REQUIRED',
        data: { remaining: owed, totalAmount: newTotal, paidAmount: invPaid },
      })
    }

    booking.status         = 'checked_out'
    booking.actualCheckOut = actualCO

    if (Array.isArray(booking.rooms) && booking.rooms.length > 0) {
      for (const sr of booking.rooms) {
        if (sr.status === 'checked_in' || sr.status === 'reserved') {
          sr.status         = 'checked_out'
          sr.actualCheckOut = actualCO
        }
      }
    }

    {
      const invForStatus = await Invoice.findOne({ bookingId: booking._id })
      const paid = invForStatus?.paidAmount ?? 0
      booking.paymentStatus = paid >= booking.totalAmount ? 'paid' :
                              paid > 0 ? 'partial' : 'unpaid'
    }

    await booking.save()

    const roomIdsToCleaning = []
    if (booking.roomId) roomIdsToCleaning.push(booking.roomId)
    if (Array.isArray(booking.rooms)) {
      for (const sr of booking.rooms) {
        if (!sr.roomId) continue
        const ridStr = String(sr.roomId._id ?? sr.roomId)
        const rootRid = booking.roomId ? String(booking.roomId._id ?? booking.roomId) : null
        if (ridStr === rootRid) continue
        roomIdsToCleaning.push(sr.roomId)
      }
    }

    if (roomIdsToCleaning.length > 0) {
      await Room.updateMany(
        { _id: { $in: roomIdsToCleaning } },
        {
          currentBookingId: null,
          currentGuestName: null,
          roomStatus:       'inactive',
        }
      )
    }

    let invoice = await Invoice.findOne({ bookingId: booking._id })
    const newItems = buildInvoiceItemsFromBooking(booking)

    if (!invoice) {
      invoice = await Invoice.create({
        bookingId:       booking._id,
        customerId:      booking.customerId,
        customerName:    booking.customerName,
        roomNumber:      booking.roomNumber,
        roomAmount:      booking.roomAmount,
        servicesAmount:  booking.servicesAmount ?? 0,
        discount:        booking.discount ?? 0,
        totalAmount:     booking.totalAmount,
        remainingAmount: booking.totalAmount,
        issuedBy:        req.user?.id,
        items:           newItems,
        branchId:        booking.branchId,
      })
    } else {
      invoice.roomAmount      = booking.roomAmount
      invoice.servicesAmount  = booking.servicesAmount ?? 0
      invoice.discount        = booking.discount ?? 0
      invoice.totalAmount     = booking.totalAmount
      invoice.remainingAmount = Math.max(0, booking.totalAmount - (invoice.paidAmount ?? 0))
      invoice.paymentStatus   = invoice.paidAmount >= booking.totalAmount ? 'paid' :
                                invoice.paidAmount > 0 ? 'partial' : 'unpaid'
      invoice.items   = newItems
      if (!invoice.branchId && booking.branchId) invoice.branchId = booking.branchId
      await invoice.save()
    }

    await Customer.findByIdAndUpdate(booking.customerId, {
      $inc: { totalVisits: 1, totalSpent: booking.totalAmount },
    })

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'checkout',
      description: `Trả phòng ${booking.roomNumber} — ${booking.customerName} (${booking.totalAmount.toLocaleString('vi-VN')}đ)`,
      user: req.user, branchId: booking.branchId,
      metadata: {
        roomNumber: booking.roomNumber, customerName: booking.customerName,
        actualCheckOut: actualCO, totalAmount: booking.totalAmount, nights: booking.nights,
      },
    })

    res.json({ success: true, message: 'Check-out thành công', data: { booking, invoice } })
  } catch (err) { next(err) }
}

// ════════════════════════════════════════════════════════════════════════════
// ⭐ CHECKOUT ROOM — ĐÃ FIX TRIỆT ĐỂ
// ════════════════════════════════════════════════════════════════════════════
const checkoutRoom = async (req, res, next) => {
  try {
    const { roomId, actualCheckOut, skipPayment = false } = req.body
    if (!roomId) return res.status(400).json({ success: false, message: 'Thiếu roomId' })

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

    if (!Array.isArray(booking.rooms) || booking.rooms.length === 0) {
      return res.status(400).json({ success: false, message: 'Booking này không phải đoàn — dùng /checkout' })
    }

    const sub = booking.rooms.find(r => String(r.roomId._id ?? r.roomId) === String(roomId))
    if (!sub) return res.status(404).json({ success: false, message: 'Không tìm thấy phòng trong đoàn' })

    if (sub.status !== 'checked_in') {
      return res.status(400).json({ success: false, message: `Phòng này không thể check-out từ trạng thái: ${sub.status}` })
    }

    const actualCO = actualCheckOut ? new Date(actualCheckOut) : new Date()

    if (actualCheckOut) {
      const now = new Date()
      if (actualCO.getTime() < now.getTime() - 60000) {
        const perm = await canSetPastTime(req.user, booking._id, sub.roomNumber)
        if (!perm.canSetPast) {
          return res.status(403).json({
            success: false,
            code:    'FORBIDDEN_PAST_CHECKOUT',
            message: perm.reason,
            data: {
              userRole: req.user?.role ?? null,
              actualCheckOut,
              roomNumber: sub.roomNumber,
            },
          })
        }
      }
    }

    const refCheckIn = sub.actualCheckIn ?? sub.checkIn ?? booking.actualCheckIn ?? booking.checkIn
    if (refCheckIn && actualCO < new Date(refCheckIn)) {
      return res.status(400).json({
        success: false,
        message: `Giờ trả phòng (${new Date(actualCO).toLocaleString('vi-VN')}) phải sau giờ nhận phòng (${new Date(refCheckIn).toLocaleString('vi-VN')})`,
      })
    }

    // ⭐ FIX: Conflict check chuẩn cho per-room
    const subRoomId = String(sub.roomId?._id ?? sub.roomId)
    const conflictResult = await findActiveConflictForRoom({
      bookingId:      booking._id,
      roomId:         subRoomId,
      intervalStart:  refCheckIn,
      intervalEnd:    actualCO,
    })

    if (conflictResult) {
      const { conflict, conflictStart } = conflictResult
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_NEW_BOOKING',
        message: `Phòng ${sub.roomNumber} đã có booking khác (${conflict.customerName}) nhận phòng lúc ${new Date(conflictStart).toLocaleString('vi-VN')}. Giờ trả phòng phải trước thời điểm này.`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          requestedCheckOut:    actualCO,
        },
      })
    }

    const checkOutDiffMin = Math.abs((actualCO - booking.checkOut) / 60000)
    if (checkOutDiffMin > 1) {
      try {
        const room   = await Room.findById(sub.roomId).populate('typeId')
        const branch = await Branch.findById(booking.branchId)
        const policy = sub.policyId ? await PricePolicy.findById(sub.policyId) : null
        const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
        const maxChildren = room?.typeId?.maxChildren ?? 0

        const priceResult = calculatePrice({
          checkIn:   sub.actualCheckIn ?? sub.checkIn ?? booking.checkIn,
          checkOut:  actualCO,
          priceType: sub.priceType ?? booking.priceType,
          policy, branch,
          adults:    sub.adults   ?? booking.adults,
          children:  sub.children ?? booking.children,
          maxAdults, maxChildren,
        })

        if (priceResult.error) {
          console.warn('[checkoutRoom] Recalc skipped due to policy mismatch:', priceResult.error.message)
        } else {
          const existingItems = Array.isArray(sub.priceBreakdown) ? sub.priceBreakdown : []
          const seg1Items = []
          let splitFromTime = null
          for (const b of existingItems) {
            const item = (b && typeof b.toObject === 'function') ? b.toObject() : b
            const isSeg1 = item?.meta?.segment === 1 ||
                           (item?.meta?.roomNumber && String(item.meta.roomNumber) !== String(sub.roomNumber))
            if (isSeg1) {
              seg1Items.push(item)
              if (item?.meta?.endTime) splitFromTime = item.meta.endTime
            }
          }

          if (seg1Items.length > 0) {
            const splitAt = splitFromTime ? new Date(splitFromTime) : (sub.actualCheckIn ?? sub.checkIn ?? booking.checkIn)
            const seg2Result = calculatePrice({
              checkIn:   splitAt,
              checkOut:  actualCO,
              priceType: sub.priceType ?? booking.priceType,
              policy, branch,
              adults:    sub.adults   ?? booking.adults,
              children:  sub.children ?? booking.children,
              maxAdults, maxChildren,
            })
            const filteredSeg2 = (seg2Result.breakdown ?? []).filter(b => {
              const label = String(b.label || '')
              return !label.includes('Nhận phòng sớm') && !label.includes('early_checkin')
            })
            const seg1Amount = seg1Items.reduce((s, b) => s + Number(b.amount ?? 0), 0)
            const seg2Amount = filteredSeg2.reduce((s, b) => s + Number(b.amount ?? 0), 0)
            const seg2Items  = filteredSeg2.map(b => ({
              label:  String(b.label ?? '').replace(/^\[[^\]]+\]\s*/, ''),
              amount: Number(b.amount ?? 0),
              type:   b.type === 'surcharge' ? 'surcharge' : 'base',
              meta:   { ...(b.meta || {}), segment: 2, roomNumber: sub.roomNumber },
            })).map(item => ({
              ...item,
              label: `[${sub.roomNumber}] ${item.label}`,
            }))

            sub.roomAmount     = seg1Amount + seg2Amount
            sub.priceBreakdown = [...seg1Items, ...seg2Items]
          } else {
            sub.roomAmount      = priceResult.roomAmount
            sub.priceBreakdown  = (priceResult.breakdown ?? []).map(b => ({
              label:  String(b.label ?? ''),
              amount: Number(b.amount ?? 0),
              type:   b.type === 'surcharge' ? 'surcharge' : 'base',
              meta:   { ...(b.meta || {}), roomNumber: sub.roomNumber },
            }))
          }
        }
      } catch (calcErr) {
        console.error('Recalc on checkoutRoom failed:', calcErr)
      }
    }

    sub.actualCheckOut = actualCO

    const totalRoomsAmountPre = booking.rooms.reduce((sum, r) => sum + (r.roomAmount ?? 0), 0)
    const subtotalPre = totalRoomsAmountPre + (booking.servicesAmount ?? 0)
    const pctDiscPre = Math.round(subtotalPre * (booking.discountPercent ?? 0) / 100)
    const totalDiscPre = pctDiscPre + (booking.discountAmount ?? 0)
    const newTotalAmount = Math.max(0, subtotalPre - totalDiscPre)

    const otherCheckedIn = booking.rooms.filter(r =>
      r !== sub && r.status === 'checked_in'
    )
    const isLastRoom = otherCheckedIn.length === 0

    const invoicePre   = await Invoice.findOne({ bookingId: booking._id })
    const invoicePaid  = invoicePre?.paidAmount ?? 0
    const invoiceRemaining = Math.max(0, newTotalAmount - invoicePaid)

    if (isLastRoom) {
      if (invoiceRemaining > 0) {
        return res.status(400).json({
          success: false,
          message: `Đây là phòng cuối của đoàn — đoàn còn nợ ${invoiceRemaining.toLocaleString('vi-VN')} VND. Vui lòng thu đủ trước khi trả phòng cuối.`,
          code: 'PAYMENT_REQUIRED',
          data: { remaining: invoiceRemaining, totalAmount: newTotalAmount, paidAmount: invoicePaid },
        })
      }
    } else {
      const subTotalAmount     = (sub.roomAmount ?? 0) + (sub.servicesAmount ?? 0) - (sub.discountAmount ?? 0)
      const subPaidAmount      = sub.paidAmount ?? 0
      const subRemainingAmount = Math.max(0, subTotalAmount - subPaidAmount)

      if (subRemainingAmount > 0 && !skipPayment) {
        return res.status(400).json({
          success: false,
          message: `Phòng ${sub.roomNumber} còn nợ ${subRemainingAmount.toLocaleString('vi-VN')} VND. Vui lòng thanh toán đủ tiền phòng này trước khi trả.`,
          code: 'PAYMENT_REQUIRED_FOR_ROOM',
          data: {
            roomId:           String(sub.roomId?._id ?? sub.roomId),
            roomNumber:       sub.roomNumber,
            subTotalAmount,
            subPaidAmount,
            subRemainingAmount,
          },
        })
      }
    }

    sub.status = 'checked_out'

    const totalRoomsAmount = booking.rooms.reduce((sum, r) => sum + (r.roomAmount ?? 0), 0)
    booking.roomAmount  = totalRoomsAmount
    const subtotal = totalRoomsAmount + (booking.servicesAmount ?? 0)
    const pctDisc  = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
    const totalDiscount = pctDisc + (booking.discountAmount ?? 0)
    booking.discount    = totalDiscount
    booking.totalAmount = Math.max(0, subtotal - totalDiscount)

    const allCheckedOut = booking.rooms.every(r => r.status === 'checked_out' || r.status === 'cancelled')

    let invoice = await Invoice.findOne({ bookingId: booking._id })
    const paidAmount = invoice?.paidAmount ?? 0
    const remaining  = Math.max(0, booking.totalAmount - paidAmount)

    if (allCheckedOut && remaining > 0) {
      return res.status(400).json({
        success: false,
        message: `Đoàn còn nợ ${remaining.toLocaleString('vi-VN')} VND. Vui lòng thu đủ trước khi finalize.`,
        code: 'PAYMENT_REQUIRED',
        data: { remaining, totalAmount: booking.totalAmount, paidAmount },
      })
    }

    if (allCheckedOut) {
      booking.status         = 'checked_out'
      booking.actualCheckOut = actualCO
    }

    booking.paymentStatus = paidAmount >= booking.totalAmount ? 'paid' :
                            paidAmount > 0 ? 'partial' : 'unpaid'

    await booking.save()

    if (invoice) {
      invoice.roomAmount      = booking.roomAmount
      invoice.servicesAmount  = booking.servicesAmount ?? 0
      invoice.discount        = booking.discount ?? 0
      invoice.totalAmount     = booking.totalAmount
      invoice.remainingAmount = Math.max(0, booking.totalAmount - paidAmount)
      invoice.paymentStatus   = paidAmount >= booking.totalAmount ? 'paid' :
                                paidAmount > 0 ? 'partial' : 'unpaid'
      invoice.items   = buildInvoiceItemsFromBooking(booking)
      if (!invoice.branchId && booking.branchId) invoice.branchId = booking.branchId
      await invoice.save()
    } else if (allCheckedOut) {
      invoice = await Invoice.create({
        bookingId:       booking._id,
        customerId:      booking.customerId,
        customerName:    booking.customerName,
        roomNumber:      booking.roomNumber,
        roomAmount:      booking.roomAmount,
        servicesAmount:  booking.servicesAmount ?? 0,
        discount:        booking.discount ?? 0,
        totalAmount:     booking.totalAmount,
        remainingAmount: Math.max(0, booking.totalAmount - paidAmount),
        paidAmount:      paidAmount,
        issuedBy:        req.user?.id,
        items:           buildInvoiceItemsFromBooking(booking),
        branchId:        booking.branchId,
      })
    }

    await Room.findByIdAndUpdate(roomId, {
      currentBookingId: null,
      currentGuestName: null,
      roomStatus:       'inactive',
    })

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'checkout_room',
      description: `Trả lẻ phòng ${sub.roomNumber} (đoàn ${booking.groupName || ''}) — ${booking.customerName}`,
      user: req.user, branchId: booking.branchId,
      metadata: { roomNumber: sub.roomNumber, customerName: booking.customerName, actualCheckOut: actualCO, allCheckedOut },
    })

    res.json({
      success: true,
      message: allCheckedOut
        ? `Đã trả phòng cuối — đoàn đã hoàn tất`
        : `Trả phòng ${sub.roomNumber} thành công (còn ${booking.rooms.filter(r => r.status === 'checked_in').length} phòng đang ở)`,
      data: { booking, subRoom: sub, allCheckedOut, remaining: Math.max(0, booking.totalAmount - paidAmount) },
    })
  } catch (err) { next(err) }
}

const cancel = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (['checked_out', 'cancelled'].includes(booking.status))
      return res.status(400).json({ success: false, message: `Không thể huỷ từ trạng thái: ${booking.status}` })

    const prevStatus     = booking.status
    booking.status       = 'cancelled'
    booking.cancelReason = req.body.reason ?? ''
    booking.cancelledAt  = new Date()
    booking.cancelledBy  = req.user?.id
    await booking.save()

    if (['reserved', 'confirmed', 'checked_in'].includes(prevStatus)) {
      await Room.findByIdAndUpdate(booking.roomId, {
        currentBookingId: null,
        currentGuestName: null,
      })
    }

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'cancel',
      description: `Huỷ đặt phòng ${booking.roomNumber} — ${booking.customerName}${req.body.reason ? ` (${req.body.reason})` : ''}`,
      user: req.user, branchId: booking.branchId,
      metadata: { reason: req.body.reason, prevStatus, roomNumber: booking.roomNumber },
    })

    res.json({ success: true, message: 'Đã huỷ đặt phòng', data: { booking } })
  } catch (err) { next(err) }
}

const undo = async (req, res, next) => {
  try {
    const perm = checkUndoPermission(req.user)
    if (!perm.ok) {
      return res.status(perm.status).json({
        success: false,
        code:    perm.code,
        message: perm.message,
      })
    }

    const { reason } = req.body
    if (!reason) return res.status(400).json({ success: false, message: 'Cần nhập lý do hoàn tác' })

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

    let newStatus
    if (booking.status === 'checked_in')       newStatus = 'reserved'
    else if (booking.status === 'checked_out') newStatus = 'checked_in'
    else return res.status(400).json({ success: false, message: 'Chỉ hoàn tác được checked_in hoặc checked_out' })

    const wasCheckedOut = booking.status === 'checked_out'
    if (wasCheckedOut) {
      booking.actualCheckOut = null
    }

    booking.status     = newStatus
    booking.undoReason = reason
    await booking.save()

    const roomUpdate = {
      currentBookingId: booking._id,
      currentGuestName: booking.customerName,
    }
    if (wasCheckedOut) {
      roomUpdate.roomStatus = 'active'
    }
    await Room.findByIdAndUpdate(booking.roomId, roomUpdate)

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'undo',
      description: `Hoàn tác (${reason})`,
      user: req.user, branchId: booking.branchId,
      metadata: {
        reason, newStatus, roomNumber: booking.roomNumber,
        actorRole: req.user.role,
      },
    })

    res.json({ success: true, message: 'Hoàn tác thành công', data: { booking } })
  } catch (err) { next(err) }
}

const undoRoom = async (req, res, next) => {
  try {
    const perm = checkUndoPermission(req.user)
    if (!perm.ok) {
      return res.status(perm.status).json({
        success: false,
        code:    perm.code,
        message: perm.message,
      })
    }

    const { roomId, reason } = req.body
    if (!reason) return res.status(400).json({ success: false, message: 'Cần nhập lý do hoàn tác' })
    if (!roomId)  return res.status(400).json({ success: false, message: 'Thiếu roomId' })

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (!Array.isArray(booking.rooms) || booking.rooms.length === 0) {
      return res.status(400).json({ success: false, message: 'Không phải booking đoàn — dùng /undo' })
    }

    const sub = booking.rooms.find(r => String(r.roomId?._id ?? r.roomId) === String(roomId))
    if (!sub) return res.status(404).json({ success: false, message: 'Không tìm thấy phòng trong đoàn' })

    let newSubStatus
    let prevStatus = sub.status
    if (sub.status === 'checked_in')       newSubStatus = 'reserved'
    else if (sub.status === 'checked_out') newSubStatus = 'checked_in'
    else return res.status(400).json({ success: false, message: `Chỉ hoàn tác được checked_in/checked_out (hiện tại: ${sub.status})` })

    const wasCheckedOut = sub.status === 'checked_out'

    sub.status = newSubStatus
    if (wasCheckedOut) {
      sub.actualCheckOut = null
    }

    const allCheckedOut = booking.rooms.every(r => r.status === 'checked_out' || r.status === 'cancelled')
    const anyCheckedIn  = booking.rooms.some(r => r.status === 'checked_in')

    if (anyCheckedIn) {
      booking.status = 'checked_in'
      booking.actualCheckOut = null
    } else if (allCheckedOut) {
      booking.status = 'checked_out'
    } else {
      booking.status = 'reserved'
    }

    booking.undoReason = reason
    await booking.save()

    const roomUpdate = {
      currentBookingId: booking._id,
      currentGuestName: booking.customerName,
    }
    if (wasCheckedOut) {
      roomUpdate.roomStatus = 'active'
    }
    await Room.findByIdAndUpdate(sub.roomId, roomUpdate)

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'undo',
      description: `Hoàn tác phòng ${sub.roomNumber}: ${prevStatus} → ${newSubStatus} (${reason})`,
      user: req.user, branchId: booking.branchId,
      metadata: {
        reason, roomId, roomNumber: sub.roomNumber, prevStatus, newSubStatus, bookingId: booking._id,
        actorRole: req.user.role,
      },
    })

    res.json({ success: true, message: `Đã hoàn tác phòng ${sub.roomNumber}`, data: { booking } })
  } catch (err) {
    console.error('[undoRoom] error:', err)
    next(err)
  }
}

const getAvailableByDate = async (req, res, next) => {
  try {
    const { checkIn, checkOut, branchId, excludeBookingId } = req.query
    if (!checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Cần truyền checkIn và checkOut' })

    const checkInDate  = new Date(checkIn)
    const checkOutDate = new Date(checkOut)
    if (checkOutDate <= checkInDate)
      return res.status(400).json({ success: false, message: 'checkOut phải sau checkIn' })

    const roomFilter = { roomStatus: { $ne: 'maintenance' } }
    if (branchId) roomFilter.branchId = branchId

    const allRooms = await Room.find(roomFilter).sort({ number: 1 })

    const conflictFilter = {
      roomId:   { $in: allRooms.map(r => r._id) },
      status:   { $in: ['confirmed', 'reserved', 'checked_in'] },
      checkIn:  { $lt: checkOutDate },
      checkOut: { $gt: checkInDate },
    }
    if (excludeBookingId) conflictFilter._id = { $ne: excludeBookingId }

    const conflictBookings = await Booking.find(conflictFilter)
    const conflictRoomIds = new Set()
    conflictBookings.forEach(b => {
      if (b.roomId) conflictRoomIds.add(b.roomId.toString())
      ;(b.rooms ?? []).forEach(r => {
        if (r.roomId && r.status !== 'checked_out' && r.status !== 'cancelled') {
          conflictRoomIds.add(r.roomId.toString())
        }
      })
    })
    const available = allRooms.filter(r => !conflictRoomIds.has(r._id.toString()))

    res.json({ success: true, data: { data: available, total: available.length } })
  } catch (err) { next(err) }
}

const applyDiscount = async (req, res, next) => {
  try {
    const { discountPercent = 0, discountAmount = 0, isFreeRoom = false } = req.body
    const pct = Math.max(0, Math.min(100, Number(discountPercent) || 0))
    const amt = Math.max(0, Number(discountAmount) || 0)
    const free = !!isFreeRoom

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

    const roomPart  = free ? 0 : (booking.roomAmount ?? 0)
    const subtotal  = roomPart + (booking.servicesAmount ?? 0)
    const pctDiscount = Math.round(subtotal * pct / 100)
    const totalDiscount = pctDiscount + amt

    booking.discountPercent = pct
    booking.discountAmount  = amt
    booking.isFreeRoom      = free
    booking.discount        = totalDiscount

    booking.totalAmount = roomPart + (booking.servicesAmount ?? 0) - totalDiscount
    if (booking.totalAmount < 0) booking.totalAmount = 0

    await booking.save()

    const invoice = await Invoice.findOne({ bookingId: booking._id })
    if (invoice) {
      invoice.discount        = totalDiscount
      invoice.totalAmount     = booking.totalAmount
      invoice.remainingAmount = Math.max(0, invoice.totalAmount - (invoice.paidAmount ?? 0))
      invoice.paymentStatus   = invoice.paidAmount >= invoice.totalAmount ? 'paid' :
                                invoice.paidAmount > 0 ? 'partial' : 'unpaid'
      await invoice.save()
    }

    const desc = []
    if (pct > 0) desc.push(`${pct}%`)
    if (amt > 0) desc.push(`${amt.toLocaleString('vi-VN')}đ`)
    if (free)    desc.push('Miễn phí phòng')
    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'apply_discount',
      description: `Áp dụng chiết khấu: ${desc.join(' + ') || 'không có'}`,
      user: req.user, branchId: booking.branchId,
      metadata: { discountPercent: pct, discountAmount: amt, isFreeRoom: free, totalDiscount, newTotal: booking.totalAmount },
    })

    res.json({ success: true, message: 'Đã áp dụng chiết khấu', data: { booking } })
  } catch (err) { next(err) }
}

const calculateBill = async (req, res, next) => {
  try {
    const { mode = 'checkout', roomId: filterRoomId = null, atTime = null } = req.body
    if (!['now', 'checkout'].includes(mode))
      return res.status(400).json({ success: false, message: 'mode phải là "now" hoặc "checkout"' })

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

    if (atTime) {
      const atTimeDate = new Date(atTime)
      const now = new Date()
      if (atTimeDate.getTime() < now.getTime() - 60000) {
        let roomNumberForAudit = null
        if (filterRoomId) {
          const sub = (booking.rooms ?? []).find(r =>
            String(r.roomId?._id ?? r.roomId) === String(filterRoomId)
          )
          if (sub) roomNumberForAudit = sub.roomNumber
        }
        const perm = await canSetPastTime(req.user, booking._id, roomNumberForAudit)
        if (!perm.canSetPast) {
          return res.status(403).json({
            success: false,
            code:    'FORBIDDEN_PAST_CHECKOUT',
            message: perm.reason,
            data: {
              userRole:   req.user?.role ?? null,
              atTime,
              roomNumber: roomNumberForAudit,
            },
          })
        }
      }
    }

    const branch = await Branch.findById(booking.branchId)

    const effectiveCheckIn = booking.actualCheckIn ?? booking.checkIn

    let effectiveCheckOut
    if (mode === 'now') {
      const refTime = atTime ? new Date(atTime) : new Date()
      effectiveCheckOut = refTime < effectiveCheckIn ? new Date(effectiveCheckIn.getTime() + 60000) : refTime
    } else {
      effectiveCheckOut = booking.checkOut
    }

    const isGroup = Array.isArray(booking.rooms) && booking.rooms.length > 1
    if (isGroup) {
      let totalRoomAmount = 0
      const allBreakdown = []
      const targetRooms = filterRoomId
        ? booking.rooms.filter(sr => String(sr.roomId?._id ?? sr.roomId) === String(filterRoomId))
        : booking.rooms

      let singleRoomPaid = 0

      for (const sr of targetRooms) {
        if (sr.status === 'cancelled') continue

        const room   = await Room.findById(sr.roomId).populate('typeId')
        const policy = sr.policyId ? await PricePolicy.findById(sr.policyId) : null
        const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
        const maxChildren = room?.typeId?.maxChildren ?? 0

        let subPriceResult
        if (sr.status === 'checked_out') {
          subPriceResult = {
            roomAmount: sr.roomAmount ?? 0,
            breakdown:  sr.priceBreakdown ?? [],
          }
        } else {
          const breakdownItems = Array.isArray(sr.priceBreakdown) ? sr.priceBreakdown : []
          const hasMoveSegments = breakdownItems.some(b =>
            b?.meta?.segment === 1 ||
            (b?.meta?.roomNumber && String(b.meta.roomNumber) !== String(sr.roomNumber))
          )

          if (hasMoveSegments && mode === 'now' && sr.status === 'checked_in') {
            const seg1Items = []
            let splitFromTime = null
            for (const b of breakdownItems) {
              const item = (b && typeof b.toObject === 'function') ? b.toObject() : b
              const isSeg1 = item?.meta?.segment === 1 ||
                             (item?.meta?.roomNumber && String(item.meta.roomNumber) !== String(sr.roomNumber))
              if (isSeg1) {
                seg1Items.push(item)
                if (item?.meta?.endTime) splitFromTime = item.meta.endTime
              }
            }
            const splitAt = splitFromTime ? new Date(splitFromTime) : (sr.actualCheckIn ?? booking.checkIn)
            const seg1Amount = seg1Items.reduce((s, b) => s + Number(b.amount ?? 0), 0)

            const seg2Result = calculatePrice({
              checkIn:   splitAt,
              checkOut:  effectiveCheckOut,
              priceType: sr.priceType ?? booking.priceType,
              policy, branch,
              adults:    sr.adults   ?? booking.adults,
              children:  sr.children ?? booking.children,
              maxAdults, maxChildren,
            })
            const filteredSeg2 = (seg2Result.breakdown ?? []).filter(b => {
              const label = String(b.label || '')
              return !label.includes('Nhận phòng sớm') && !label.includes('early_checkin')
            })
            const seg2Amount = filteredSeg2.reduce((s, b) => s + (b.amount ?? 0), 0)
            const seg2Items = filteredSeg2.map(b => ({
              ...b,
              meta: { ...(b.meta || {}), segment: 2, roomNumber: sr.roomNumber },
            }))

            subPriceResult = {
              roomAmount: seg1Amount + seg2Amount,
              breakdown:  [...seg1Items, ...seg2Items],
            }
          } else if (hasMoveSegments && mode === 'checkout') {
            const plainItems = breakdownItems.map(b =>
              (b && typeof b.toObject === 'function') ? b.toObject() : b
            )
            subPriceResult = {
              roomAmount: sr.roomAmount ?? 0,
              breakdown:  plainItems,
            }
          } else {
            const segCheckIn = sr.actualCheckIn ?? booking.checkIn
            const segCheckOut = (mode === 'now' && sr.status === 'checked_in')
              ? effectiveCheckOut
              : booking.checkOut

            subPriceResult = calculatePrice({
              checkIn:   segCheckIn,
              checkOut:  segCheckOut,
              priceType: sr.priceType ?? booking.priceType,
              policy, branch,
              adults:    sr.adults   ?? booking.adults,
              children:  sr.children ?? booking.children,
              maxAdults, maxChildren,
            })
          }
        }

        totalRoomAmount += subPriceResult.roomAmount ?? 0

        if (sr.status !== 'checked_out') {
          sr.roomAmount = subPriceResult.roomAmount ?? 0
        }
        singleRoomPaid += sr.paidAmount ?? 0

        const subItems = (subPriceResult.breakdown ?? []).map(b => {
          const itemRoomNum = b?.meta?.roomNumber ?? sr.roomNumber
          const labelStr = String(b.label ?? '')
          const hasPrefix = /^\[[^\]]+\]\s/.test(labelStr)
          return {
            ...b,
            label: hasPrefix ? labelStr : `[${itemRoomNum}] ${labelStr}`,
            meta:  { ...(b.meta || {}), roomNumber: itemRoomNum },
          }
        })
        allBreakdown.push(...subItems)
      }

      if (filterRoomId) {
        const sr = targetRooms[0]
        if (!sr) {
          return res.status(404).json({ success: false, message: 'Không tìm thấy phòng trong đoàn' })
        }
        const subServices = sr.servicesAmount ?? 0
        const subDiscount = sr.discountAmount ?? 0
        const subTotalAmount = Math.max(0, totalRoomAmount + subServices - subDiscount)

        let subPaidAmount = sr.paidAmount ?? 0

        const invoiceForPay = await Invoice.findOne({ bookingId: booking._id })
        const invoicePaidTotal = invoiceForPay?.paidAmount ?? 0
        const otherSubPaidSum = booking.rooms
          .filter(r => r !== sr)
          .reduce((s, r) => {
            const rTotal = (r.roomAmount ?? 0) + (r.servicesAmount ?? 0) - (r.discountAmount ?? 0)
            return s + Math.min(r.paidAmount ?? 0, rTotal)
          }, 0)
        const excessInvoicePaid = Math.max(0, invoicePaidTotal - otherSubPaidSum)
        subPaidAmount = Math.max(subPaidAmount, excessInvoicePaid)

        subPaidAmount = Math.min(subPaidAmount, subTotalAmount)

        const subRemainingAmount = Math.max(0, subTotalAmount - subPaidAmount)

        const groupRoomAmount = booking.rooms.reduce((s, r) => {
          if (r.status === 'cancelled') return s
          return s + (r.roomAmount ?? 0)
        }, 0)
        const groupServicesAmount = booking.servicesAmount ?? 0
        const groupSubtotalForDisc = groupRoomAmount + groupServicesAmount
        const groupPctDisc = Math.round(groupSubtotalForDisc * (booking.discountPercent ?? 0) / 100)
        const groupTotalAmount = Math.max(0,
          groupRoomAmount + groupServicesAmount - groupPctDisc - (booking.discountAmount ?? 0) + (booking.transferFee ?? 0)
        )
        const groupPaidAmount = invoicePaidTotal
        const groupRemaining = Math.max(0, groupTotalAmount - groupPaidAmount)

        return res.json({
          success: true,
          data: {
            mode,
            effectiveCheckOut,
            isGroup:          true,
            isSingleRoomMode: true,
            roomId:           String(sr.roomId?._id ?? sr.roomId),
            roomNumber:       sr.roomNumber,
            roomAmount:       totalRoomAmount,
            servicesAmount:   subServices,
            discount:         subDiscount,
            transferFee:      0,
            totalAmount:      subTotalAmount,
            paidAmount:       subPaidAmount,
            remainingAmount:  subRemainingAmount,
            breakdown:        allBreakdown,
            groupTotalAmount,
            groupPaidAmount,
            groupRemaining,
            groupRoomCount:   booking.rooms.filter(r => r.status !== 'cancelled').length,
          },
        })
      }

      const servicesAmount = booking.servicesAmount ?? 0

      let recalcDiscount = booking.discount ?? 0
      if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
        const roomPart = booking.isFreeRoom ? 0 : totalRoomAmount
        const subtotal = roomPart + servicesAmount
        const pctDiscount = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
        recalcDiscount = pctDiscount + (booking.discountAmount ?? 0)
      }

      const roomPart    = booking.isFreeRoom ? 0 : totalRoomAmount
      const transferFee = booking.transferFee ?? 0
      const totalAmount = Math.max(0, roomPart + servicesAmount - recalcDiscount + transferFee)

      const invoice = await Invoice.findOne({ bookingId: booking._id })
      const paidAmount      = invoice?.paidAmount ?? 0
      const remainingAmount = Math.max(0, totalAmount - paidAmount)

      const perRoomPaid = booking.rooms.map(sr => ({
        roomId:          String(sr.roomId?._id ?? sr.roomId),
        roomNumber:      sr.roomNumber,
        status:          sr.status,
        roomAmount:      sr.roomAmount ?? 0,
        servicesAmount:  sr.servicesAmount ?? 0,
        discountAmount:  sr.discountAmount ?? 0,
        paidAmount:      sr.paidAmount ?? 0,
        totalAmount:     (sr.roomAmount ?? 0) + (sr.servicesAmount ?? 0) - (sr.discountAmount ?? 0),
        remainingAmount: Math.max(0, (sr.roomAmount ?? 0) + (sr.servicesAmount ?? 0) - (sr.discountAmount ?? 0) - (sr.paidAmount ?? 0)),
      }))

      return res.json({
        success: true,
        data: {
          mode,
          effectiveCheckOut,
          isGroup:          true,
          totalRooms:       booking.rooms.length,
          checkedOutRooms:  booking.rooms.filter(r => r.status === 'checked_out').length,
          roomAmount:       totalRoomAmount,
          servicesAmount,
          discount:         recalcDiscount,
          transferFee,
          totalAmount,
          paidAmount,
          remainingAmount,
          breakdown:        allBreakdown,
          perRoomPaid,
        },
      })
    }

    const room   = await Room.findById(booking.roomId).populate('typeId')
    const policy = booking.policyId ? await PricePolicy.findById(booking.policyId) : null
    const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
    const maxChildren = room?.typeId?.maxChildren ?? 0

    const hasCustomPrice = (booking.priceBreakdown ?? []).some(b => b.meta?.customPrice === true)

    const hasTransferred = (booking.transferHistory ?? []).length > 0
    const lastTransfer = hasTransferred ? booking.transferHistory[booking.transferHistory.length - 1] : null

    let priceResult
    if (hasCustomPrice) {
      if (mode === 'now') {
        const now = new Date()
        const parseTime = (str) => {
          if (!str) return null
          const dt = new Date(str)
          if (!isNaN(dt.getTime())) return dt
          return null
        }
        const parseRange = (b, refDate) => {
          const mStart = parseTime(b.meta?.startTime)
          const mEnd   = parseTime(b.meta?.endTime)
          if (mStart && mEnd) return { start: mStart, end: mEnd }
          const label = String(b.label ?? '')
          const m = label.match(/\((\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})\)/)
          if (!m) return null
          const [, sd, sm, sh, smi, ed, em, eh, emi] = m
          const year = new Date(refDate ?? Date.now()).getFullYear()
          const start = new Date(year, +sm - 1, +sd, +sh, +smi, 0, 0)
          const end   = new Date(year, +em - 1, +ed, +eh, +emi, 0, 0)
          return { start, end }
        }

        const refDate = booking.checkIn ?? booking.actualCheckIn ?? new Date()
        let nightsToShow = 0
        const baseItems = (booking.priceBreakdown ?? []).filter(b => b.type === 'base')

        for (const b of baseItems) {
          const range = parseRange(b, refDate)
          if (!range) {
            nightsToShow++
            continue
          }
          if (now >= range.end) {
            nightsToShow++
          } else if (now >= range.start) {
            nightsToShow++
            break
          } else {
            const effCheckIn = booking.actualCheckIn ?? booking.checkIn
            if (effCheckIn && now >= effCheckIn && nightsToShow === 0) {
              nightsToShow++
            }
            break
          }
        }

        const filteredBreakdown = []
        let baseCount = 0
        for (const b of (booking.priceBreakdown ?? [])) {
          if (b.type === 'base') {
            if (baseCount < nightsToShow) {
              filteredBreakdown.push(b)
              baseCount++
            }
          } else {
            filteredBreakdown.push(b)
          }
        }

        const filteredTotal = filteredBreakdown.reduce((s, b) => s + (b.amount ?? 0), 0)
        priceResult = {
          roomAmount:       filteredTotal,
          nights:           nightsToShow || booking.nights,
          breakdown:        filteredBreakdown,
          finalPriceType:   booking.priceType,
          converted:        false,
          notice:           null,
        }
      } else {
        priceResult = {
          roomAmount:       booking.roomAmount,
          nights:           booking.nights,
          breakdown:        booking.priceBreakdown ?? [],
          finalPriceType:   booking.priceType,
          converted:        false,
          notice:           null,
        }
      }
    } else if (hasTransferred && mode === 'checkout') {
      priceResult = {
        roomAmount:       booking.roomAmount,
        nights:           booking.nights,
        breakdown:        booking.priceBreakdown ?? [],
        finalPriceType:   booking.priceType,
        converted:        false,
        notice:           null,
      }
    } else if (hasTransferred && mode === 'now') {
      const hasSegments = (booking.priceBreakdown ?? []).some(b => b.meta?.segment != null)
      const hasOldSegments = (booking.priceBreakdown ?? []).some(b => b.meta?.segment === 1)

      if (!hasSegments || !hasOldSegments) {
        priceResult = calculatePrice({
          checkIn:   effectiveCheckIn,
          checkOut:  effectiveCheckOut,
          priceType: booking.priceType,
          policy, branch,
          adults:    booking.adults,
          children:  booking.children,
          maxAdults, maxChildren,
        })
      } else {
        const lastTransferAt = new Date(lastTransfer.transferAt)

        const oldSegments = (booking.priceBreakdown ?? []).filter(b => b.meta?.segment === 1)
        const oldSegmentsAmount = oldSegments.reduce((s, b) => s + (b.amount ?? 0), 0)

        const seg2Result = calculatePrice({
          checkIn:   lastTransferAt,
          checkOut:  effectiveCheckOut,
          priceType: booking.priceType,
          policy, branch,
          adults:    booking.adults,
          children:  booking.children,
          maxAdults, maxChildren,
        })
        const filteredSeg2 = (seg2Result.breakdown ?? []).filter(b => {
          const label = String(b.label || '')
          return !label.includes('Nhận phòng sớm') && !label.includes('early_checkin')
        })
        const seg2Amount = filteredSeg2.reduce((s, b) => s + (b.amount ?? 0), 0)
        const seg2Items = filteredSeg2.map(b => ({
          ...b,
          label: `[${booking.roomNumber}] ${b.label}`,
          meta:  { ...(b.meta || {}), segment: 2, roomNumber: booking.roomNumber },
        }))

        priceResult = {
          roomAmount:       oldSegmentsAmount + seg2Amount,
          nights:           booking.nights,
          breakdown:        [...oldSegments, ...seg2Items],
          finalPriceType:   booking.priceType,
          converted:        false,
          notice:           null,
        }
      }
    } else {
      priceResult = calculatePrice({
        checkIn:   effectiveCheckIn,
        checkOut:  effectiveCheckOut,
        priceType: booking.priceType,
        policy, branch,
        adults:    booking.adults,
        children:  booking.children,
        maxAdults, maxChildren,
      })
    }

    if (priceResult.error) {
      console.warn('[calculateBill] priceResult.error:', priceResult.error.message)
    }

    const servicesAmount = booking.servicesAmount ?? 0
    const discount       = booking.discount ?? 0

    let recalcDiscount = discount
    if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
      const roomPart = booking.isFreeRoom ? 0 : priceResult.roomAmount
      const subtotal = roomPart + servicesAmount
      const pctDiscount = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
      recalcDiscount = pctDiscount + (booking.discountAmount ?? 0)
    }

    const roomPart    = booking.isFreeRoom ? 0 : priceResult.roomAmount
    const transferFee = booking.transferFee ?? 0
    const totalAmount = Math.max(0, roomPart + servicesAmount - recalcDiscount + transferFee)

    const invoice = await Invoice.findOne({ bookingId: booking._id })
    const paidAmount      = invoice?.paidAmount ?? 0
    const remainingAmount = Math.max(0, totalAmount - paidAmount)

    res.json({
      success: true,
      data: {
        mode,
        effectiveCheckOut,
        nights:           priceResult.nights,
        roomAmount:       priceResult.roomAmount,
        servicesAmount,
        discount:         recalcDiscount,
        transferFee,
        totalAmount,
        paidAmount,
        remainingAmount,
        breakdown:        priceResult.breakdown,
        usedStoredBreakdown: hasTransferred && mode === 'checkout',
        finalPriceType:   priceResult.finalPriceType,
        converted:        priceResult.converted,
        notice:           priceResult.notice,
      },
    })
  } catch (err) {
    console.error('[calculateBill] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

const allocatePaymentToRooms = (booking, amount, targetRoomId = null) => {
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

const getAvailableByType = async (req, res, next) => {
  try {
    const { branchId, checkIn, checkOut } = req.query
    if (!branchId || !checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Thiếu branchId/checkIn/checkOut' })

    const ci = new Date(checkIn)
    const co = new Date(checkOut)

    const allRooms = await Room.find({
      branchId,
      roomStatus: { $ne: 'maintenance' },
    }).populate('typeId')

    const conflicts = await Booking.find({
      branchId,
      status: { $in: ['confirmed', 'reserved', 'checked_in'] },
      checkIn:  { $lt: co },
      checkOut: { $gt: ci },
    }).select('roomId rooms status customerName checkIn checkOut')

    const bookedRoomIds = new Set()
    conflicts.forEach(b => {
      if (b.roomId) bookedRoomIds.add(String(b.roomId))
      ;(b.rooms ?? []).forEach(r => {
        if (r.roomId && r.status !== 'checked_out' && r.status !== 'cancelled') {
          bookedRoomIds.add(String(r.roomId))
        }
      })
    })

    const typeMap = new Map()
    allRooms.forEach(room => {
      const typeId   = String(room.typeId?._id ?? '')
      const typeName = room.typeId?.name ?? room.typeName ?? '—'
      const maxAdults   = room.typeId?.maxAdults   ?? room.typeId?.capacity ?? 2
      const maxChildren = room.typeId?.maxChildren ?? 0
      const isAvailable = !bookedRoomIds.has(String(room._id))

      if (!typeMap.has(typeId)) {
        typeMap.set(typeId, {
          typeId, typeName, maxAdults, maxChildren,
          totalRooms:     0,
          availableRooms: 0,
          rooms: [],
        })
      }
      const entry = typeMap.get(typeId)
      entry.totalRooms++
      if (isAvailable) entry.availableRooms++
      entry.rooms.push({
        id:        room._id,
        number:    room.number,
        typeName,
        typeId,
        maxAdults, maxChildren,
        available: isAvailable,
      })
    })

    res.json({
      success: true,
      data: { types: Array.from(typeMap.values()) },
    })
  } catch (err) {
    console.error('[getAvailableByType] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

// ⭐ HELPER: Tính giá cho cả nhóm phòng
async function calculateGroupPrice({ branchId, checkIn, checkOut, rooms: roomsInput }) {
  const checkInDate  = new Date(checkIn)
  const checkOutDate = new Date(checkOut)

  const branch = await Branch.findById(branchId)
  if (!branch) throw new Error('Không tìm thấy chi nhánh')

  const lines       = []
  let totalAmount   = 0

  for (const r of roomsInput) {
    const room = await Room.findById(r.roomId).populate('typeId')
    if (!room) throw new Error(`Không tìm thấy phòng ${r.roomId}`)

    const policy = r.policyId ? await PricePolicy.findById(r.policyId) : null

    const priceResult = calculatePrice({
      checkIn:   checkInDate,
      checkOut:  checkOutDate,
      priceType: r.priceType ?? 'day',
      policy, branch,
      adults:    r.adults ?? 2,
      children:  r.children ?? 0,
      maxAdults:   room.typeId?.maxAdults   ?? room.typeId?.capacity ?? 2,
      maxChildren: room.typeId?.maxChildren ?? 0,
    })

    if (priceResult.error) {
      const err = new Error(`Phòng ${room.number}: ${priceResult.error.message}`)
      err.code       = priceResult.error.code
      err.statusCode = 400
      err.data = {
        roomId:          r.roomId,
        roomNumber:      room.number,
        finalPriceType:  priceResult.error.finalPriceType,
        availableTypes:  priceResult.error.availableTypes,
        availableLabels: priceResult.error.availableLabels,
        policyName:      policy?.name ?? '',
      }
      throw err
    }

    lines.push({
      roomId:           room._id,
      roomNumber:       room.number,
      typeId:           room.typeId?._id ?? null,
      typeName:         room.typeName ?? room.typeId?.name ?? '',
      maxAdults:   room.typeId?.maxAdults   ?? room.typeId?.capacity ?? 2,
      maxChildren: room.typeId?.maxChildren ?? 0,
      adults:           r.adults ?? 2,
      children:         r.children ?? 0,
      policyId:         policy?._id ?? null,
      policyName:       policy?.name ?? '',
      requestedPriceType: r.priceType ?? 'day',
      finalPriceType:   priceResult.finalPriceType ?? r.priceType ?? 'day',
      converted:        priceResult.converted ?? false,
      notice:           priceResult.notice ?? '',
      roomAmount:       priceResult.roomAmount,
      breakdown:        priceResult.breakdown,
      nights:           priceResult.nights ?? 0,
    })

    totalAmount += priceResult.roomAmount
  }

  const byType = new Map()
  for (const line of lines) {
    const key = String(line.typeId ?? '_unknown')
    if (!byType.has(key)) {
      byType.set(key, {
        typeId:      line.typeId,
        typeName:    line.typeName,
        capacity:    line.capacity,
        maxAdults:   line.maxAdults,
        maxChildren: line.maxChildren,
        rooms:       [],
        subTotal:    0,
      })
    }
    const entry = byType.get(key)
    entry.rooms.push(line)
    entry.subTotal += line.roomAmount
  }

  return {
    totalAmount,
    nights:   lines[0]?.nights ?? 0,
    lines,
    typeGroups: Array.from(byType.values()),
  }
}

const previewGroup = async (req, res) => {
  try {
    const { branchId, checkIn, checkOut, rooms: roomsInput = [] } = req.body

    if (!branchId || !checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Thiếu branchId/checkIn/checkOut' })
    if (!Array.isArray(roomsInput) || roomsInput.length === 0)
      return res.json({ success: true, data: { totalAmount: 0, lines: [], typeGroups: [], nights: 0 } })

    const result = await calculateGroupPrice({ branchId, checkIn, checkOut, rooms: roomsInput })

    res.json({ success: true, data: result })
  } catch (err) {
    if (err.statusCode === 400) {
      return res.status(400).json({
        success: false,
        code:    err.code,
        message: err.message,
        data:    err.data,
      })
    }
    console.error('[previewGroup] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

const createGroup = async (req, res, next) => {
  try {
    const {
      customerName, customerPhone = '', customerId = null,
      groupName = '',
      checkIn, checkOut, branchId,
      source = 'Trực tiếp',
      status: initialStatus = 'reserved',
      rooms: roomsInput = [],
    } = req.body

    if (!customerName) return res.status(400).json({ success: false, message: 'Thiếu tên khách' })
    if (!checkIn || !checkOut) return res.status(400).json({ success: false, message: 'Thiếu checkIn/checkOut' })
    if (!Array.isArray(roomsInput) || roomsInput.length === 0)
      return res.status(400).json({ success: false, message: 'Cần chọn ít nhất 1 phòng' })

    const checkInDate  = new Date(checkIn)
    const checkOutDate = new Date(checkOut)
    if (checkOutDate <= checkInDate)
      return res.status(400).json({ success: false, message: 'Ngày check-out phải sau check-in' })

    const branch = await Branch.findById(branchId)
    if (!branch) return res.status(404).json({ success: false, message: 'Không tìm thấy chi nhánh' })

    // ⭐ Determine effective interval cho conflict check
    const willCheckInNowGrp = initialStatus === 'checked_in'
    const nowForGrp = new Date()
    const grpIntervalStart = willCheckInNowGrp && nowForGrp < checkInDate
      ? nowForGrp
      : checkInDate

    for (const r of roomsInput) {
      const conflictResult = await findOverlapForNewBooking({
        roomId:        r.roomId,
        intervalStart: grpIntervalStart,
        intervalEnd:   checkOutDate,
      })
      if (conflictResult) {
        const room = await Room.findById(r.roomId)
        const { conflict, conflictStart, conflictEnd, conflictStatus } = conflictResult
        const statusLabel = {
          reserved:   'đã đặt',
          confirmed:  'đã xác nhận',
          checked_in: 'đang ở',
        }[conflictStatus] ?? conflictStatus
        const actionLabel = willCheckInNowGrp ? 'nhận phòng ngay' : 'đặt phòng'
        return res.status(400).json({
          success: false,
          code: 'CONFLICT_OVERLAP',
          message: `Không thể ${actionLabel} — phòng ${room?.number ?? r.roomId} đang có khách (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}.`,
          data: {
            roomNumber:           room?.number ?? null,
            conflictBookingId:    conflict._id,
            conflictCustomerName: conflict.customerName,
            conflictCheckIn:      conflictStart,
            conflictCheckOut:     conflictEnd,
            conflictStatus,
            attemptedCheckInAt:   willCheckInNowGrp ? nowForGrp : null,
          },
        })
      }
    }

    const isGroupBooking = roomsInput.length > 1

    let priceResult
    try {
      priceResult = await calculateGroupPrice({
        branchId, checkIn: checkInDate, checkOut: checkOutDate, rooms: roomsInput,
      })
    } catch (err) {
      if (err.statusCode === 400) {
        return res.status(400).json({
          success: false,
          code:    err.code,
          message: err.message,
          data:    err.data,
        })
      }
      throw err
    }

    const totalRoomAmount = priceResult.totalAmount

    const subRooms = []
    let firstRoomData = null

    for (let i = 0; i < priceResult.lines.length; i++) {
      const line = priceResult.lines[i]
      const r    = roomsInput[i]
      const room = await Room.findById(r.roomId).populate('typeId')
      const policy = line.policyId ? await PricePolicy.findById(line.policyId) : null

      const breakdown = Array.isArray(line.breakdown) ? line.breakdown : []

      const subRoom = {
        roomId:         line.roomId,
        roomNumber:     line.roomNumber,
        roomType:       line.typeName,
        typeId:         line.typeId,
        priceType:      line.finalPriceType,
        adults:         line.adults,
        children:       line.children,
        policyId:       line.policyId,
        policyName:     line.policyName,
        roomAmount:     line.roomAmount,
        priceBreakdown: breakdown.map(b => ({
          label:  String(b.label ?? ''),
          amount: Number(b.amount ?? 0),
          type:   b.type === 'surcharge' ? 'surcharge' : 'base',
          meta:   { ...(b.meta || {}), roomNumber: line.roomNumber },
        })),
        status:         initialStatus === 'checked_in' ? 'checked_in' : 'reserved',
        actualCheckIn:  initialStatus === 'checked_in' ? new Date() : null,
      }
      subRooms.push(subRoom)
      if (i === 0) firstRoomData = { ...subRoom, room, policy }
    }

    const nightsCalc = Math.max(1, Math.ceil((checkOutDate - checkInDate) / 86400000))

    let finalCustomerId = customerId
    if (!finalCustomerId) {
      let customer
      try {
        if (customerPhone && customerPhone !== '0000000000') {
          customer = await Customer.findOne({ phone: customerPhone })
          if (!customer) customer = await Customer.create({ name: customerName, phone: customerPhone })
        } else {
          customer = await Customer.create({ name: customerName })
        }
        finalCustomerId = customer._id
      } catch (e) {
        console.error('[createGroup] create customer failed:', e.message)
        return res.status(500).json({
          success: false,
          message: 'Không thể tạo khách hàng: ' + e.message,
        })
      }
    }

    const booking = await Booking.create({
      customerId:      finalCustomerId,
      customerName,
      customerPhone:   customerPhone || '0000000000',
      roomId:          firstRoomData.roomId,
      roomNumber:      firstRoomData.roomNumber,
      roomType:        firstRoomData.roomType,
      branchId,
      checkIn:         checkInDate,
      checkOut:        checkOutDate,
      nights:          nightsCalc,
      priceType:       firstRoomData.priceType,
      adults:          firstRoomData.adults,
      children:        firstRoomData.children,
      roomAmount:      totalRoomAmount,
      totalAmount:     totalRoomAmount,
      servicesAmount:  0,
      discount:        0,
      discountPercent: 0,
      discountAmount:  0,
      isFreeRoom:      false,
      priceBreakdown:  firstRoomData.priceBreakdown,
      policyId:        firstRoomData.policyId,
      policyName:      firstRoomData.policyName,
      policySnapshot:  firstRoomData.policy
        ? buildPolicySnapshot(firstRoomData.policy, firstRoomData.room.typeId?.capacity ?? null)
        : null,
      status:          initialStatus,
      actualCheckIn:   initialStatus === 'checked_in' ? new Date() : null,
      source,
      isGroup:         isGroupBooking,
      groupName,
      rooms:           isGroupBooking ? subRooms : [],
    })

    for (const sr of subRooms) {
      await Room.findByIdAndUpdate(sr.roomId, {
        currentBookingId: booking._id,
        currentGuestName: customerName,
      })
    }

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: isGroupBooking ? 'create_group' : (initialStatus === 'checked_in' ? 'create_and_checkin' : 'create'),
      description: isGroupBooking
        ? `Tạo đoàn "${groupName || customerName}" — ${subRooms.length} phòng (${subRooms.map(r => r.roomNumber).join(', ')})`
        : `Tạo đặt phòng ${firstRoomData.roomNumber} cho ${customerName}`,
      user: req.user, branchId,
      metadata: {
        isGroup: isGroupBooking, groupName,
        roomCount: subRooms.length,
        roomNumbers: subRooms.map(r => r.roomNumber),
        totalAmount: totalRoomAmount,
      },
    })

    res.status(201).json({
      success: true,
      message: isGroupBooking ? 'Tạo đặt đoàn thành công' : 'Tạo đặt phòng thành công',
      data: { booking },
    })
  } catch (err) {
    console.error('[createGroup] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

// ⭐ GET /bookings/:id/can-set-past?roomId=xxx
const getCanSetPast = async (req, res, next) => {
  try {
    const { roomId = null } = req.query
    const booking = await Booking.findById(req.params.id)
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    }

    let roomNumberForAudit = null
    if (roomId && Array.isArray(booking.rooms)) {
      const sub = booking.rooms.find(r =>
        String(r.roomId?._id ?? r.roomId) === String(roomId)
      )
      if (sub) roomNumberForAudit = sub.roomNumber
    }

    const perm = await canSetPastTime(req.user, booking._id, roomNumberForAudit)
    res.json({
      success: true,
      data: {
        canSetPast: perm.canSetPast,
        reason:     perm.reason ?? null,
        userRole:   req.user?.role ?? null,
        isPrivilegedRole:  PRIVILEGED_PAST_ROLES.includes(req.user?.role),
        roomNumber: roomNumberForAudit,
        lastCheckoutAt: perm.lastCheckoutAt ?? null,
      },
    })
  } catch (err) {
    console.error('[getCanSetPast] error:', err)
    next(err)
  }
}

module.exports = {
  getAll, getOne, create, update,
  previewPrice, changeDates, changeDatesRoom, moveRoom,
  checkin, checkout, cancel, undo,
  getAvailableByDate,
  applyDiscount,
  calculateBill,
  changePolicy,
  createGroup,
  getAvailableByType,
  previewGroup,
  checkinRoom,
  checkoutRoom,
  undoRoom,
  getCanSetPast,
}