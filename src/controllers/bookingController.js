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
const { computeMoveRoomBreakdown } = require('../utils/moveRoomBreakdown');

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
//   Note: KHÔNG filter `undone` — sau khi undo, user thường muốn recheckout với
//   giờ cũ làm gợi ý. Audit trail (ai làm gì) là việc của AuditLog, không phải
//   của hàm này.
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
// ⭐ FIX 07/05/2026 v2: Phân biệt CHECK-IN vs ĐẶT PHÒNG khi khách cũ chưa trả
//
// LOGIC ĐÚNG BUSINESS:
//   - actionType='checkin' (đang muốn nhận phòng / chiếm phòng VẬT LÝ ngay):
//     + Candidate `checked_in` chưa trả → end = +∞ → BLOCK
//     + Candidate `reserved`/`confirmed` → end = checkOut dự kiến (cho phép đặt
//       chồng nếu không overlap khoảng đặt)
//
//   - actionType='reserve' (chỉ đặt trước, chưa nhận phòng ngay):
//     + DÙNG checkOut DỰ KIẾN → cho phép đặt phòng tương lai dù A chưa trả
//     + Khi B đến giờ check-in mà A vẫn chưa trả → ở bước check-in mới block
//
// VÍ DỤ:
//   - 301 (A) checked_in 21:29-21:29 chưa trả thực tế
//   - B đặt 22:00 → 08/05 12:00 (status=reserved) → CHO PHÉP ✅
//   - B đến 22:00 muốn check-in mà A vẫn chưa trả → BLOCK ✅
//   - A bấm trả 21:55 → B check-in 22:00 OK ✅
// ════════════════════════════════════════════════════════════════════════════

const FAR_FUTURE = new Date('9999-12-31T23:59:59.999Z')

// Helper: end thực tế của candidate (booking đang giữ phòng)
//   - Đã trả: dùng actualCheckOut
//   - Đang checked_in chưa trả + actionType='checkin': dùng FAR_FUTURE → block
//   - Còn lại: dùng checkOut dự kiến
const resolveCandidateEnd = (candStatus, actualCheckOut, scheduledCheckOut, actionType = 'checkin') => {
  if (actualCheckOut) return new Date(actualCheckOut)
  if (candStatus === 'checked_in' && actionType === 'checkin') return FAR_FUTURE
  return scheduledCheckOut ? new Date(scheduledCheckOut) : null
}

const findActiveConflictForRoom = async ({
  bookingId, roomId, intervalStart, intervalEnd,
  actionType = 'checkin',  // ⭐ 'checkin' | 'reserve'
}) => {
  const candidates = await Booking.find({
    _id:    { $ne: bookingId },
    $or: [
      { roomId },
      { 'rooms.roomId': roomId },
    ],
    status:   { $in: ['confirmed', 'reserved', 'checked_in'] },
  }).sort({ checkIn: 1 })

  for (const cand of candidates) {
    let candRoom    = null
    let candStatus  = cand.status
    let candStart   = null
    let candEnd     = null
    let isStillCheckedIn = false

    if (Array.isArray(cand.rooms) && cand.rooms.length > 0) {
      candRoom = cand.rooms.find(r =>
        String(r.roomId?._id ?? r.roomId) === String(roomId)
      )
      if (!candRoom) continue
      if (['checked_out', 'cancelled'].includes(candRoom.status)) continue
      candStatus = candRoom.status
      candStart  = candRoom.actualCheckIn  ?? candRoom.checkIn  ?? cand.checkIn
      candEnd    = resolveCandidateEnd(
        candStatus,
        candRoom.actualCheckOut,
        candRoom.checkOut ?? cand.checkOut,
        actionType,
      )
      isStillCheckedIn = candStatus === 'checked_in' && !candRoom.actualCheckOut
    } else {
      if (String(cand.roomId) !== String(roomId)) continue
      candStart = cand.actualCheckIn  ?? cand.checkIn
      candEnd   = resolveCandidateEnd(candStatus, cand.actualCheckOut, cand.checkOut, actionType)
      isStillCheckedIn = candStatus === 'checked_in' && !cand.actualCheckOut
    }

    if (!candStart || !candEnd) continue

    const overlap = new Date(intervalStart) < new Date(candEnd) &&
                    new Date(candStart)     < new Date(intervalEnd)
    if (!overlap) continue

    return {
      conflict:        cand,
      conflictRoom:    candRoom,
      conflictStart:   candStart,
      // Trả về scheduledCheckOut cho UI (không show "9999")
      conflictEnd:     candEnd === FAR_FUTURE
        ? (candRoom?.checkOut ?? cand.checkOut)
        : candEnd,
      conflictStatus:  candStatus,
      isStillCheckedIn,  // ⭐ NEW: cho FE biết khách đang ở chưa trả
    }
  }

  return null
}

const findOverlapForNewBooking = async ({
  roomId, intervalStart, intervalEnd,
  excludeBookingIds = [],
  actionType = 'checkin',  // ⭐ 'checkin' | 'reserve'
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
    let isStillCheckedIn = false

    if (Array.isArray(cand.rooms) && cand.rooms.length > 0) {
      candRoom = cand.rooms.find(r =>
        String(r.roomId?._id ?? r.roomId) === String(roomId)
      )
      if (!candRoom) continue
      if (['checked_out', 'cancelled'].includes(candRoom.status)) continue
      candStatus = candRoom.status
      candStart  = candRoom.actualCheckIn  ?? candRoom.checkIn  ?? cand.checkIn
      candEnd    = resolveCandidateEnd(
        candStatus,
        candRoom.actualCheckOut,
        candRoom.checkOut ?? cand.checkOut,
        actionType,
      )
      isStillCheckedIn = candStatus === 'checked_in' && !candRoom.actualCheckOut
    } else {
      if (String(cand.roomId) !== String(roomId)) continue
      candStart = cand.actualCheckIn  ?? cand.checkIn
      candEnd   = resolveCandidateEnd(candStatus, cand.actualCheckOut, cand.checkOut, actionType)
      isStillCheckedIn = candStatus === 'checked_in' && !cand.actualCheckOut
    }

    if (!candStart || !candEnd) continue

    const overlap = new Date(intervalStart) < new Date(candEnd) &&
                    new Date(candStart)     < new Date(intervalEnd)
    if (!overlap) continue

    return {
      conflict:       cand,
      conflictRoom:   candRoom,
      conflictStart:  candStart,
      conflictEnd:    candEnd === FAR_FUTURE
        ? (candRoom?.checkOut ?? cand.checkOut)
        : candEnd,
      conflictStatus: candStatus,
      isStillCheckedIn,
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
    const maxOccupancy = room.typeId?.maxOccupancy ?? (maxAdults + maxChildren)

    // ⭐ NEW 18/05/2026: BLOCK nếu tổng người vượt maxOccupancy
    if ((adults + children) > maxOccupancy) {
      return res.status(400).json({
        success: false,
        code:    'OVER_CAPACITY',
        message: `Phòng chỉ hỗ trợ tối đa ${maxOccupancy} người.`,
        data: {
          maxOccupancy,
          requested: adults + children,
          adults, children,
          maxAdults, maxChildren,
        },
      })
    }

    const result = calculatePrice({
      checkIn:  new Date(checkIn),
      checkOut: new Date(checkOut),
      priceType, policy, branch, adults, children, maxAdults, maxChildren, maxOccupancy,
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
    const validInitialEarly = ['reserved', 'confirmed', 'checked_in']
    const initialStatusEarly = validInitialEarly.includes(requestedStatus) ? requestedStatus : 'reserved'
    const willCheckInNow = initialStatusEarly === 'checked_in'
    const nowForCreate = new Date()

    // ⭐ FIX 07/05/2026: Chặn đặt phòng / nhận phòng ở quá khứ
    //
    //   Rule 1: status='reserved/confirmed' (đặt trước):
    //     - checkIn và checkOut phải > now
    //     - Cho phép trễ tối đa 60 giây (tránh lỗi clock skew)
    //
    //   Rule 2: status='checked_in' (nhận phòng ngay):
    //     - checkOut PHẢI > now (không thể "nhận phòng" với giờ trả đã qua)
    //     - checkIn cho phép quá khứ (nhập backdate cho khách đã đến trước, vd
    //       nhân viên nhập muộn) — đúng business
    //
    //   Cả 2 rule: nếu Admin/Manager → có thể bypass (cho nhập backdate hợp lệ)
    {
      const nowMs = nowForCreate.getTime()
      const tolerance = 60 * 1000  // 60s tolerance

      if (!willCheckInNow) {
        // Đặt trước: cả checkIn và checkOut phải tương lai
        if (checkInDate.getTime() < nowMs - tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PAST_CHECKIN',
            message: `Không thể đặt phòng với giờ nhận phòng (${checkInDate.toLocaleString('vi-VN')}) đã qua. Vui lòng chọn giờ nhận phòng từ ${nowForCreate.toLocaleString('vi-VN')} trở đi, hoặc chuyển sang "Nhận phòng ngay" nếu khách đã đến.`,
            data: { now: nowForCreate, requestedCheckIn: checkInDate },
          })
        }
        if (checkOutDate.getTime() < nowMs - tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PAST_CHECKOUT',
            message: `Không thể đặt phòng với giờ trả phòng (${checkOutDate.toLocaleString('vi-VN')}) đã qua. Vui lòng chọn giờ trả phòng sau ${nowForCreate.toLocaleString('vi-VN')}.`,
            data: { now: nowForCreate, requestedCheckOut: checkOutDate },
          })
        }
      } else {
        // Nhận phòng ngay: checkOut bắt buộc tương lai
        if (checkOutDate.getTime() < nowMs - tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PAST_CHECKOUT',
            message: `Không thể nhận phòng với giờ trả phòng dự kiến (${checkOutDate.toLocaleString('vi-VN')}) đã qua so với hiện tại (${nowForCreate.toLocaleString('vi-VN')}). Vui lòng chọn giờ trả phòng trong tương lai.`,
            data: { now: nowForCreate, requestedCheckOut: checkOutDate },
          })
        }
        // checkIn quá khứ thì OK cho status='checked_in' (backdate)
      }
    }

    const conflictIntervalStart = willCheckInNow && nowForCreate < checkInDate
      ? nowForCreate
      : checkInDate
    const conflictIntervalEnd = checkOutDate

    const conflictResult = await findOverlapForNewBooking({
      roomId,
      intervalStart: conflictIntervalStart,
      intervalEnd:   conflictIntervalEnd,
      actionType:    willCheckInNow ? 'checkin' : 'reserve',
    })
    if (conflictResult) {
      const { conflict, conflictStart, conflictEnd, conflictStatus, isStillCheckedIn } = conflictResult
      const statusLabel = {
        reserved:   'đã đặt',
        confirmed:  'đã xác nhận',
        checked_in: isStillCheckedIn ? 'đang ở (chưa trả phòng)' : 'đang ở',
      }[conflictStatus] ?? conflictStatus
      const actionLabel = willCheckInNow ? 'nhận phòng ngay' : 'đặt phòng'
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_OVERLAP',
        message: isStillCheckedIn
          ? `Không thể ${actionLabel} — phòng đang có khách ${conflict.customerName} chưa trả phòng (dự kiến trả ${new Date(conflictEnd).toLocaleString('vi-VN')}). Vui lòng xử lý trả phòng cho khách hiện tại trước.`
          : `Không thể ${actionLabel} — phòng đang có khách (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}.${willCheckInNow ? ` Bạn muốn nhận phòng từ ${nowForCreate.toLocaleString('vi-VN')} nhưng phòng đang bị chiếm.` : ' Vui lòng chọn khoảng giờ khác.'}`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          conflictCheckOut:     conflictEnd,
          conflictStatus,
          isStillCheckedIn,
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
    const maxOccupancy = room.typeId?.maxOccupancy ?? (maxAdults + maxChildren)

    // ⭐ NEW 18/05/2026: BLOCK nếu tổng người vượt maxOccupancy
    if ((adults + children) > maxOccupancy) {
      return res.status(400).json({
        success: false,
        code:    'OVER_CAPACITY',
        message: `Phòng chỉ hỗ trợ tối đa ${maxOccupancy} người.`,
        data: {
          maxOccupancy,
          requested: adults + children,
          adults, children,
          maxAdults, maxChildren,
          roomNumber: room.number,
        },
      })
    }

    const priceResult = calculatePrice({
      checkIn:  checkInFinal,
      checkOut: checkOutFinal,
      priceType, policy, branch, adults, children, maxAdults, maxChildren, maxOccupancy,
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

    // ⭐ FIX 07/05/2026: Nếu booking đã `checked_in`, newCheckIn KHÔNG được ở tương lai
    //   Lý do: booking đã `checked_in` → `actualCheckIn` phải ≤ hiện tại (khách đã nhận phòng)
    //   Code dưới sẽ set actualCheckIn = newCheckIn nếu status='checked_in',
    //   nên ta phải block trước khi tới đoạn đó.
    //   Ngược lại nếu booking 'reserved/confirmed', newCheckIn ở tương lai OK.
    if (booking.status === 'checked_in') {
      const now = new Date()
      if (newCheckIn.getTime() > now.getTime() + 60 * 1000) {  // 60s tolerance
        return res.status(400).json({
          success: false,
          code: 'INVALID_FUTURE_ACTUAL_CHECKIN',
          message: `Phòng đã nhận — giờ nhận phòng thực tế (${newCheckIn.toLocaleString('vi-VN')}) không được ở tương lai so với hiện tại (${now.toLocaleString('vi-VN')}). Vui lòng chọn giờ trong quá khứ hoặc hiện tại.`,
          data: {
            now,
            requestedCheckIn:    newCheckIn,
            currentStatus:       booking.status,
            currentActualCheckIn: booking.actualCheckIn,
          },
        })
      }
    } else {
      // Booking chưa check-in (reserved/confirmed): newCheckIn không được ở quá khứ
      const now = new Date()
      if (newCheckIn.getTime() < now.getTime() - 60 * 1000) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_PAST_CHECKIN',
          message: `Không thể đổi giờ nhận phòng sang quá khứ (${newCheckIn.toLocaleString('vi-VN')}). Vui lòng chọn giờ từ ${now.toLocaleString('vi-VN')} trở đi.`,
          data: { now, requestedCheckIn: newCheckIn },
        })
      }
    }
    // Cả 2 trường hợp: newCheckOut phải > now (không cho đổi sang quá khứ)
    {
      const now = new Date()
      if (newCheckOut.getTime() < now.getTime() - 60 * 1000) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_PAST_CHECKOUT',
          message: `Không thể đổi giờ trả phòng sang quá khứ (${newCheckOut.toLocaleString('vi-VN')}). Vui lòng chọn giờ sau ${now.toLocaleString('vi-VN')}.`,
          data: { now, requestedCheckOut: newCheckOut },
        })
      }
    }

    const allRoomIds = [booking.roomId]
    if (Array.isArray(booking.rooms)) {
      for (const sr of booking.rooms) {
        if (sr.roomId) allRoomIds.push(sr.roomId)
      }
    }

    for (const rid of allRoomIds) {
      if (!rid) continue
      const conflictResult = await findOverlapForNewBooking({
        roomId:        rid,
        intervalStart: newCheckIn,
        intervalEnd:   newCheckOut,
        excludeBookingIds: [booking._id],
        actionType:    'reserve',
      })
      if (conflictResult) {
        const { conflict, conflictStart, conflictEnd, conflictStatus, isStillCheckedIn } = conflictResult
        const statusLabel = {
          reserved:   'đã đặt',
          confirmed:  'đã xác nhận',
          checked_in: isStillCheckedIn ? 'đang ở (chưa trả phòng)' : 'đang ở',
        }[conflictStatus] ?? conflictStatus
        return res.status(400).json({
          success: false,
          code: 'CONFLICT_OVERLAP',
          message: isStillCheckedIn
            ? `Phòng đang có khách ${conflict.customerName} chưa trả phòng. Vui lòng xử lý trả phòng cho khách hiện tại trước.`
            : `Trùng với đặt phòng khác (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}`,
          data: {
            conflictBookingId:    conflict._id,
            conflictCustomerName: conflict.customerName,
            conflictCheckIn:      conflictStart,
            conflictCheckOut:     conflictEnd,
            conflictStatus,
            isStillCheckedIn,
          },
        })
      }
    }

    const room   = await Room.findById(booking.roomId).populate('typeId')
    const branch = await Branch.findById(booking.branchId)
    const policy = booking.policyId ? await PricePolicy.findById(booking.policyId) : null
    const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
    const maxChildren = room?.typeId?.maxChildren ?? 0

    const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)

    // ⭐ FIX 19/05/2026: Nếu đã có transferHistory, KHÔNG dùng calculatePrice thẳng
    //   vì sẽ tính toàn bộ thời gian theo policy phòng MỚI → mất segment phòng cũ.
    //   Dùng computeMoveRoomBreakdown để phân đoạn đúng [oldRoom → transferAt → newRoom].
    const hasTransfer = Array.isArray(booking.transferHistory) && booking.transferHistory.length > 0
    let priceResult

    if (hasTransfer) {
      const transfers = booking.transferHistory
        .filter(t => t?.transferAt && t?.fromRoomNumber && t?.toRoomNumber)
        .sort((a, b) => new Date(a.transferAt) - new Date(b.transferAt))

      // ⭐ FIX 19/05/2026 v3: Detect multi-transfer.
      //   computeMoveRoomBreakdown chỉ support 1 transfer. Với ≥ 2 transfer, breakdown
      //   được build incrementally khi mỗi lần move. Rebuild từ đầu trong changeDates
      //   sẽ mất segment trung gian → sai tiền.
      //   → Trả lỗi, yêu cầu user xử lý thủ công (vd: undo các lần move rồi đổi ngày).
      if (transfers.length >= 2) {
        return res.status(400).json({
          success: false,
          message:
            `Booking đã chuyển phòng ${transfers.length} lần. ` +
            `Hệ thống chưa hỗ trợ đổi ngày tự động cho booking có nhiều lần chuyển phòng. ` +
            `Vui lòng undo các lần chuyển phòng trước khi đổi ngày, hoặc liên hệ admin.`,
          data: { transferCount: transfers.length },
        })
      }

      const lastTransfer = transfers[transfers.length - 1]

      // Resolve oldPolicy
      let oldPolicy = null
      if (lastTransfer?.oldPolicyId) {
        try { oldPolicy = await PricePolicy.findById(lastTransfer.oldPolicyId) } catch {}
      }
      if (!oldPolicy && booking.policySnapshot && booking.policySnapshot.dayPrice) {
        oldPolicy = booking.policySnapshot
      }

      // Resolve room types
      let oldRoomType = ''
      try {
        const oldRoomDoc = await Room.findOne({
          number: lastTransfer.fromRoomNumber,
          branchId: booking.branchId,
        }).populate('typeId')
        if (oldRoomDoc) {
          oldRoomType = oldRoomDoc.typeId?.name || oldRoomDoc.typeName || ''
        }
      } catch {}
      const newRoomType = room?.typeId?.name || booking.roomType || ''

      const hourSlotsOf = (pol) => {
        if (!pol) return []
        return (pol.hourSlots || []).map(s => {
          const time = s.time || s.duration || ''
          const m = String(time).match(/(\d+)/)
          return { durationHours: m ? parseInt(m[1]) : 2, price: s.price || 0 }
        })
      }

      const actualCI = booking.actualCheckIn ?? newCheckIn
      const moveItems = computeMoveRoomBreakdown({
        actualCheckIn:   actualCI,
        plannedCheckOut: newCheckOut,
        transferAt:      new Date(lastTransfer.transferAt),
        oldRoom: {
          number: lastTransfer.fromRoomNumber,
          type:   oldRoomType,
          policy: {
            dayPrice:        oldPolicy?.dayPrice || 0,
            hourSlots:       oldPolicy?.hourSlots || [],
            dayCheckInTime:  oldPolicy?.dayCheckInTime || '14:00',
            dayCheckOutTime: oldPolicy?.dayCheckOutTime || '12:00',
            dayEarlyCheckIn: oldPolicy?.dayEarlyCheckIn || [],
            dayLateCheckOut: oldPolicy?.dayLateCheckOut || [],
          },
        },
        newRoom: {
          number: lastTransfer.toRoomNumber,
          type:   newRoomType,
          policy: {
            dayPrice:        policy?.dayPrice || 0,
            hourSlots:       policy?.hourSlots || [],
            dayCheckInTime:  policy?.dayCheckInTime || '14:00',
            dayCheckOutTime: policy?.dayCheckOutTime || '12:00',
            dayEarlyCheckIn: policy?.dayEarlyCheckIn || [],
            dayLateCheckOut: policy?.dayLateCheckOut || [],
          },
        },
        transferFee: Number(lastTransfer.fee) || 0,
        changeRate:  oldRoomType !== newRoomType,
        isFreeRoom:  !!booking.isFreeRoom,
        branchConfig: branch ? {
          checkInTime:        branch.checkInTime,
          checkOutTime:       branch.checkOutTime,
          earlyCheckinUntil:  branch.earlyCheckinUntil ?? 5,
          toleranceMinutes:   branch.toleranceMinutes ?? 15,
          dayEquivalentHours: branch.dayEquivalentHours ?? 23,
        } : null,
      })

      const breakdownItems = moveItems.map(it => ({
        label:  it.label,
        amount: it.amount,
        type:   it.type === 'surcharge' ? 'surcharge' : 'base',
        meta:   it.meta || {},
      }))

      // Bổ sung phụ thu vượt sức chứa theo policy phòng mới từ transferAt → newCheckOut
      try {
        const surchargeResult = calculatePrice({
          checkIn:   new Date(lastTransfer.transferAt),
          checkOut:  newCheckOut,
          priceType: booking.priceType,
          policy, branch,
          adults:    booking.adults,
          children:  booking.children,
          maxAdults, maxChildren, maxOccupancy,
        })
        if (!surchargeResult.error && Array.isArray(surchargeResult.breakdown)) {
          const surchargeOnly = surchargeResult.breakdown.filter(b => {
            if (b.type !== 'surcharge') return false
            const lbl = String(b.label || '')
            // Bỏ "Nhận phòng sớm" (không áp dụng cho giai đoạn sau transfer) + "Trả phòng muộn"
            return !lbl.includes('Nhận phòng sớm')
                && !lbl.includes('early_checkin')
                && !lbl.includes('Trả phòng muộn')
                && !lbl.includes('late_checkout')
          })
          for (const sur of surchargeOnly) {
            breakdownItems.push({
              label:  `[${lastTransfer.toRoomNumber}] ${sur.label}`,
              amount: sur.amount,
              type:   'surcharge',
              meta:   { ...(sur.meta || {}), roomNumber: lastTransfer.toRoomNumber },
            })
          }
        }
      } catch (surErr) {
        console.warn('[changeDates] surcharge calc failed:', surErr.message)
      }

      // roomAmount KHÔNG bao gồm fee chuyển phòng (fee được track riêng trong booking.transferFee)
      const newRoomAmount = breakdownItems
        .filter(b => !(b.meta && b.meta.transferFee))
        .reduce((s, b) => s + (b.amount || 0), 0)

      // ⭐ FIX 19/05/2026 v3: Tính lại nights theo actualCheckIn / newCheckOut.
      //   Trước đây giữ booking.nights → khi đổi ngày trả, nights không update.
      //   Dùng dayStart-based diff: nights = ceil(ngày trả - ngày nhận thực tế).
      const actualCIForNights = booking.actualCheckIn ?? newCheckIn
      const dayStartOf = (d) => {
        const x = new Date(d)
        x.setHours(0, 0, 0, 0)
        return x
      }
      const newNights = Math.max(1, Math.round(
        (dayStartOf(newCheckOut) - dayStartOf(actualCIForNights)) / 86400000
      ))

      priceResult = {
        roomAmount:        newRoomAmount,
        nights:            newNights,
        breakdown:         breakdownItems,
        finalPriceType:    booking.priceType,
        converted:         false,
        notice:            null,
      }
    } else {
      priceResult = calculatePrice({
        checkIn: newCheckIn, checkOut: newCheckOut,
        priceType: booking.priceType, policy, branch,
        adults: booking.adults, children: booking.children, maxAdults, maxChildren, maxOccupancy,
      })
    }

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
    // ⭐ FIX 19/05/2026: Lưu priceBreakdown mới vào DB (trước đây chỉ trả response).
    //   Nếu không lưu, mode='checkout' của calculateBill sẽ đọc DB stale.
    if (Array.isArray(priceResult.breakdown)) {
      booking.priceBreakdown = priceResult.breakdown.map(b => ({
        label:  b.label,
        amount: b.amount,
        type:   b.type,
        meta:   b.meta || {},
      }))
    }
    // ⭐ FIX 19/05/2026: Include transferFee trong totalAmount (trước đây bỏ sót).
    booking.totalAmount = Math.max(0,
      priceResult.roomAmount
        + (booking.servicesAmount ?? 0)
        - (booking.discount ?? 0)
        + (booking.transferFee ?? 0)
    )

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

    // ⭐ FIX 07/05/2026: Cùng logic như changeDates()
    //   - Sub-room đã `checked_in` → newCheckIn không được tương lai
    //   - Sub-room `reserved/confirmed` → newCheckIn không được quá khứ
    //   - newCheckOut không được quá khứ (cả 2 trường hợp)
    {
      const now = new Date()
      const nowMs = now.getTime()
      const tolerance = 60 * 1000

      if (subRoom.status === 'checked_in') {
        if (newCheckIn.getTime() > nowMs + tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_FUTURE_ACTUAL_CHECKIN',
            message: `Phòng ${subRoom.roomNumber} đã nhận — giờ nhận phòng thực tế (${newCheckIn.toLocaleString('vi-VN')}) không được ở tương lai so với hiện tại (${now.toLocaleString('vi-VN')}).`,
            data: {
              now, requestedCheckIn: newCheckIn,
              roomNumber: subRoom.roomNumber,
              currentStatus: subRoom.status,
              currentActualCheckIn: subRoom.actualCheckIn,
            },
          })
        }
      } else {
        if (newCheckIn.getTime() < nowMs - tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PAST_CHECKIN',
            message: `Không thể đổi giờ nhận phòng ${subRoom.roomNumber} sang quá khứ (${newCheckIn.toLocaleString('vi-VN')}).`,
            data: { now, requestedCheckIn: newCheckIn, roomNumber: subRoom.roomNumber },
          })
        }
      }

      if (newCheckOut.getTime() < nowMs - tolerance) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_PAST_CHECKOUT',
          message: `Không thể đổi giờ trả phòng ${subRoom.roomNumber} sang quá khứ (${newCheckOut.toLocaleString('vi-VN')}).`,
          data: { now, requestedCheckOut: newCheckOut, roomNumber: subRoom.roomNumber },
        })
      }
    }

    const conflictResult = await findOverlapForNewBooking({
      roomId:        subRoomId,
      intervalStart: newCheckIn,
      intervalEnd:   newCheckOut,
      excludeBookingIds: [booking._id],
      actionType:    'reserve',
    })
    if (conflictResult) {
      const { conflict, conflictStart, conflictEnd, conflictStatus, isStillCheckedIn } = conflictResult
      const statusLabel = {
        reserved:   'đã đặt',
        confirmed:  'đã xác nhận',
        checked_in: isStillCheckedIn ? 'đang ở (chưa trả phòng)' : 'đang ở',
      }[conflictStatus] ?? conflictStatus
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_OVERLAP',
        message: isStillCheckedIn
          ? `Phòng ${subRoom.roomNumber} đang có khách ${conflict.customerName} chưa trả phòng. Vui lòng xử lý trả phòng trước.`
          : `Phòng ${subRoom.roomNumber} bị trùng với đặt phòng khác (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          conflictCheckOut:     conflictEnd,
          conflictStatus,
          isStillCheckedIn,
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

    const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
    const priceResult = calculatePrice({
      checkIn:   newCheckIn,
      checkOut:  newCheckOut,
      priceType: subRoom.priceType ?? booking.priceType,
      policy, branch,
      adults:    subRoom.adults    ?? booking.adults,
      children:  subRoom.children  ?? booking.children,
      maxAdults, maxChildren, maxOccupancy,
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

    const moveActionType = booking.status === 'checked_in' ? 'checkin' : 'reserve'
    const moveConflictResult = await findOverlapForNewBooking({
      roomId:        newRoomId,
      intervalStart: checkInRange,
      intervalEnd:   checkOutRange,
      excludeBookingIds: [booking._id],
      actionType:    moveActionType,
    })
    if (moveConflictResult) {
      const { conflict, conflictStart, conflictEnd, conflictStatus, isStillCheckedIn } = moveConflictResult
      const statusLabel = {
        reserved:   'đã đặt',
        confirmed:  'đã xác nhận',
        checked_in: isStillCheckedIn ? 'đang ở (chưa trả phòng)' : 'đang ở',
      }[conflictStatus] ?? conflictStatus
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_OVERLAP',
        message: isStillCheckedIn
          ? `Phòng đích đang có khách ${conflict.customerName} chưa trả phòng. Vui lòng xử lý trả phòng cho khách hiện tại trước.`
          : `Phòng đích đã có khách (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          conflictCheckOut:     conflictEnd,
          conflictStatus,
          isStillCheckedIn,
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
      sourcePriceBreakdown,   // ⭐ NEW: priceBreakdown gốc của phòng cũ — để preserve surcharge "Nhận phòng sớm"
    }) => {
      const newPolicy = await PricePolicy.findById(newPolicyId)
      if (!newPolicy) throw new Error('Không tìm thấy chính sách giá mới')

      const splitAt = transferAt ? new Date(transferAt) : new Date()
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

      // ════════════════════════════════════════════════════════════════════
      // v20.0 (17/05/2026) — Dùng module moveRoomBreakdown thay logic split cũ
      // Logic chuẩn theo spec cuối cùng (9 case).
      // Xem: src/utils/moveRoomBreakdown.js
      // ════════════════════════════════════════════════════════════════════
      const oldRoomType = oldRoom?.typeName || snap?.roomTypeName || ''
      const newRoomType = newRoom.typeName || ''
      const hourSlotsOf = (pol) => {
        if (!pol) return []
        const slots = pol.hourSlots || pol.dayEarlyCheckIn || []
        return slots.map(s => {
          const time = s.time || s.duration || ''
          const m = String(time).match(/(\d+)/)
          const durationHours = m ? parseInt(m[1]) : 2
          return { durationHours, price: s.price || 0 }
        })
      }

      // ⭐ Load branch config để truyền vào moveRoomBreakdown
      const branch = booking.branchId ? await Branch.findById(booking.branchId) : null

      const breakdownInput = {
        actualCheckIn:   new Date(sourceActualCheckIn || sourceCheckIn),
        plannedCheckOut: new Date(sourceCheckOut),
        transferAt:      splitAt,
        oldRoom: {
          number: oldRoomNumber,
          type:   oldRoomType,
          policy: {
            dayPrice:        oldPolicy?.dayPrice || 0,
            hourSlots:       oldPolicy?.hourSlots || [],
            dayCheckInTime:  oldPolicy?.dayCheckInTime || '14:00',
            dayCheckOutTime: oldPolicy?.dayCheckOutTime || '12:00',
            dayEarlyCheckIn: oldPolicy?.dayEarlyCheckIn || [],
            dayLateCheckOut: oldPolicy?.dayLateCheckOut || [],
          },
        },
        newRoom: {
          number: newRoom.number,
          type:   newRoomType,
          policy: {
            dayPrice:        newPolicy?.dayPrice || 0,
            hourSlots:       newPolicy?.hourSlots || [],
            dayCheckInTime:  newPolicy?.dayCheckInTime || '14:00',
            dayCheckOutTime: newPolicy?.dayCheckOutTime || '12:00',
            dayEarlyCheckIn: newPolicy?.dayEarlyCheckIn || [],
            dayLateCheckOut: newPolicy?.dayLateCheckOut || [],
          },
        },
        transferFee: 0,    // fee được handle riêng ở booking.transferFee
        changeRate:  oldRoomType !== newRoomType,  // chỉ đổi rate khi khác loại
        isFreeRoom:  !!booking.isFreeRoom,
        branchConfig: branch ? {
          checkInTime:        branch.checkInTime,
          checkOutTime:       branch.checkOutTime,
          earlyCheckinUntil:  branch.earlyCheckinUntil ?? 5,
          toleranceMinutes:   branch.toleranceMinutes ?? 15,
          dayEquivalentHours: branch.dayEquivalentHours ?? 23,
        } : null,
      }

      let items = []
      try {
        items = computeMoveRoomBreakdown(breakdownInput)
      } catch (e) {
        console.error('[moveRoom v20] compute error:', e.message)
        // Fallback: giữ amount cũ, không inject breakdown sai
        return {
          roomAmount: currentRoomAmount,
          priceBreakdown: [],
          usedSplit: splitAt,
          newPolicy,
          newMaxAdults,
          newMaxChildren,
        }
      }

      // Loại bỏ fee item (BE handle riêng qua booking.transferFee)
      const breakdownItems = items
        .filter(it => !(it.meta && it.meta.transferFee))
        .map(it => ({
          label: it.label,
          amount: it.amount,
          type: it.type === 'surcharge' ? 'surcharge' : 'base',
          meta: it.meta || {},
        }))

      // ⭐ FIX 18/05/2026 (v20.1) — PRESERVE surcharge "Nhận phòng sớm" của phòng cũ
      //   moveRoomBreakdown CHỈ tính tiền phòng base, không có surcharge.
      //   Nhưng "Nhận phòng sớm" của phòng CŨ (201) là sự kiện đã xảy ra lúc CI thật
      //   → PHẢI giữ lại trong priceBreakdown sau move, nếu không sẽ MẤT 100K phụ thu.
      //
      //   Lấy từ sourcePriceBreakdown (caller truyền vào): booking.priceBreakdown (single)
      //   hoặc subRoom.priceBreakdown (group). Filter type='surcharge' + label early CI.
      const sourceBreakdown = Array.isArray(sourcePriceBreakdown) ? sourcePriceBreakdown : []
      const preservedEarlyCI = sourceBreakdown
        .filter(b => {
          if (b?.type !== 'surcharge') return false
          const lbl = String(b?.label || '')
          return lbl.includes('Nhận phòng sớm') || lbl.includes('early_checkin')
        })
        .map(b => {
          const plain = (b && typeof b.toObject === 'function') ? b.toObject() : b
          const lblRaw = String(plain.label || '')
          const hasPrefix = /^\[[^\]]+\]\s/.test(lblRaw)
          return {
            label: hasPrefix ? lblRaw : `[${oldRoomNumber}] ${lblRaw}`,
            amount: plain.amount || 0,
            type: 'surcharge',
            meta: { ...(plain.meta || {}), roomNumber: oldRoomNumber, preserved: true },
          }
        })

      // Đặt early-CI surcharge ngay sau item base đầu tiên của phòng cũ (vị trí tự nhiên)
      const finalBreakdown = [...breakdownItems]
      if (preservedEarlyCI.length > 0) {
        let insertAt = -1
        for (let i = finalBreakdown.length - 1; i >= 0; i--) {
          const it = finalBreakdown[i]
          const itRoomNum = it?.meta?.roomNumber
          if (it?.type === 'base' && String(itRoomNum) === String(oldRoomNumber)) {
            insertAt = i + 1
            break
          }
        }
        if (insertAt < 0) insertAt = finalBreakdown.length
        finalBreakdown.splice(insertAt, 0, ...preservedEarlyCI)
      }

      const totalAmount = finalBreakdown.reduce((s, b) => s + (b.amount || 0), 0)

      return {
        roomAmount:     totalAmount,
        priceBreakdown: finalBreakdown,
        usedSplit:      splitAt,
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
          sourcePriceBreakdown: subRoom.priceBreakdown ?? [],  // ⭐ FIX v20.1: preserve "Nhận phòng sớm"
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
        sourcePriceBreakdown: booking.priceBreakdown ?? [],  // ⭐ FIX v20.1: preserve "Nhận phòng sớm"
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
      const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
      const capacity    = room?.typeId?.capacity ?? (maxAdults + maxChildren)

      // ⭐ FIX 18/05/2026: Auto-fallback priceType nếu policy mới KHÔNG enable loại cũ
      //   Ví dụ: booking đang là 'hour', đổi sang policy chỉ có 'day' → tự đổi sang 'day'
      //   Ưu tiên: day > night > hour > week > month (theo nhu cầu thực tế khách sạn)
      let resolvedPriceType = booking.priceType
      const enableMap = {
        hour:  policy.hourEnabled,
        day:   policy.dayEnabled,
        night: policy.nightEnabled,
        week:  policy.weekEnabled,
        month: policy.monthEnabled,
      }
      if (!enableMap[resolvedPriceType]) {
        // Tìm loại enable đầu tiên theo thứ tự ưu tiên
        const priority = ['day', 'night', 'hour', 'week', 'month']
        const fallback = priority.find(t => enableMap[t] === true)
        if (fallback) {
          console.log(`[changePolicy] Auto-switch priceType: ${booking.priceType} → ${fallback} (policy "${policy.name}" không hỗ trợ ${booking.priceType})`)
          resolvedPriceType = fallback
        }
      }

      const result = calculatePrice({
        checkIn:   booking.checkIn,
        checkOut:  booking.checkOut,
        priceType: resolvedPriceType,
        policy, branch,
        adults:    booking.adults,
        children:  booking.children,
        maxAdults, maxChildren, maxOccupancy,
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
      // ⭐ Cập nhật priceType nếu đã auto-switch
      if (resolvedPriceType !== booking.priceType) {
        booking.priceType = resolvedPriceType
      }
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

    // ⭐ FIX 07/05/2026: Không cho check-in nếu giờ trả phòng dự kiến đã qua
    //   Vd: booking 07/05 14:00 → 07/05 20:00, hiện tại 22:00 → KHÔNG cho check-in
    //   Lý do: check-in vào giờ này = booking đã hoàn toàn ở quá khứ, vô nghĩa
    //   Cách xử lý: cần đổi giờ trả phòng (changeDates) trước rồi mới check-in được
    if (booking.checkOut && new Date(booking.checkOut) < now) {
      return res.status(400).json({
        success: false,
        code: 'CHECKOUT_IN_PAST',
        message: `Không thể nhận phòng — giờ trả phòng dự kiến (${new Date(booking.checkOut).toLocaleString('vi-VN')}) đã qua so với hiện tại (${now.toLocaleString('vi-VN')}). Vui lòng đổi giờ trả phòng (Đổi ngày ở) sang tương lai trước khi nhận phòng.`,
        data: {
          now,
          scheduledCheckOut: booking.checkOut,
          bookingId: booking._id,
          customerName: booking.customerName,
          roomNumber: booking.roomNumber,
        },
      })
    }

    const intervalStart = now < booking.checkIn ? now : booking.checkIn
    const intervalEnd   = booking.checkOut

    const checkConflictForCheckin = async (roomId, roomLabel) => {
      const conflictResult = await findOverlapForNewBooking({
        roomId,
        intervalStart,
        intervalEnd,
        excludeBookingIds: [booking._id],
        actionType:    'checkin',
      })
      if (conflictResult) {
        const { conflict, conflictStart, conflictEnd, conflictStatus, isStillCheckedIn } = conflictResult
        const statusLabel = {
          reserved:   'đã đặt',
          confirmed:  'đã xác nhận',
          checked_in: isStillCheckedIn ? 'đang ở (chưa trả phòng)' : 'đang ở',
        }[conflictStatus] ?? conflictStatus
        return {
          success: false,
          code: 'CONFLICT_OVERLAP',
          message: isStillCheckedIn
            ? `Không thể check-in${roomLabel ? ` phòng ${roomLabel}` : ''} — phòng đang có khách ${conflict.customerName} chưa trả phòng (dự kiến trả ${new Date(conflictEnd).toLocaleString('vi-VN')}). Vui lòng xử lý trả phòng cho khách hiện tại trước.`
            : `Không thể check-in${roomLabel ? ` phòng ${roomLabel}` : ''} vào lúc ${now.toLocaleString('vi-VN')} — phòng đang có khách (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}. Vui lòng đợi đến sau khi khách trên trả phòng hoặc đổi phòng khác.`,
          data: {
            conflictBookingId:    conflict._id,
            conflictCustomerName: conflict.customerName,
            conflictCheckIn:      conflictStart,
            conflictCheckOut:     conflictEnd,
            conflictStatus,
            isStillCheckedIn,
            attemptedCheckInAt:   now,
            bookingScheduledCheckIn: booking.checkIn,
          },
        }
      }
      return null
    }

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

    const subCheckIn  = sub.checkIn  ?? booking.checkIn
    const subCheckOut = sub.checkOut ?? booking.checkOut

    // ⭐ FIX 07/05/2026: Không cho check-in nếu giờ trả phòng dự kiến đã qua
    if (subCheckOut && new Date(subCheckOut) < now) {
      return res.status(400).json({
        success: false,
        code: 'CHECKOUT_IN_PAST',
        message: `Không thể nhận phòng ${sub.roomNumber} — giờ trả phòng dự kiến (${new Date(subCheckOut).toLocaleString('vi-VN')}) đã qua so với hiện tại (${now.toLocaleString('vi-VN')}). Vui lòng đổi giờ trả phòng (Đổi ngày ở) sang tương lai trước khi nhận phòng.`,
        data: {
          now,
          scheduledCheckOut: subCheckOut,
          bookingId: booking._id,
          customerName: booking.customerName,
          roomNumber: sub.roomNumber,
        },
      })
    }

    const intervalStart = now < subCheckIn ? now : subCheckIn
    const intervalEnd   = subCheckOut

    const conflictResult = await findOverlapForNewBooking({
      roomId:        String(sub.roomId._id ?? sub.roomId),
      intervalStart,
      intervalEnd,
      excludeBookingIds: [booking._id],
      actionType:    'checkin',
    })
    if (conflictResult) {
      const { conflict, conflictStart, conflictEnd, conflictStatus, isStillCheckedIn } = conflictResult
      const statusLabel = {
        reserved:   'đã đặt',
        confirmed:  'đã xác nhận',
        checked_in: isStillCheckedIn ? 'đang ở (chưa trả phòng)' : 'đang ở',
      }[conflictStatus] ?? conflictStatus
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_OVERLAP',
        message: isStillCheckedIn
          ? `Không thể check-in phòng ${sub.roomNumber} — phòng đang có khách ${conflict.customerName} chưa trả phòng (dự kiến trả ${new Date(conflictEnd).toLocaleString('vi-VN')}). Vui lòng xử lý trả phòng cho khách hiện tại trước.`
          : `Không thể check-in phòng ${sub.roomNumber} vào lúc ${now.toLocaleString('vi-VN')} — phòng đang có khách (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}.`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          conflictCheckOut:     conflictEnd,
          conflictStatus,
          isStillCheckedIn,
          attemptedCheckInAt:   now,
          bookingScheduledCheckIn: subCheckIn,
        },
      })
    }

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

const checkout = async (req, res, next) => {
  try {
    const { actualCheckOut } = req.body
    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (booking.status !== 'checked_in')
      return res.status(400).json({ success: false, message: `Không thể check-out từ trạng thái: ${booking.status}` })

    const actualCO = actualCheckOut ? new Date(actualCheckOut) : new Date()

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

        const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
        // ⭐ FIX 18/05/2026: Nếu booking có transferHistory → dùng moveRoomBreakdown
        //   để tính tiền phòng theo từng đoạn (giống calculate-bill nhánh hasTransferred).
        //   calculatePrice thẳng sẽ tính toàn bộ thời gian theo policy phòng MỚI →
        //   không bằng "tiền phòng cũ + tiền phòng mới" → lệch số.
        const hasTransfer = Array.isArray(booking.transferHistory) && booking.transferHistory.length > 0

        if (hasTransfer) {
          const transfers = booking.transferHistory
            .filter(t => t?.transferAt && t?.fromRoomNumber && t?.toRoomNumber)
            .sort((a, b) => new Date(a.transferAt) - new Date(b.transferAt))
          const lastTransfer = transfers[transfers.length - 1]

          // Resolve old policy (phòng cũ trước transfer)
          let oldPolicy = null
          if (lastTransfer?.oldPolicyId) {
            try { oldPolicy = await PricePolicy.findById(lastTransfer.oldPolicyId) } catch {}
          }
          if (!oldPolicy && booking.policySnapshot && booking.policySnapshot.dayPrice) {
            oldPolicy = booking.policySnapshot
          }

          // Resolve room types
          let oldRoomType = ''
          try {
            const oldRoomDoc = await Room.findOne({
              number: lastTransfer.fromRoomNumber,
              branchId: booking.branchId,
            }).populate('typeId')
            if (oldRoomDoc) {
              oldRoomType = oldRoomDoc.typeId?.name || oldRoomDoc.typeName || ''
            }
          } catch {}
          const newRoomType = room?.typeId?.name || booking.roomType || ''

          const hourSlotsOf = (pol) => {
            if (!pol) return []
            return (pol.hourSlots || []).map(s => {
              const time = s.time || s.duration || ''
              const m = String(time).match(/(\d+)/)
              return { durationHours: m ? parseInt(m[1]) : 2, price: s.price || 0 }
            })
          }

          const moveItems = computeMoveRoomBreakdown({
            actualCheckIn:   booking.actualCheckIn ?? booking.checkIn,
            // ⭐ FIX 19/05/2026 v2: plannedCheckOut = min(booking.checkOut, actualCO)
            //   - actualCO > booking.checkOut (overstay): dùng booking.checkOut, phần trễ
            //     được calculatePrice push "Trả phòng muộn" surcharge phía dưới.
            //   - actualCO < booking.checkOut (trả sớm / past-checkout): dùng actualCO,
            //     module tính đến đúng giờ trả sớm, KHÔNG tính dư.
            plannedCheckOut: actualCO < new Date(booking.checkOut)
              ? actualCO
              : new Date(booking.checkOut),
            transferAt:      new Date(lastTransfer.transferAt),
            oldRoom: {
              number: lastTransfer.fromRoomNumber,
              type:   oldRoomType,
              policy: {
                dayPrice:        oldPolicy?.dayPrice || 0,
                hourSlots:       oldPolicy?.hourSlots || [],
                dayCheckInTime:  oldPolicy?.dayCheckInTime || '14:00',
                dayCheckOutTime: oldPolicy?.dayCheckOutTime || '12:00',
                dayEarlyCheckIn: oldPolicy?.dayEarlyCheckIn || [],
                dayLateCheckOut: oldPolicy?.dayLateCheckOut || [],
              },
            },
            newRoom: {
              number: lastTransfer.toRoomNumber,
              type:   newRoomType,
              policy: {
                dayPrice:        policy?.dayPrice || 0,
                hourSlots:       policy?.hourSlots || [],
                dayCheckInTime:  policy?.dayCheckInTime || '14:00',
                dayCheckOutTime: policy?.dayCheckOutTime || '12:00',
                dayEarlyCheckIn: policy?.dayEarlyCheckIn || [],
                dayLateCheckOut: policy?.dayLateCheckOut || [],
              },
            },
            transferFee: Number(lastTransfer.fee) || 0,
            changeRate:  oldRoomType !== newRoomType,
            isFreeRoom:  !!booking.isFreeRoom,
            branchConfig: branch ? {
              checkInTime:        branch.checkInTime,
              checkOutTime:       branch.checkOutTime,
              earlyCheckinUntil:  branch.earlyCheckinUntil ?? 5,
              toleranceMinutes:   branch.toleranceMinutes ?? 15,
              dayEquivalentHours: branch.dayEquivalentHours ?? 23,
            } : null,
          })

          const breakdownItems = moveItems.map(it => ({
            label:  it.label,
            amount: it.amount,
            type:   it.type === 'surcharge' ? 'surcharge' : 'base',
            meta:   it.meta || {},
          }))

          // Bổ sung phụ thu (extra people, late checkout) theo policy phòng mới từ transferAt → actualCO
          try {
            const surchargeResult = calculatePrice({
              checkIn:   new Date(lastTransfer.transferAt),
              checkOut:  actualCO,
              priceType: booking.priceType,
              policy, branch,
              adults:    booking.adults,
              children:  booking.children,
              maxAdults, maxChildren, maxOccupancy,
            })
            if (!surchargeResult.error && Array.isArray(surchargeResult.breakdown)) {
              const surchargeOnly = surchargeResult.breakdown.filter(b => b.type === 'surcharge')
              for (const sur of surchargeOnly) {
                breakdownItems.push({
                  label:  `[${lastTransfer.toRoomNumber}] ${sur.label}`,
                  amount: sur.amount,
                  type:   'surcharge',
                  meta:   { ...(sur.meta || {}), roomNumber: lastTransfer.toRoomNumber },
                })
              }
            }
          } catch (surErr) {
            console.warn('[checkout v20] surcharge calc failed:', surErr.message)
          }

          const newRoomAmount = breakdownItems
            .filter(b => !(b.meta && b.meta.transferFee))
            .reduce((s, b) => s + (b.amount || 0), 0)

          let recalcDiscount = booking.discount ?? 0
          if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
            const roomPart = booking.isFreeRoom ? 0 : newRoomAmount
            const subtotal = roomPart + (booking.servicesAmount ?? 0)
            const pctDiscount = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
            recalcDiscount = pctDiscount + (booking.discountAmount ?? 0)
          }

          const roomPart = booking.isFreeRoom ? 0 : newRoomAmount
          booking.roomAmount     = newRoomAmount
          booking.priceBreakdown = breakdownItems
          booking.discount       = recalcDiscount
          // ⭐ KHÔNG cộng booking.transferFee thêm vì đã filter bỏ fee item khỏi roomAmount
          //    (fee được track riêng trong booking.transferFee, nhưng đã có dòng "Phụ thu chuyển phòng"
          //     trong breakdown nếu lastTransfer.fee > 0 — em filter bỏ ra khỏi roomAmount để
          //     totalAmount = roomAmount + transferFee không double count)
          booking.totalAmount    = Math.max(0, roomPart + (booking.servicesAmount ?? 0) - recalcDiscount + (booking.transferFee || 0))
        } else {
          const priceResult = calculatePrice({
            checkIn:   booking.actualCheckIn ?? booking.checkIn,
            checkOut:  actualCO,
            priceType: booking.priceType,
            policy, branch,
            adults:    booking.adults,
            children:  booking.children,
            maxAdults, maxChildren, maxOccupancy,
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
            booking.totalAmount    = Math.max(0, roomPart + (booking.servicesAmount ?? 0) - recalcDiscount + (booking.transferFee || 0))
          }
        }
      } catch (calcErr) {
        console.error('Recalc on checkout failed:', calcErr)
      }
    }

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

          const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
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
              maxAdults, maxChildren, maxOccupancy,
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
              maxAdults, maxChildren, maxOccupancy,
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
    // ⭐ FIX 11/05/2026: Chặn nếu khách trả DƯ (paid > total)
    //   Trước đây code chỉ check owed > 0. Khi paid > total (vd nợ 300 khách
    //   đưa 500 dư 200), owed = -200 (âm) → cho qua bug.
    //   Đúng business: bắt buộc hoàn trả phần dư cho khách trước khi trả phòng.
    if (owed < 0) {
      const overpaid = Math.abs(owed)
      return res.status(400).json({
        success: false,
        message: `Không thể trả phòng — khách đã trả DƯ ${overpaid.toLocaleString('vi-VN')} VND. Vui lòng hoàn trả ${overpaid.toLocaleString('vi-VN')} VND cho khách trước khi trả phòng.`,
        code: 'OVERPAID',
        data: {
          overpaid,
          totalAmount: newTotal,
          paidAmount:  invPaid,
        },
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

        const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
        const priceResult = calculatePrice({
          checkIn:   sub.actualCheckIn ?? sub.checkIn ?? booking.checkIn,
          checkOut:  actualCO,
          priceType: sub.priceType ?? booking.priceType,
          policy, branch,
          adults:    sub.adults   ?? booking.adults,
          children:  sub.children ?? booking.children,
          maxAdults, maxChildren, maxOccupancy,
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
              maxAdults, maxChildren, maxOccupancy,
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
      // ⭐ FIX 11/05/2026: Chặn nếu đoàn trả DƯ (paid > total)
      const overpaidGroup = invoicePaid - newTotalAmount
      if (overpaidGroup > 0) {
        return res.status(400).json({
          success: false,
          message: `Đây là phòng cuối — đoàn đã trả DƯ ${overpaidGroup.toLocaleString('vi-VN')} VND. Vui lòng hoàn trả phần dư cho khách trước khi trả phòng.`,
          code: 'OVERPAID',
          data: {
            overpaid:    overpaidGroup,
            totalAmount: newTotalAmount,
            paidAmount:  invoicePaid,
          },
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
      // ⭐ FIX 11/05/2026: Chặn nếu phòng đã trả DƯ
      const overpaidSub = subPaidAmount - subTotalAmount
      if (overpaidSub > 0 && !skipPayment) {
        return res.status(400).json({
          success: false,
          message: `Phòng ${sub.roomNumber} đã trả DƯ ${overpaidSub.toLocaleString('vi-VN')} VND. Vui lòng hoàn trả phần dư cho khách trước khi trả phòng.`,
          code: 'OVERPAID_FOR_ROOM',
          data: {
            roomId:        String(sub.roomId?._id ?? sub.roomId),
            roomNumber:    sub.roomNumber,
            overpaid:      overpaidSub,
            subTotalAmount,
            subPaidAmount,
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

    // ⭐ FIX: Tự xử lý conflict thay vì query Mongo trực tiếp
    //   actionType='reserve' vì đây là tìm phòng để ĐẶT (cho phép đặt sau khoảng A đang ở)
    const bookedRoomIds = new Set()
    for (const room of allRooms) {
      const conflictResult = await findOverlapForNewBooking({
        roomId:        room._id,
        intervalStart: checkInDate,
        intervalEnd:   checkOutDate,
        excludeBookingIds: excludeBookingId ? [excludeBookingId] : [],
        actionType:    'reserve',
      })
      if (conflictResult) {
        bookedRoomIds.add(String(room._id))
      }
    }

    const available = allRooms.filter(r => !bookedRoomIds.has(r._id.toString()))

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

    // ⭐ FIX 19/05/2026 v3: Cộng transferFee vào totalAmount (trước đây bỏ sót).
    //   Fallback từ transferHistory nếu booking.transferFee chưa sync.
    const historyFee = Array.isArray(booking.transferHistory)
      ? booking.transferHistory.reduce((s, t) => s + (Number(t?.fee) || 0), 0)
      : 0
    const transferFee = Math.max(booking.transferFee ?? 0, historyFee)
    booking.totalAmount = Math.max(0,
      roomPart + (booking.servicesAmount ?? 0) - totalDiscount + transferFee
    )

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

        const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
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
              maxAdults, maxChildren, maxOccupancy,
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
              maxAdults, maxChildren, maxOccupancy,
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

    const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
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
    } else if (hasTransferred) {
      // ⭐ FIX 19/05/2026: Gộp 2 mode 'now' và 'checkout' vào chung logic v20.1.
      //   Khác biệt duy nhất: effectiveCheckOut.
      //     - mode='now'      → now()           → có overstay → push "Trả phòng muộn"
      //     - mode='checkout' → booking.checkOut → không overstay → không push
      //   Nhánh cũ mode='checkout' đọc thẳng booking.priceBreakdown/roomAmount — sai
      //   khi DB stale (vd: sau changeDates với booking đã transfer thì DB lưu giá
      //   theo policy phòng MỚI × toàn bộ thời gian, không phân đoạn cũ/mới).
      //   v20.0: Dùng moveRoomBreakdown để tính breakdown đúng spec
      //   Replay lần transfer cuối với plannedCheckOut = booking.checkOut (giờ trả CHUẨN)

      // ⭐ FIX 19/05/2026 v3: Multi-transfer fallback.
      //   computeMoveRoomBreakdown chỉ build cho 1 transfer. Với ≥ 2 transfer,
      //   booking.priceBreakdown được build incrementally trong moveRoom handler
      //   (mỗi lần move thêm seg mới). Recompute từ đầu sẽ mất segment trung gian.
      //   → Ưu tiên đọc từ DB, không recompute.
      const transferCount = (booking.transferHistory ?? []).length
      if (transferCount >= 2) {
        priceResult = {
          roomAmount:       booking.roomAmount,
          nights:           booking.nights,
          breakdown:        booking.priceBreakdown ?? [],
          finalPriceType:   booking.priceType,
          converted:        false,
          notice:           `Booking đã chuyển phòng ${transferCount} lần — breakdown đọc từ DB`,
        }
        // Thêm late checkout surcharge nếu effectiveCheckOut > booking.checkOut
        if (mode === 'now' && effectiveCheckOut > new Date(booking.checkOut)) {
          try {
            const lateMs = effectiveCheckOut.getTime() - new Date(booking.checkOut).getTime()
            const lateH = Math.floor(lateMs / 3600000)
            const lateM = Math.round((lateMs % 3600000) / 60000)
            const lateLabel = lateH >= 24
              ? `Trả phòng muộn (${Math.floor(lateH / 24)}d ${lateH % 24}h)`
              : `Trả phòng muộn (${lateH}h${lateM > 0 ? lateM + 'm' : ''})`
            // Tính phí trễ = calculatePrice từ booking.checkOut → now
            const lateResult = calculatePrice({
              checkIn:   new Date(booking.checkOut),
              checkOut:  effectiveCheckOut,
              priceType: booking.priceType,
              policy, branch,
              adults:    booking.adults,
              children:  booking.children,
              maxAdults, maxChildren, maxOccupancy,
            })
            const lateAmount = lateResult?.roomAmount || 0
            if (lateAmount > 0) {
              priceResult.breakdown = [
                ...priceResult.breakdown,
                {
                  label:  `[${booking.roomNumber}] ${lateLabel}`,
                  amount: lateAmount,
                  type:   'surcharge',
                  meta:   { roomNumber: booking.roomNumber, lateCheckout: true },
                },
              ]
              priceResult.roomAmount += lateAmount
            }
          } catch (e) {
            console.warn('[calculateBill multi-transfer] late checkout calc failed:', e.message)
          }
        }
      } else {
      try {
        const oldRoomNum = lastTransfer.fromRoomNumber
        const newRoomNum = lastTransfer.toRoomNumber

        // Resolve policies
        let oldPolicy = null
        if (lastTransfer.oldPolicyId) {
          oldPolicy = await PricePolicy.findById(lastTransfer.oldPolicyId)
        }
        if (!oldPolicy && booking.policySnapshot && booking.policySnapshot.dayPrice) {
          oldPolicy = booking.policySnapshot
        }
        const newPolicy = policy  // policy hiện tại = phòng mới

        // Resolve room types từ Room collection
        let oldRoomType = ''
        let newRoomType = booking.roomType || ''
        try {
          const oldRoomDoc = await Room.findOne({
            number: oldRoomNum, branchId: booking.branchId,
          }).populate('typeId')
          if (oldRoomDoc) {
            oldRoomType = oldRoomDoc.typeId?.name || oldRoomDoc.typeName || ''
          }
        } catch (_) {}

        const hourSlotsOf = (pol) => {
          if (!pol) return []
          return (pol.hourSlots || []).map(s => {
            const time = s.time || s.duration || ''
            const m = String(time).match(/(\d+)/)
            return {
              durationHours: m ? parseInt(m[1]) : 2,
              price: s.price || 0,
            }
          })
        }

        const items = computeMoveRoomBreakdown({
          actualCheckIn:   effectiveCheckIn,
          // ⭐ FIX 19/05/2026 v2: plannedCheckOut = min(booking.checkOut, effectiveCheckOut)
          //   - effectiveCheckOut > booking.checkOut (overstay): dùng booking.checkOut,
          //     phần trễ được block baseline-vs-overstay (3609–3656) push "Trả phòng muộn"
          //   - effectiveCheckOut < booking.checkOut (trả sớm / past-checkout): dùng
          //     effectiveCheckOut, module tính đến đúng giờ trả sớm, KHÔNG tính dư.
          //   Phiên bản cũ luôn dùng booking.checkOut → tính dư khi past-checkout < planned CO.
          plannedCheckOut: effectiveCheckOut < new Date(booking.checkOut)
            ? effectiveCheckOut
            : new Date(booking.checkOut),
          transferAt:      new Date(lastTransfer.transferAt),
          oldRoom: {
            number: oldRoomNum,
            type:   oldRoomType,
            policy: {
              dayPrice:        oldPolicy?.dayPrice || 0,
              hourSlots:       oldPolicy?.hourSlots || [],
              dayCheckInTime:  oldPolicy?.dayCheckInTime || '14:00',
              dayCheckOutTime: oldPolicy?.dayCheckOutTime || '12:00',
              dayEarlyCheckIn: oldPolicy?.dayEarlyCheckIn || [],
              dayLateCheckOut: oldPolicy?.dayLateCheckOut || [],
            },
          },
          newRoom: {
            number: newRoomNum,
            type:   newRoomType,
            policy: {
              dayPrice:        newPolicy?.dayPrice || 0,
              hourSlots:       newPolicy?.hourSlots || [],
              dayCheckInTime:  newPolicy?.dayCheckInTime || '14:00',
              dayCheckOutTime: newPolicy?.dayCheckOutTime || '12:00',
              dayEarlyCheckIn: newPolicy?.dayEarlyCheckIn || [],
              dayLateCheckOut: newPolicy?.dayLateCheckOut || [],
            },
          },
          // ⭐ FIX: Truyền fee từ transferHistory để module sinh dòng phụ thu
          //   booking.transferFee là TỔNG dồn các lần chuyển — đây chỉ lấy fee lần cuối
          transferFee: Number(lastTransfer.fee) || 0,
          changeRate:  oldRoomType !== newRoomType,
          isFreeRoom:  !!booking.isFreeRoom,
          branchConfig: branch ? {
            checkInTime:        branch.checkInTime,
            checkOutTime:       branch.checkOutTime,
            earlyCheckinUntil:  branch.earlyCheckinUntil ?? 5,
            toleranceMinutes:   branch.toleranceMinutes ?? 15,
            dayEquivalentHours: branch.dayEquivalentHours ?? 23,
          } : null,
        })

        // ⭐ FIX: KHÔNG filter fee item nữa — để nó hiển thị trong breakdown
        //   Nhưng phải cẩn thận: không double count với booking.transferFee đã cộng vào totalAmount
        const breakdownItems = items.map(it => ({
          label: it.label,
          amount: it.amount,
          type: it.type === 'surcharge' ? 'surcharge' : 'base',
          meta: it.meta || {},
        }))

        // ⭐ FIX 18/05/2026 (v20.1) — Bổ sung phụ thu
        //   moveRoomBreakdown CHỈ trả tiền phòng. Cần thêm:
        //   1. "Nhận phòng sớm" của phòng CŨ → đọc từ booking.priceBreakdown (đã preserve ở moveRoom)
        //   2. "Trả phòng muộn" của phòng MỚI → tính từ giờ chuẩn CO → effectiveCheckOut
        //   3. Phụ thu vượt sức chứa → tính từ phòng MỚI
        //
        //   KHÔNG gọi calculatePrice với checkIn=transferAt vì sẽ sinh "Nhận phòng sớm" SAI
        try {
          // ⭐ FIX 19/05/2026 v21: Bỏ block (1) "PRESERVE Nhận phòng sớm" từ DB.
          //   Module moveRoomBreakdown v21 đã tự tính phụ thu "Nhận phòng sớm" của phòng cũ
          //   dựa trên policy.dayEarlyCheckIn (computeTimeSurcharge) khi actualCheckIn < CI chuẩn
          //   cùng ngày. → KHÔNG cần preserve từ DB nữa (sẽ double count).
          //   Lưu ý: bookings cũ có dòng "Nhận phòng sớm" trong DB sẽ bị "thay thế" bằng
          //   recompute từ policy hiện tại → đảm bảo nhất quán.

          // ── (2) Tính phụ thu CO trễ cho phòng MỚI ──
          //   Approach: Gọi calculatePrice 2 lần:
          //     - Lần 1: với plannedCheckOut (giờ chuẩn) → roomAmount baseline
          //     - Lần 2: với effectiveCheckOut (giờ hiện tại) → roomAmount overstay
          //   Diff = phụ thu CO trễ. Bằng cách này bắt được cả "convert to night" case
          //   (priceCalculator add 1 base night thay vì surcharge khi co.getHours() >= dayEquivHours).
          const newRoomDoc = await Room.findById(booking.roomId).populate('typeId')
          const newMaxAdults    = newRoomDoc?.typeId?.maxAdults   ?? newRoomDoc?.typeId?.capacity ?? 2
          const newMaxChildren  = newRoomDoc?.typeId?.maxChildren ?? 0
          const newMaxOccupancy = newRoomDoc?.typeId?.maxOccupancy ?? (newMaxAdults + newMaxChildren)

          const transferAtDate = new Date(lastTransfer.transferAt)
          const ciHourStr = branch?.checkInTime || '14:00'
          const [ciH, ciM] = String(ciHourStr).split(':').map(Number)
          const standardCIofTransferDay = new Date(transferAtDate)
          standardCIofTransferDay.setHours(ciH || 14, ciM || 0, 0, 0)
          const surchargeCheckIn = transferAtDate > standardCIofTransferDay
            ? transferAtDate
            : standardCIofTransferDay

          // Baseline: với plannedCheckOut (không trễ).
          //   ⭐ FIX 19/05/2026 v2: dùng min(booking.checkOut, effectiveCheckOut) để
          //   khi past-checkout (effectiveCheckOut < booking.checkOut), baseline không
          //   tính dư đêm ở phụ thu vượt sức chứa (NL/TE).
          const baselineCheckOut = effectiveCheckOut < new Date(booking.checkOut)
            ? effectiveCheckOut
            : new Date(booking.checkOut)
          const baselineResult = calculatePrice({
            checkIn:   surchargeCheckIn,
            checkOut:  baselineCheckOut,
            priceType: booking.priceType,
            policy:    newPolicy,
            branch,
            adults:    booking.adults,
            children:  booking.children,
            maxAdults: newMaxAdults,
            maxChildren: newMaxChildren,
            maxOccupancy: newMaxOccupancy,
          })

          const baselineAmount = baselineResult?.roomAmount || 0

          // Overstay: với effectiveCheckOut (= now)
          const overstayResult = calculatePrice({
            checkIn:   surchargeCheckIn,
            checkOut:  effectiveCheckOut,           // ⭐ now
            priceType: booking.priceType,
            policy:    newPolicy,
            branch,
            adults:    booking.adults,
            children:  booking.children,
            maxAdults: newMaxAdults,
            maxChildren: newMaxChildren,
            maxOccupancy: newMaxOccupancy,
          })

          const overstayAmount = overstayResult?.roomAmount || 0
          const overstayDiff = Math.max(0, overstayAmount - baselineAmount)

          // ── Thêm dòng "Trả phòng muộn" nếu có chênh lệch ──
          if (overstayDiff > 0 && effectiveCheckOut > new Date(booking.checkOut)) {
            const lateMs = effectiveCheckOut.getTime() - new Date(booking.checkOut).getTime()
            const lateH = Math.floor(lateMs / 3600000)
            const lateM = Math.round((lateMs % 3600000) / 60000)
            const lateLabel = lateH >= 24
              ? `Trả phòng muộn (${Math.floor(lateH / 24)}d ${lateH % 24}h)`
              : `Trả phòng muộn (${lateH}h${lateM > 0 ? lateM + 'm' : ''})`
            breakdownItems.push({
              label: `[${newRoomNum}] ${lateLabel}`,
              amount: overstayDiff,
              type:   'surcharge',
              meta:   { roomNumber: newRoomNum, lateCheckout: true },
            })
          }

          // ⭐ FIX 19/05/2026 v21: Bỏ block (2.5) cũ.
          //   Module moveRoomBreakdown v21 đã tự tính phụ thu "Trả phòng trễ"
          //   của phòng mới dựa trên policy.dayLateCheckOut khi plannedCheckOut
          //   vượt CO chuẩn cùng ngày → KHÔNG cần BE patch nữa.

          // ── (3) Phụ thu vượt sức chứa (NL/TE) — đọc từ baseline ──
          //   Baseline đã chứa các phụ thu này vì policy có dayAdultSurcharge.
          //   Lấy từ baseline (không từ overstay) để khớp với plannedCheckOut.
          if (baselineResult && Array.isArray(baselineResult.breakdown)) {
            const capacitySurcharges = baselineResult.breakdown.filter(b => {
              if (b.type !== 'surcharge') return false
              const lbl = String(b.label || '')
              // Bỏ "Nhận phòng sớm" (đã preserve ở (1)) + "Trả phòng muộn" (đã thêm ở (2))
              return !lbl.includes('Nhận phòng sớm')
                  && !lbl.includes('early_checkin')
                  && !lbl.includes('Trả phòng muộn')
                  && !lbl.includes('late_checkout')
            })
            for (const sur of capacitySurcharges) {
              breakdownItems.push({
                label: `[${newRoomNum}] ${sur.label}`,
                amount: sur.amount,
                type:   'surcharge',
                meta:   { ...(sur.meta || {}), roomNumber: newRoomNum },
              })
            }
          }
        } catch (surErr) {
          console.warn('[calculateBill v20.1] surcharge calc failed:', surErr.message)
        }

        priceResult = {
          // ⭐ roomAmount = chỉ tiền phòng + phụ thu (không tính fee chuyển phòng vì transferFee tách riêng)
          roomAmount:       breakdownItems
            .filter(b => !(b.meta && b.meta.transferFee))
            .reduce((s, b) => s + (b.amount || 0), 0),
          nights:           booking.nights,
          breakdown:        breakdownItems,
          finalPriceType:   booking.priceType,
          converted:        false,
          notice:           null,
        }
      } catch (e) {
        console.error('[calculateBill v20] move-room compute error:', e.message)
        // Fallback: đọc trực tiếp breakdown đã lưu
        priceResult = {
          roomAmount:       booking.roomAmount,
          nights:           booking.nights,
          breakdown:        booking.priceBreakdown ?? [],
          finalPriceType:   booking.priceType,
          converted:        false,
          notice:           null,
        }
      }
      }  // ⭐ end of else { (multi-transfer fallback)
    } else {
      priceResult = calculatePrice({
        checkIn:   effectiveCheckIn,
        checkOut:  effectiveCheckOut,
        priceType: booking.priceType,
        policy, branch,
        adults:    booking.adults,
        children:  booking.children,
        maxAdults, maxChildren, maxOccupancy,
      })
    }

    if (priceResult.error) {
      console.warn('[calculateBill] priceResult.error:', priceResult.error.message)
    }

    // ⭐ FIX v20.0: Đồng bộ label breakdown giữa mode 'now' và 'checkout'
    //   - Mode 'checkout' đọc từ booking.priceBreakdown (có thể có/không prefix)
    //   - Mode 'now' gọi calculatePrice → label trần "Giá ngày (...)"
    //   → Thêm prefix [roomNumber] vào label của mode 'now' để hiển thị nhất quán.
    //   KHÔNG thêm roomType (chỉ là tên loại phòng) để label gọn hơn.
    if (priceResult.breakdown && Array.isArray(priceResult.breakdown)) {
      const roomNumPrefix = booking.roomNumber || ''
      priceResult.breakdown = priceResult.breakdown.map(b => {
        const lbl = String(b.label || '')
        // Đã có prefix [...] rồi → giữ nguyên
        if (lbl.startsWith('[')) return b
        // Là dòng giá phòng (Giá ngày / Giá đêm / Giá nghỉ giờ) → thêm prefix [roomNumber]
        const isPriceLine = /^Giá\s+(ngày|đêm|nghỉ giờ|giờ|tuần|tháng)/i.test(lbl)
        if (!isPriceLine || !roomNumPrefix) return b
        return { ...b, label: `[${roomNumPrefix}] ${lbl}` }
      })
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
    // ⭐ FIX 19/05/2026 v2: Fallback transferFee từ transferHistory khi booking.transferFee
    //   chưa được sync (booking cũ tạo trước khi có logic cộng dồn vào field này).
    //   Sum tất cả fee trong transferHistory, dùng booking.transferFee nếu nó lớn hơn
    //   (trường hợp đã sync đúng) hoặc giá trị transferHistory (nếu booking.transferFee=0).
    const historyFee = Array.isArray(booking.transferHistory)
      ? booking.transferHistory.reduce((s, t) => s + (Number(t?.fee) || 0), 0)
      : 0
    const transferFee = Math.max(booking.transferFee ?? 0, historyFee)
    const totalAmount = Math.max(0, roomPart + servicesAmount - recalcDiscount + transferFee)

    const invoice = await Invoice.findOne({ bookingId: booking._id })
    const paidAmount      = invoice?.paidAmount ?? 0
    const remainingAmount = Math.max(0, totalAmount - paidAmount)

    // ⭐ FIX 18/05/2026: Strip roomType prefix khỏi label cũ (legacy data)
    //   Label cũ có format: "[604] 1🛏 Deluxe Garden View Room - Giá ngày (...)"
    //   → strip thành: "[604] Giá ngày (...)"
    //   Pattern: [XXX] <bất cứ gì> - Giá <type> (...)  →  [XXX] Giá <type> (...)
    const cleanedBreakdown = (priceResult.breakdown || []).map(b => {
      const lbl = String(b.label || '')
      const stripped = lbl.replace(
        /^(\[[^\]]+\])\s+.+?\s+-\s+(Giá\s+(ngày|đêm|nghỉ giờ|giờ|tuần|tháng))/i,
        '$1 $2'
      )
      return stripped === lbl ? b : { ...b, label: stripped }
    })

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
        breakdown:        cleanedBreakdown,
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

    // ⭐ FIX: Dùng helper findOverlapForNewBooking với actionType='reserve'
    //    để cho phép xem available phòng để ĐẶT trước (kể cả khi A chưa trả)
    const bookedRoomIds = new Set()
    for (const room of allRooms) {
      const conflictResult = await findOverlapForNewBooking({
        roomId:        room._id,
        intervalStart: ci,
        intervalEnd:   co,
        actionType:    'reserve',
      })
      if (conflictResult) {
        bookedRoomIds.add(String(room._id))
      }
    }

    const typeMap = new Map()
    allRooms.forEach(room => {
      const typeId   = String(room.typeId?._id ?? '')
      const typeName = room.typeId?.name ?? room.typeName ?? '—'
      const maxAdults   = room.typeId?.maxAdults   ?? room.typeId?.capacity ?? 2
      const maxChildren = room.typeId?.maxChildren ?? 0
      const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
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

    const willCheckInNowGrp = initialStatus === 'checked_in'
    const nowForGrp = new Date()

    // ⭐ FIX 07/05/2026: Chặn đặt đoàn / nhận đoàn ở quá khứ (giống create())
    {
      const nowMs = nowForGrp.getTime()
      const tolerance = 60 * 1000

      if (!willCheckInNowGrp) {
        if (checkInDate.getTime() < nowMs - tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PAST_CHECKIN',
            message: `Không thể đặt đoàn với giờ nhận phòng (${checkInDate.toLocaleString('vi-VN')}) đã qua. Vui lòng chọn giờ nhận phòng từ ${nowForGrp.toLocaleString('vi-VN')} trở đi.`,
            data: { now: nowForGrp, requestedCheckIn: checkInDate },
          })
        }
        if (checkOutDate.getTime() < nowMs - tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PAST_CHECKOUT',
            message: `Không thể đặt đoàn với giờ trả phòng (${checkOutDate.toLocaleString('vi-VN')}) đã qua.`,
            data: { now: nowForGrp, requestedCheckOut: checkOutDate },
          })
        }
      } else {
        if (checkOutDate.getTime() < nowMs - tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PAST_CHECKOUT',
            message: `Không thể nhận đoàn với giờ trả phòng dự kiến (${checkOutDate.toLocaleString('vi-VN')}) đã qua so với hiện tại (${nowForGrp.toLocaleString('vi-VN')}).`,
            data: { now: nowForGrp, requestedCheckOut: checkOutDate },
          })
        }
      }
    }

    const grpIntervalStart = willCheckInNowGrp && nowForGrp < checkInDate
      ? nowForGrp
      : checkInDate

    for (const r of roomsInput) {
      const conflictResult = await findOverlapForNewBooking({
        roomId:        r.roomId,
        intervalStart: grpIntervalStart,
        intervalEnd:   checkOutDate,
        actionType:    willCheckInNowGrp ? 'checkin' : 'reserve',
      })
      if (conflictResult) {
        const room = await Room.findById(r.roomId)
        const { conflict, conflictStart, conflictEnd, conflictStatus, isStillCheckedIn } = conflictResult
        const statusLabel = {
          reserved:   'đã đặt',
          confirmed:  'đã xác nhận',
          checked_in: isStillCheckedIn ? 'đang ở (chưa trả phòng)' : 'đang ở',
        }[conflictStatus] ?? conflictStatus
        const actionLabel = willCheckInNowGrp ? 'nhận phòng ngay' : 'đặt phòng'
        return res.status(400).json({
          success: false,
          code: 'CONFLICT_OVERLAP',
          message: isStillCheckedIn
            ? `Không thể ${actionLabel} — phòng ${room?.number ?? r.roomId} đang có khách ${conflict.customerName} chưa trả phòng (dự kiến trả ${new Date(conflictEnd).toLocaleString('vi-VN')}). Vui lòng xử lý trả phòng cho khách hiện tại trước.`
            : `Không thể ${actionLabel} — phòng ${room?.number ?? r.roomId} đang có khách (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}.`,
          data: {
            roomNumber:           room?.number ?? null,
            conflictBookingId:    conflict._id,
            conflictCustomerName: conflict.customerName,
            conflictCheckIn:      conflictStart,
            conflictCheckOut:     conflictEnd,
            conflictStatus,
            isStillCheckedIn,
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

// ════════════════════════════════════════════════════════════════════════════
// ⭐ FEATURE 11/05/2026: GỘP ĐOÀN / TÁCH ĐOÀN
// ════════════════════════════════════════════════════════════════════════════

// ⭐ POST /bookings/:id/merge-group
//   body: { targetBookingIds: [id1, id2, ...], groupName?: '' }
//
//   Gộp các booking đơn (hoặc đoàn) vào booking `:id` thành 1 đoàn duy nhất.
//   - `:id` là booking gốc (sẽ thành đoàn chính)
//   - `targetBookingIds` là các booking sẽ được gộp vào (sẽ bị cancel với reason)
//   - Cho phép gộp cross-customer (khách khác nhau cũng OK)
//   - Validate: cùng branchId, không có booking checked_out/cancelled,
//     không trùng room
const mergeGroup = async (req, res, next) => {
  try {
    const { targetBookingIds = [], groupName = '' } = req.body

    if (!Array.isArray(targetBookingIds) || targetBookingIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Cần chọn ít nhất 1 booking để gộp vào đoàn',
      })
    }

    const mainBooking = await Booking.findById(req.params.id)
    if (!mainBooking) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy booking gốc' })
    }
    if (['cancelled', 'checked_out'].includes(mainBooking.status)) {
      return res.status(400).json({
        success: false,
        message: `Không thể gộp đoàn — booking gốc đang ở trạng thái: ${mainBooking.status}`,
      })
    }

    // Load tất cả target bookings
    const targets = await Booking.find({ _id: { $in: targetBookingIds } })
    if (targets.length !== targetBookingIds.length) {
      return res.status(400).json({
        success: false,
        message: `Không tìm thấy đủ ${targetBookingIds.length} booking — chỉ tìm được ${targets.length}`,
      })
    }

    // Validate từng target
    for (const t of targets) {
      if (String(t._id) === String(mainBooking._id)) {
        return res.status(400).json({
          success: false,
          message: 'Không thể gộp booking với chính nó',
        })
      }
      if (['cancelled', 'checked_out'].includes(t.status)) {
        return res.status(400).json({
          success: false,
          message: `Booking ${t._id} (${t.customerName}) đang ở trạng thái ${t.status}, không thể gộp`,
        })
      }
      if (String(t.branchId) !== String(mainBooking.branchId)) {
        return res.status(400).json({
          success: false,
          message: `Booking ${t.customerName} thuộc chi nhánh khác — không thể gộp`,
        })
      }
    }

    // Build danh sách roomIds hiện có của mainBooking
    // ⭐ FIX 11/05/2026: CHỈ tính phòng đang active (không phải cancelled/checked_out)
    //   Phòng cancelled/checked_out vẫn còn record trong rooms[] nhưng không còn
    //   chiếm chỗ → cho phép gộp booking khác có phòng đó.
    const existingRoomIds = new Set()
    const isSingleActive = !Array.isArray(mainBooking.rooms) || mainBooking.rooms.length === 0
    if (isSingleActive && mainBooking.roomId
        && !['cancelled', 'checked_out'].includes(mainBooking.status)) {
      existingRoomIds.add(String(mainBooking.roomId))
    }
    if (Array.isArray(mainBooking.rooms)) {
      for (const sr of mainBooking.rooms) {
        if (!sr.roomId) continue
        if (['cancelled', 'checked_out'].includes(sr.status)) continue  // ⭐ skip
        existingRoomIds.add(String(sr.roomId?._id ?? sr.roomId))
      }
    }

    // Check trùng room với targets
    for (const t of targets) {
      const tRoomIds = []
      // ⭐ FIX 11/05/2026: Cũng skip phòng cancelled/checked_out của target
      const tIsSingle = !Array.isArray(t.rooms) || t.rooms.length === 0
      if (tIsSingle && t.roomId
          && !['cancelled', 'checked_out'].includes(t.status)) {
        tRoomIds.push(String(t.roomId))
      }
      if (Array.isArray(t.rooms)) {
        for (const sr of t.rooms) {
          if (!sr.roomId) continue
          if (['cancelled', 'checked_out'].includes(sr.status)) continue  // ⭐ skip
          tRoomIds.push(String(sr.roomId?._id ?? sr.roomId))
        }
      }
      for (const rid of tRoomIds) {
        if (existingRoomIds.has(rid)) {
          // Lookup room number để báo lỗi rõ hơn
          let roomNumber = rid
          if (Array.isArray(t.rooms)) {
            const sr = t.rooms.find(r => String(r.roomId?._id ?? r.roomId) === rid)
            if (sr?.roomNumber) roomNumber = sr.roomNumber
          } else if (t.roomNumber && String(t.roomId) === rid) {
            roomNumber = t.roomNumber
          }
          return res.status(400).json({
            success: false,
            code: 'DUPLICATE_ROOM_IN_MERGE',
            message: `Phòng ${roomNumber} có trong cả booking gốc và booking ${t.customerName} — không thể gộp. Hãy chọn booking khác.`,
            data: {
              roomNumber,
              targetBookingId: t._id,
              targetCustomerName: t.customerName,
            },
          })
        }
        existingRoomIds.add(rid)
      }
    }

    // Convert mainBooking → group (nếu chưa)
    if (!Array.isArray(mainBooking.rooms) || mainBooking.rooms.length === 0) {
      // Promote single → group: tạo sub-room đầu từ data hiện tại
      mainBooking.rooms = [{
        roomId:         mainBooking.roomId,
        roomNumber:     mainBooking.roomNumber,
        roomType:       mainBooking.roomType,
        checkIn:        mainBooking.checkIn,
        checkOut:       mainBooking.checkOut,
        nights:         mainBooking.nights,
        priceType:      mainBooking.priceType,
        adults:         mainBooking.adults,
        children:       mainBooking.children,
        policyId:       mainBooking.policyId,
        policyName:     mainBooking.policyName,
        roomAmount:     mainBooking.roomAmount ?? 0,
        servicesAmount: mainBooking.servicesAmount ?? 0,
        discountAmount: 0,
        paidAmount:     0,
        priceBreakdown: (mainBooking.priceBreakdown ?? []).map(b => {
          const item = (b && typeof b.toObject === 'function') ? b.toObject() : b
          const lbl = String(item.label ?? '')
          const hasPrefix = /^\[[^\]]+\]\s/.test(lbl)
          return {
            label:  hasPrefix ? lbl : `[${mainBooking.roomNumber}] ${lbl}`,
            amount: Number(item.amount ?? 0),
            type:   item.type === 'surcharge' ? 'surcharge' : 'base',
            meta:   { ...(item.meta || {}), roomNumber: mainBooking.roomNumber },
          }
        }),
        status:         mainBooking.status,
        actualCheckIn:  mainBooking.actualCheckIn,
        actualCheckOut: mainBooking.actualCheckOut,
      }]
      mainBooking.isGroup = true
    }

    // Push từng phòng của targets vào mainBooking.rooms[]
    const mergedRoomInfos = []  // để log
    for (const t of targets) {
      const tSubRooms = (Array.isArray(t.rooms) && t.rooms.length > 0)
        ? t.rooms
        : [{
            roomId:         t.roomId,
            roomNumber:     t.roomNumber,
            roomType:       t.roomType,
            checkIn:        t.checkIn,
            checkOut:       t.checkOut,
            nights:         t.nights,
            priceType:      t.priceType,
            adults:         t.adults,
            children:       t.children,
            policyId:       t.policyId,
            policyName:     t.policyName,
            roomAmount:     t.roomAmount ?? 0,
            servicesAmount: t.servicesAmount ?? 0,
            discountAmount: 0,
            paidAmount:     0,
            priceBreakdown: (t.priceBreakdown ?? []).map(b => {
              const item = (b && typeof b.toObject === 'function') ? b.toObject() : b
              const lbl = String(item.label ?? '')
              const hasPrefix = /^\[[^\]]+\]\s/.test(lbl)
              return {
                label:  hasPrefix ? lbl : `[${t.roomNumber}] ${lbl}`,
                amount: Number(item.amount ?? 0),
                type:   item.type === 'surcharge' ? 'surcharge' : 'base',
                meta:   { ...(item.meta || {}), roomNumber: t.roomNumber },
              }
            }),
            status:         t.status,
            actualCheckIn:  t.actualCheckIn,
            actualCheckOut: t.actualCheckOut,
          }]

      for (const sr of tSubRooms) {
        if (['cancelled', 'checked_out'].includes(sr.status)) continue
        const srObj = (sr && typeof sr.toObject === 'function') ? sr.toObject() : sr
        // Reset paid/discount của target — sẽ track ở mainBooking level
        srObj.paidAmount     = srObj.paidAmount     ?? 0
        srObj.discountAmount = srObj.discountAmount ?? 0
        mainBooking.rooms.push(srObj)
        mergedRoomInfos.push({
          bookingId:   String(t._id),
          customerName: t.customerName,
          roomNumber:  srObj.roomNumber,
        })
      }
    }

    // Recalc tổng
    const totalRoomAmount    = mainBooking.rooms.reduce((s, r) => {
      if (['cancelled'].includes(r.status)) return s
      return s + (r.roomAmount ?? 0)
    }, 0)
    const totalServicesAmount = mainBooking.rooms.reduce((s, r) => s + (r.servicesAmount ?? 0), 0)
                              + (mainBooking.servicesAmount ?? 0)

    mainBooking.roomAmount     = totalRoomAmount
    mainBooking.servicesAmount = totalServicesAmount

    const subtotal = totalRoomAmount + totalServicesAmount
    const pctDisc  = Math.round(subtotal * (mainBooking.discountPercent ?? 0) / 100)
    mainBooking.discount    = pctDisc + (mainBooking.discountAmount ?? 0)
    mainBooking.totalAmount = Math.max(0, subtotal - mainBooking.discount + (mainBooking.transferFee ?? 0))

    // Update checkIn/checkOut bao trùm
    const allCheckIns  = mainBooking.rooms.map(sr => sr.checkIn  ?? mainBooking.checkIn)
    const allCheckOuts = mainBooking.rooms.map(sr => sr.checkOut ?? mainBooking.checkOut)
    mainBooking.checkIn  = new Date(Math.min(...allCheckIns.map(d => new Date(d).getTime())))
    mainBooking.checkOut = new Date(Math.max(...allCheckOuts.map(d => new Date(d).getTime())))

    // Set groupName nếu được truyền
    if (groupName) mainBooking.groupName = groupName
    mainBooking.isGroup = true

    // Recalc status booking: nếu có phòng nào checked_in → đoàn checked_in
    const anyCheckedIn = mainBooking.rooms.some(r => r.status === 'checked_in')
    const anyReserved  = mainBooking.rooms.some(r => r.status === 'reserved' || r.status === 'confirmed')
    if (anyCheckedIn) {
      mainBooking.status = 'checked_in'
    } else if (anyReserved) {
      mainBooking.status = mainBooking.status === 'confirmed' ? 'confirmed' : 'reserved'
    }

    mainBooking.markModified('rooms')
    await mainBooking.save()

    // Cancel các target booking với reason
    for (const t of targets) {
      t.status       = 'cancelled'
      t.cancelReason = `Gộp vào đoàn ${mainBooking.customerName}${mainBooking.groupName ? ` (${mainBooking.groupName})` : ''} — booking #${mainBooking._id}`
      t.cancelledAt  = new Date()
      t.cancelledBy  = req.user?.id ?? req.user?._id ?? null
      await t.save()
    }

    // Update Room.currentBookingId của các phòng đã merge sang mainBooking
    const allMergedRoomIds = []
    for (const t of targets) {
      if (t.roomId) allMergedRoomIds.push(t.roomId)
      if (Array.isArray(t.rooms)) {
        for (const sr of t.rooms) {
          if (sr.roomId && !['cancelled', 'checked_out'].includes(sr.status)) {
            allMergedRoomIds.push(sr.roomId?._id ?? sr.roomId)
          }
        }
      }
    }
    if (allMergedRoomIds.length > 0) {
      await Room.updateMany(
        { _id: { $in: allMergedRoomIds } },
        {
          currentBookingId: mainBooking._id,
          currentGuestName: mainBooking.customerName,
        }
      )
    }

    // Sync invoice nếu có
    try {
      const invoice = await Invoice.findOne({ bookingId: mainBooking._id })
      if (invoice) {
        invoice.roomAmount      = mainBooking.roomAmount
        invoice.servicesAmount  = mainBooking.servicesAmount ?? 0
        invoice.discount        = mainBooking.discount ?? 0
        invoice.totalAmount     = mainBooking.totalAmount
        invoice.remainingAmount = Math.max(0, mainBooking.totalAmount - (invoice.paidAmount ?? 0))
        invoice.items           = buildInvoiceItemsFromBooking(mainBooking)
        await invoice.save()
      }
    } catch (e) {
      console.error('[mergeGroup] sync invoice failed (non-fatal):', e.message)
    }

    await logAction({
      entityType: 'Booking', entityId: mainBooking._id,
      action: 'merge_group',
      description: `Gộp ${targets.length} booking vào đoàn ${mainBooking.customerName}: ${mergedRoomInfos.map(r => `${r.roomNumber} (${r.customerName})`).join(', ')}`,
      user: req.user, branchId: mainBooking.branchId,
      metadata: {
        mergedCount:        targets.length,
        mergedRoomInfos,
        targetBookingIds:   targets.map(t => String(t._id)),
        newTotalAmount:     mainBooking.totalAmount,
        newRoomCount:       mainBooking.rooms.length,
        groupName:          mainBooking.groupName ?? null,
      },
    })

    res.json({
      success: true,
      message: `Đã gộp ${targets.length} booking vào đoàn (${mainBooking.rooms.length} phòng)`,
      data: { booking: mainBooking, mergedCount: targets.length },
    })
  } catch (err) {
    console.error('[mergeGroup] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

// ⭐ POST /bookings/:id/split-room
//   body: { roomId, newCustomerName?, newCustomerPhone? }
//
//   Tách 1 phòng khỏi đoàn `:id` → tạo booking single mới.
//   - Phòng cần tách: status phải là `reserved/confirmed/checked_in`
//     (không phải checked_out/cancelled)
//   - Nếu đoàn cũ chỉ còn 1 phòng sau tách → degrade thành single booking
//   - paidAmount của sub-room → chuyển sang booking mới (giữ track)
//   - Có thể tách với customer khác (newCustomerName/Phone) — nếu không truyền
//     thì dùng customer của booking gốc
const splitRoom = async (req, res, next) => {
  try {
    const { roomId, newCustomerName, newCustomerPhone, groupName = '' } = req.body

    if (!roomId) {
      return res.status(400).json({ success: false, message: 'Thiếu roomId cần tách' })
    }

    const booking = await Booking.findById(req.params.id)
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    }
    if (!Array.isArray(booking.rooms) || booking.rooms.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Booking này không phải đoàn — không thể tách',
      })
    }
    if (booking.rooms.length === 1) {
      return res.status(400).json({
        success: false,
        message: 'Đoàn chỉ còn 1 phòng — không thể tách nữa',
      })
    }
    if (['cancelled', 'checked_out'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: `Không thể tách phòng — booking đang ở trạng thái: ${booking.status}`,
      })
    }

    const subIdx = booking.rooms.findIndex(sr =>
      String(sr.roomId?._id ?? sr.roomId) === String(roomId)
    )
    if (subIdx < 0) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy phòng trong đoàn' })
    }
    const sub = booking.rooms[subIdx]
    if (['cancelled', 'checked_out'].includes(sub.status)) {
      return res.status(400).json({
        success: false,
        message: `Không thể tách phòng đang ở trạng thái: ${sub.status}`,
      })
    }

    // Customer cho booking mới
    let newCustomerId
    let useNewName = newCustomerName?.trim()
    let useNewPhone = newCustomerPhone?.toString().trim() ?? ''
    if (useNewName) {
      // Tách sang khách khác
      let customer
      if (useNewPhone) {
        customer = await Customer.findOne({ phone: useNewPhone })
        if (!customer) customer = await Customer.create({ name: useNewName, phone: useNewPhone })
      } else {
        customer = await Customer.create({ name: useNewName })
      }
      newCustomerId = customer._id
    } else {
      // Dùng customer của booking gốc
      newCustomerId = booking.customerId
      useNewName    = booking.customerName
      useNewPhone   = booking.customerPhone
    }

    const subObj = (sub && typeof sub.toObject === 'function') ? sub.toObject() : sub

    // Tạo booking mới (single) từ sub-room
    const newBooking = await Booking.create({
      customerId:      newCustomerId,
      customerName:    useNewName,
      customerPhone:   useNewPhone || '0000000000',
      roomId:          subObj.roomId,
      roomNumber:      subObj.roomNumber,
      roomType:        subObj.roomType,
      branchId:        booking.branchId,
      checkIn:         subObj.checkIn  ?? booking.checkIn,
      checkOut:        subObj.checkOut ?? booking.checkOut,
      nights:          subObj.nights   ?? booking.nights,
      priceType:       subObj.priceType ?? booking.priceType,
      adults:          subObj.adults   ?? booking.adults,
      children:        subObj.children ?? booking.children,
      roomAmount:      subObj.roomAmount ?? 0,
      servicesAmount:  subObj.servicesAmount ?? 0,
      discount:        subObj.discountAmount ?? 0,
      discountPercent: 0,
      discountAmount:  subObj.discountAmount ?? 0,
      isFreeRoom:      false,
      totalAmount:     Math.max(0, (subObj.roomAmount ?? 0) + (subObj.servicesAmount ?? 0) - (subObj.discountAmount ?? 0)),
      priceBreakdown:  (subObj.priceBreakdown ?? []).map(b => {
        const item = (b && typeof b.toObject === 'function') ? b.toObject() : b
        const lbl = String(item.label ?? '').replace(/^\[[^\]]+\]\s*/, '')
        return {
          label:  lbl,
          amount: Number(item.amount ?? 0),
          type:   item.type === 'surcharge' ? 'surcharge' : 'base',
          meta:   { ...(item.meta || {}), roomNumber: subObj.roomNumber },
        }
      }),
      policyId:        subObj.policyId   ?? booking.policyId,
      policyName:      subObj.policyName ?? booking.policyName,
      policySnapshot:  booking.policySnapshot,  // snapshot kế thừa
      status:          subObj.status,
      actualCheckIn:   subObj.actualCheckIn  ?? null,
      actualCheckOut:  subObj.actualCheckOut ?? null,
      source:          booking.source ?? 'Trực tiếp',
      isGroup:         false,
      rooms:           [],
      // ⭐ Note: paidAmount của sub không copy thẳng — sẽ tạo invoice riêng
      //   nếu cần. Tạm thời paidAmount của newBooking = 0, sub.paidAmount sẽ
      //   chuyển vào invoice mới ở bước tiếp theo (xem block sync invoice).
    })

    // Trừ phòng đã tách khỏi đoàn cũ
    const subPaidAmount = subObj.paidAmount ?? 0
    booking.rooms.splice(subIdx, 1)
    booking.markModified('rooms')

    // Nếu sau tách đoàn cũ chỉ còn 1 phòng → degrade thành single booking
    let degradedToSingle = false
    if (booking.rooms.length === 1) {
      const remaining = booking.rooms[0]
      const remObj = (remaining && typeof remaining.toObject === 'function') ? remaining.toObject() : remaining
      booking.roomId         = remObj.roomId
      booking.roomNumber     = remObj.roomNumber
      booking.roomType       = remObj.roomType
      booking.checkIn        = remObj.checkIn  ?? booking.checkIn
      booking.checkOut       = remObj.checkOut ?? booking.checkOut
      booking.nights         = remObj.nights   ?? booking.nights
      booking.priceType      = remObj.priceType ?? booking.priceType
      booking.adults         = remObj.adults   ?? booking.adults
      booking.children       = remObj.children ?? booking.children
      booking.roomAmount     = remObj.roomAmount ?? 0
      booking.actualCheckIn  = remObj.actualCheckIn  ?? booking.actualCheckIn
      booking.actualCheckOut = remObj.actualCheckOut ?? booking.actualCheckOut
      booking.priceBreakdown = (remObj.priceBreakdown ?? []).map(b => {
        const item = (b && typeof b.toObject === 'function') ? b.toObject() : b
        const lbl = String(item.label ?? '').replace(/^\[[^\]]+\]\s*/, '')
        return {
          label:  lbl,
          amount: Number(item.amount ?? 0),
          type:   item.type === 'surcharge' ? 'surcharge' : 'base',
          meta:   { ...(item.meta || {}), roomNumber: remObj.roomNumber },
        }
      })
      booking.policyId   = remObj.policyId   ?? booking.policyId
      booking.policyName = remObj.policyName ?? booking.policyName
      booking.status     = remObj.status
      booking.isGroup    = false
      booking.rooms      = []
      degradedToSingle = true
    }

    // Recalc tổng cho booking gốc
    if (!degradedToSingle) {
      const newTotalRoom = booking.rooms.reduce((s, r) => {
        if (r.status === 'cancelled') return s
        return s + (r.roomAmount ?? 0)
      }, 0)
      booking.roomAmount = newTotalRoom
      const newSubtotal = newTotalRoom + (booking.servicesAmount ?? 0)
      const newPctDisc  = Math.round(newSubtotal * (booking.discountPercent ?? 0) / 100)
      booking.discount    = newPctDisc + (booking.discountAmount ?? 0)
      booking.totalAmount = Math.max(0, newSubtotal - booking.discount + (booking.transferFee ?? 0))

      // Update checkIn/checkOut bao trùm
      const allCheckIns  = booking.rooms.map(sr => sr.checkIn  ?? booking.checkIn)
      const allCheckOuts = booking.rooms.map(sr => sr.checkOut ?? booking.checkOut)
      if (allCheckIns.length > 0)  booking.checkIn  = new Date(Math.min(...allCheckIns.map(d => new Date(d).getTime())))
      if (allCheckOuts.length > 0) booking.checkOut = new Date(Math.max(...allCheckOuts.map(d => new Date(d).getTime())))

      // Update booking.roomId nếu đang trỏ tới phòng vừa tách
      if (String(booking.roomId) === String(roomId)) {
        const firstRemaining = booking.rooms[0]
        if (firstRemaining) {
          booking.roomId     = firstRemaining.roomId
          booking.roomNumber = firstRemaining.roomNumber
          booking.roomType   = firstRemaining.roomType
        }
      }
    } else {
      // Đã degrade — recalc totalAmount cho single
      const newSubtotal = (booking.roomAmount ?? 0) + (booking.servicesAmount ?? 0)
      const newPctDisc  = Math.round(newSubtotal * (booking.discountPercent ?? 0) / 100)
      booking.discount    = newPctDisc + (booking.discountAmount ?? 0)
      booking.totalAmount = Math.max(0, newSubtotal - booking.discount + (booking.transferFee ?? 0))
    }

    if (groupName && !degradedToSingle) booking.groupName = groupName
    await booking.save()

    // Update Room.currentBookingId của phòng vừa tách → newBooking
    await Room.findByIdAndUpdate(roomId, {
      currentBookingId: newBooking._id,
      currentGuestName: useNewName,
    })

    // Sync invoice: tạo invoice mới cho booking tách, deduct số tiền của sub
    // ra khỏi invoice gốc nếu có
    try {
      const oldInvoice = await Invoice.findOne({ bookingId: booking._id })
      if (oldInvoice) {
        // Trừ phần đã trả của sub khỏi paidAmount của invoice cũ
        const newOldPaid = Math.max(0, (oldInvoice.paidAmount ?? 0) - subPaidAmount)
        oldInvoice.paidAmount      = newOldPaid
        oldInvoice.roomAmount      = booking.roomAmount
        oldInvoice.servicesAmount  = booking.servicesAmount ?? 0
        oldInvoice.discount        = booking.discount ?? 0
        oldInvoice.totalAmount     = booking.totalAmount
        oldInvoice.remainingAmount = Math.max(0, booking.totalAmount - newOldPaid)
        oldInvoice.paymentStatus   = newOldPaid >= booking.totalAmount ? 'paid' :
                                     newOldPaid > 0 ? 'partial' : 'unpaid'
        oldInvoice.items           = buildInvoiceItemsFromBooking(booking)
        await oldInvoice.save()
      }

      // Tạo invoice mới cho newBooking nếu sub có paidAmount > 0
      if (subPaidAmount > 0) {
        await Invoice.create({
          bookingId:       newBooking._id,
          customerId:      newBooking.customerId,
          customerName:    newBooking.customerName,
          roomNumber:      newBooking.roomNumber,
          roomAmount:      newBooking.roomAmount,
          servicesAmount:  newBooking.servicesAmount ?? 0,
          discount:        newBooking.discount ?? 0,
          totalAmount:     newBooking.totalAmount,
          paidAmount:      subPaidAmount,
          remainingAmount: Math.max(0, newBooking.totalAmount - subPaidAmount),
          paymentStatus:   subPaidAmount >= newBooking.totalAmount ? 'paid' :
                           subPaidAmount > 0 ? 'partial' : 'unpaid',
          issuedBy:        req.user?.id,
          items:           buildInvoiceItemsFromBooking(newBooking),
          branchId:        newBooking.branchId,
        })
      }
    } catch (e) {
      console.error('[splitRoom] sync invoice failed (non-fatal):', e.message)
    }

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'split_room',
      description: `Tách phòng ${subObj.roomNumber} khỏi đoàn ${booking.customerName}${useNewName !== booking.customerName ? ` → tạo booking mới cho ${useNewName}` : ''}${degradedToSingle ? ' (đoàn còn 1 phòng → trở thành booking đơn)' : ''}`,
      user: req.user, branchId: booking.branchId,
      metadata: {
        splitRoomNumber: subObj.roomNumber,
        splitRoomId:     String(roomId),
        newBookingId:    String(newBooking._id),
        newCustomerName: useNewName,
        degradedToSingle,
        subPaidTransferred: subPaidAmount,
      },
    })

    res.json({
      success: true,
      message: `Đã tách phòng ${subObj.roomNumber} thành booking riêng${degradedToSingle ? ' — đoàn cũ còn 1 phòng đã chuyển thành booking đơn' : ''}`,
      data: {
        booking,            // booking gốc (đã update)
        newBooking,         // booking mới được tạo từ phòng tách
        degradedToSingle,
      },
    })
  } catch (err) {
    console.error('[splitRoom] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

// ⭐ GET /bookings/:id/group-merge-candidates
//   Trả về danh sách booking có thể gộp vào booking `:id`:
//   - Cùng branchId
//   - Status: reserved/confirmed/checked_in
//   - Không phải bản thân nó
//   - Không trùng room với booking hiện tại
const getMergeCandidates = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id)
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    }

    // Build set roomIds của booking hiện tại để loại
    const myRoomIds = new Set()
    if (booking.roomId) myRoomIds.add(String(booking.roomId))
    if (Array.isArray(booking.rooms)) {
      for (const sr of booking.rooms) {
        if (sr.roomId) myRoomIds.add(String(sr.roomId?._id ?? sr.roomId))
      }
    }

    const candidates = await Booking.find({
      _id:      { $ne: booking._id },
      branchId: booking.branchId,
      status:   { $in: ['reserved', 'confirmed', 'checked_in'] },
    }).sort({ checkIn: 1 }).limit(100)

    // Filter: loại bỏ booking có room trùng
    const filtered = candidates.filter(c => {
      const cRoomIds = []
      if (c.roomId) cRoomIds.push(String(c.roomId))
      if (Array.isArray(c.rooms)) {
        for (const sr of c.rooms) {
          if (sr.roomId) cRoomIds.push(String(sr.roomId?._id ?? sr.roomId))
        }
      }
      return cRoomIds.every(rid => !myRoomIds.has(rid))
    })

    res.json({
      success: true,
      data: {
        candidates: filtered.map(c => ({
          _id:           c._id,
          customerName:  c.customerName,
          customerPhone: c.customerPhone,
          roomNumber:    c.roomNumber,
          checkIn:       c.checkIn,
          checkOut:      c.checkOut,
          status:        c.status,
          isGroup:       c.isGroup,
          totalRooms:    Array.isArray(c.rooms) ? c.rooms.length : 1,
          rooms:         Array.isArray(c.rooms) ? c.rooms.map(sr => ({
            roomNumber: sr.roomNumber,
            status:     sr.status,
          })) : [],
          totalAmount:   c.totalAmount,
        })),
        total: filtered.length,
      },
    })
  } catch (err) {
    console.error('[getMergeCandidates] error:', err)
    next(err)
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
  // ⭐ NEW 11/05/2026
  mergeGroup,
  splitRoom,
  getMergeCandidates,
}