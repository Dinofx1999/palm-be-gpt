const Booking      = require('../models/Booking');
const Room         = require('../models/Room');
const Customer     = require('../models/Customer');
const Invoice      = require('../models/Invoice');
const Branch       = require('../models/Branch');
const PricePolicy  = require('../models/PricePolicy');
const { calculatePrice } = require('../utils/priceCalculator');
const { logAction }      = require('../utils/auditLogger');
const { buildPolicySnapshot } = require('../utils/policySnapshot');

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

const getOne = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    res.json({ success: true, data: { booking } })
  } catch (err) { next(err) }
}

// ⭐ NEW: PREVIEW PRICE — gọi từ FE để tính trước, không lưu DB
// POST /bookings/preview-price
// Body: { roomId, checkIn, checkOut, priceType, adults, children, policyId, confirmConvert }
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

    const capacity = room.typeId?.capacity ?? 2

    const result = calculatePrice({
  checkIn:  new Date(checkIn),
  checkOut: new Date(checkOut),
  priceType, policy, branch, adults, children, capacity,
})

// ⭐ NEW: Trả 400 nếu policy không enable loại giá user yêu cầu
if (result.error) {
  console.log('⚠️ Returning 400 BAD_REQUEST due to PRICE_TYPE_NOT_ENABLED')
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

    // ⭐ Phone là tuỳ chọn — chuẩn hoá: rỗng/null/undefined → '' (sẽ tạo guest không có số)
    let customerPhone = (req.body.customerPhone ?? '').toString().trim()

    // Phone không bắt buộc, chỉ cần customerName + roomId + ngày
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

    const conflict = await Booking.findOne({
      roomId,
      status:   { $in: ['confirmed', 'reserved', 'checked_in'] },
      checkIn:  { $lt: checkOutDate },
      checkOut: { $gt: checkInDate },
    })
    if (conflict)
      return res.status(400).json({ success: false, message: `Phòng đã có đặt phòng từ ${new Date(conflict.checkIn).toLocaleDateString('vi-VN')} đến ${new Date(conflict.checkOut).toLocaleDateString('vi-VN')}` })

    const branch = await Branch.findById(room.branchId)

    // Áp giờ chuẩn nếu user chỉ gửi date (giờ = 00:00:00)
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

    // Lấy policy
    let policy = policyId ? await PricePolicy.findById(policyId) : null
    if (!policy) policy = await PricePolicy.findOne({ roomTypeId: room.typeId, branchId: room.branchId, isActive: true })

    const capacity = room.typeId?.capacity ?? 2

    // ⭐ Tính giá qua helper
    const priceResult = calculatePrice({
      checkIn:  checkInFinal,
      checkOut: checkOutFinal,
      priceType, policy, branch, adults, children, capacity,
    })

    // ⭐ NEW: Trả 400 nếu policy không enable loại giá user yêu cầu
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

    // ⭐ Nếu auto-convert mà user chưa confirm → trả 422 với notice để FE hiện cảnh báo
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

    // Tìm/tạo customer
    // Nếu có SĐT → tìm customer có sẵn (để tích luỹ totalVisits/totalSpent)
    // Nếu KHÔNG có SĐT (khách walk-in vô danh) → luôn tạo mới với phone=undefined
    //   (KHÔNG dùng '' vì sparse index chỉ bỏ qua null/undefined)
    let customer
    if (customerPhone) {
      customer = await Customer.findOne({ phone: customerPhone })
      if (!customer) customer = await Customer.create({ name: customerName, phone: customerPhone })
    } else {
      customer = await Customer.create({ name: customerName })   // ⭐ không truyền phone
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
      priceBreakdown: priceResult.breakdown,   // ⭐ Lưu breakdown chi tiết
      policyId:       policy?._id ?? null,
      policyName:     policy?.name ?? '',
      // ⭐ Snapshot policy để tính lại đúng khi chuyển phòng (segment 1)
      policySnapshot: policy ? buildPolicySnapshot(policy, room.typeId?.capacity ?? null) : null,
      status:         initialStatus,
      actualCheckIn:  initialStatus === 'checked_in' ? new Date() : null,
    })

    await Room.findByIdAndUpdate(roomId, {
      currentBookingId: booking._id,
      currentGuestName: customerName,
    })

    // ⭐ Audit
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

    // ⭐ Audit — chỉ log nếu có thay đổi quan trọng
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

    // ⭐ Conflict check — bao gồm cả phòng đoàn (rooms[].roomId)
    const allRoomIds = [booking.roomId]
    if (Array.isArray(booking.rooms)) {
      for (const sr of booking.rooms) {
        if (sr.roomId) allRoomIds.push(sr.roomId)
      }
    }
    const conflict = await Booking.findOne({
      _id:      { $ne: booking._id },
      $or: [
        { roomId:         { $in: allRoomIds } },
        { 'rooms.roomId': { $in: allRoomIds } },
      ],
      status:   { $in: ['confirmed', 'reserved', 'checked_in'] },
      checkIn:  { $lt: newCheckOut },
      checkOut: { $gt: newCheckIn },
    })
    if (conflict)
      return res.status(400).json({ success: false, message: `Trùng với đặt phòng khác` })

    // ⭐ Tính lại giá theo logic mới
    const room   = await Room.findById(booking.roomId).populate('typeId')
    const branch = await Branch.findById(booking.branchId)
    const policy = booking.policyId ? await PricePolicy.findById(booking.policyId) : null
    const capacity = room?.typeId?.capacity ?? 2

    const priceResult = calculatePrice({
      checkIn: newCheckIn, checkOut: newCheckOut,
      priceType: booking.priceType, policy, branch,
      adults: booking.adults, children: booking.children, capacity,
    })

    // ⭐ NEW: Trả 400 nếu policy không enable loại giá
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

    // ⭐ NEW: Nếu khách đã check-in → đổi giờ check-in thực tế (actualCheckIn),
    //   giữ nguyên checkIn dự kiến. Ngược lại (reserved) → đổi checkIn dự kiến như cũ.
    let updatedActualCheckIn = false
    if (booking.status === 'checked_in') {
      booking.actualCheckIn = newCheckIn
      updatedActualCheckIn  = true
    } else {
      booking.checkIn = newCheckIn
    }
    await booking.save()

    // ⭐ Audit
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
        updatedActualCheckIn,   // ⭐ flag để biết đổi loại nào
      },
    })

    res.json({
      success: true,
      message: 'Đổi ngày thành công',
      data: { booking, priceBreakdown: priceResult.breakdown, notice: priceResult.notice },
    })
  } catch (err) { next(err) }
}

// ⭐ NEW: PATCH /bookings/:id/change-dates-room
//   Đổi ngày RIÊNG cho 1 phòng trong đoàn (không ảnh hưởng phòng khác)
//   Body: { roomId, checkIn, checkOut, confirmConvert? }
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

    // Tìm sub-room
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

    // ⭐ Conflict check — chỉ check phòng này (subRoomId) với booking khác
    const conflict = await Booking.findOne({
      _id:      { $ne: booking._id },
      $or: [
        { roomId:         subRoomId },
        { 'rooms.roomId': subRoomId },
      ],
      status:   { $in: ['confirmed', 'reserved', 'checked_in'] },
      checkIn:  { $lt: newCheckOut },
      checkOut: { $gt: newCheckIn },
    })
    if (conflict) {
      return res.status(400).json({ success: false, message: `Phòng ${subRoom.roomNumber} bị trùng với đặt phòng khác` })
    }

    // ⭐ Recalc giá cho sub-room này theo dates mới
    const room   = await Room.findById(subRoom.roomId).populate('typeId')
    const branch = await Branch.findById(booking.branchId)
    const policy = subRoom.policyId ? await PricePolicy.findById(subRoom.policyId)
                  : booking.policyId ? await PricePolicy.findById(booking.policyId)
                  : null
    const capacity = room?.typeId?.capacity ?? 2

    const priceResult = calculatePrice({
      checkIn:   newCheckIn,
      checkOut:  newCheckOut,
      priceType: subRoom.priceType ?? booking.priceType,
      policy, branch,
      adults:    subRoom.adults    ?? booking.adults,
      children:  subRoom.children  ?? booking.children,
      capacity,
    })

    // ⭐ NEW: Trả 400 nếu policy không enable loại giá
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

    // ⭐ Cập nhật sub-room
    const oldCheckIn  = subRoom.checkIn  ?? booking.checkIn
    const oldCheckOut = subRoom.checkOut ?? booking.checkOut
    const oldActualCheckIn = subRoom.actualCheckIn ?? null

    // ⭐ NEW: Nếu sub-room đã check-in → đổi actualCheckIn (giờ thực tế),
    //   KHÔNG đụng checkIn dự kiến. Ngược lại (reserved) → đổi checkIn dự kiến.
    let updatedActualCheckIn = false
    if (subRoom.status === 'checked_in') {
      subRoom.actualCheckIn = newCheckIn
      updatedActualCheckIn  = true
      // checkIn dự kiến: giữ nguyên (không đụng)
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
      // ⭐ Inject roomNumber vào meta để FE group bill theo phòng
      meta:   { ...(b.meta || {}), roomNumber: subRoom.roomNumber },
    }))

    // ⭐ Auto-backfill các sub-room khác CHƯA có checkIn/checkOut
    //   Nếu KHÔNG backfill → sau khi sync booking.checkIn (min) → các sub-room này
    //   sẽ đọc booking.checkIn (mới) làm fallback → bị đổi theo!
    //   Backfill = giữ nguyên dates cũ cho các phòng KHÔNG được đổi
    for (const other of booking.rooms) {
      if (other === subRoom) continue
      if (!other.checkIn)  other.checkIn  = booking.checkIn
      if (!other.checkOut) other.checkOut = booking.checkOut
      if (!other.nights)   other.nights   = booking.nights
    }

    // ⭐ Sync roomAmount root = sum tất cả sub-room
    booking.roomAmount = booking.rooms.reduce((s, sr) => s + (sr.roomAmount ?? 0), 0)
    booking.totalAmount = booking.roomAmount + (booking.servicesAmount ?? 0) - (booking.discount ?? 0) + (booking.transferFee ?? 0)

    // ⭐ Sync booking.checkIn/checkOut = min/max của tất cả sub-room (cho hiển thị tổng quan)
    //   AN TOÀN vì giờ các sub-room khác đã có dates riêng (vừa backfill ở trên)
    const allCheckIns  = booking.rooms.map(sr => sr.checkIn  ?? booking.checkIn)
    const allCheckOuts = booking.rooms.map(sr => sr.checkOut ?? booking.checkOut)
    booking.checkIn  = new Date(Math.min(...allCheckIns.map(d => new Date(d).getTime())))
    booking.checkOut = new Date(Math.max(...allCheckOuts.map(d => new Date(d).getTime())))

    await booking.save()

    // ⭐ Audit log
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
        oldActualCheckIn,                    // ⭐ giờ thực tế cũ (nếu có)
        newCheckIn, newCheckOut,
        nights: priceResult.nights, roomAmount: priceResult.roomAmount,
        bookingId: booking._id,
        updatedActualCheckIn,                // ⭐ flag để biết đổi loại nào
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
// (… toàn bộ moveRoom, changePolicy, checkin, checkinRoom, checkout, checkoutRoom,
//   cancel, undo, undoRoom, getAvailableByDate, applyDiscount, calculateBill,
//   allocatePaymentToRooms, getAvailableByType, calculateGroupPrice,
//   previewGroup, createGroup — GIỮ NGUYÊN từ file gốc)
//
// Lý do: 4 patches chỉ ảnh hưởng chỗ gọi calculatePrice(). Các function khác
// không trực tiếp gọi calculatePrice nên không cần sửa. Phần dưới em copy
// nguyên văn từ file gốc anh đã paste.
// ──────────────────────────────────────────────────────────

// ⭐ TRỌN BỘ PHẦN CÒN LẠI từ file gốc — KHÔNG SỬA — bắt đầu từ moveRoom
// ──────────────────────────────────────────────────────────

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

    const conflict1 = await Booking.findOne({
      _id:      { $ne: booking._id },
      roomId:   newRoomId,
      status:   { $in: ['confirmed', 'reserved', 'checked_in'] },
      checkIn:  { $lt: checkOutRange },
      checkOut: { $gt: checkInRange },
    })
    if (conflict1)
      return res.status(400).json({ success: false, message: 'Phòng đích đã có đặt phòng trong khoảng này' })

    const conflict2 = await Booking.findOne({
      _id:        { $ne: booking._id },
      'rooms.roomId': newRoomId,
      status:     { $in: ['confirmed', 'reserved', 'checked_in'] },
    })
    if (conflict2) {
      const hasOverlap = (conflict2.rooms || []).some(sr => {
        if (String(sr.roomId) !== String(newRoomId)) return false
        if (['cancelled', 'checked_out'].includes(sr.status)) return false
        const ci = sr.checkIn  ?? conflict2.checkIn
        const co = sr.checkOut ?? conflict2.checkOut
        return ci < checkOutRange && co > checkInRange
      })
      if (hasOverlap) {
        return res.status(400).json({ success: false, message: 'Phòng đích đã có đặt phòng (đoàn) trong khoảng này' })
      }
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
      const newCapacity = newRoom.typeId?.capacity ?? 2

      let oldPolicy = null
      const snap = sourcePolicySnapshot
        ? (sourcePolicySnapshot.toObject ? sourcePolicySnapshot.toObject() : sourcePolicySnapshot)
        : null

      if (snap && (snap.dayEnabled || snap.hourEnabled || snap.nightEnabled || (snap.dayPrice && snap.dayPrice > 0) || (snap.nightPrice && snap.nightPrice > 0))) {
        oldPolicy = snap
        console.log('[moveRoom] seg1 using snapshot:', snap.name, 'dayPrice:', snap.dayPrice)
      } else if (sourcePolicyId) {
        oldPolicy = await PricePolicy.findById(sourcePolicyId)
        console.log('[moveRoom] seg1 fallback to PricePolicy.findById:', oldPolicy?.name, 'dayPrice:', oldPolicy?.dayPrice)
      } else {
        console.log('[moveRoom] ⚠️ seg1 no oldPolicy → pro-rata fallback')
      }

      const oldCapacity = snap?.capacity ?? oldRoom?.typeId?.capacity ?? 2

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
          capacity:  newCapacity,
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
            capacity:  oldCapacity,
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
          console.log('[moveRoom seg1] amount=', seg1Amount,
                      'items=', seg1Items.map(b => `${b.label}: ${b.amount}`))
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
          capacity:  newCapacity,
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
        newCapacity,
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
        console.log('[moveRoom group] Pre-recalc: subRoom.policyId=', subRoom.policyId,
                    '| booking.policyId=', booking.policyId,
                    '| newPolicyId=', newPolicyId,
                    '| oldPolId resolved=', oldPolId,
                    '| same as new?=', String(oldPolId) === String(newPolicyId))
        if (oldPolId) {
          try {
            const oldPol = await PricePolicy.findById(oldPolId)
            if (oldPol) {
              const oldCap = oldRoom?.typeId?.capacity ?? booking.policySnapshot?.capacity ?? 2
              sourceSnapshot = buildPolicySnapshot(oldPol, oldCap)
              console.log('[moveRoom group] Built snapshot from oldPolId:',
                          oldPol.name, 'dayPrice=', oldPol.dayPrice,
                          'capacity=', oldCap)
            } else {
              console.log('[moveRoom group] ⚠️ oldPolId not found in DB:', oldPolId)
            }
          } catch (e) {
            console.log('[moveRoom group] ⚠️ Error fetching oldPolicy:', e.message)
          }
        }
        if (!sourceSnapshot && booking.policySnapshot) {
          sourceSnapshot = booking.policySnapshot
          console.log('[moveRoom group] Fallback to booking.policySnapshot:',
                      booking.policySnapshot.name, 'dayPrice=', booking.policySnapshot.dayPrice)
        }
        if (!sourceSnapshot) {
          console.log('[moveRoom group] ⚠️ NO source snapshot — will pro-rata fallback in recalc')
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
      booking.policySnapshot = buildPolicySnapshot(recalc.newPolicy, recalc.newCapacity)
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

// ⭐ NEW: Đổi chính sách giá (không chuyển phòng) — dùng cho modal "Đổi giá"
// PATCH /bookings/:id/change-policy
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
      const capacity = room?.typeId?.capacity ?? 2

      const result = calculatePrice({
        checkIn:   booking.checkIn,
        checkOut:  booking.checkOut,
        priceType: booking.priceType,
        policy, branch,
        adults:    booking.adults,
        children:  booking.children,
        capacity,
      })

      // ⭐ NEW: Trả 400 nếu policy mới không enable loại giá hiện tại của booking
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

const checkin = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (!['confirmed', 'reserved'].includes(booking.status))
      return res.status(400).json({ success: false, message: `Không thể check-in từ trạng thái: ${booking.status}` })

    const now = new Date()
    booking.status        = 'checked_in'
    booking.actualCheckIn = now

    let subRoomCount = 0
    if (Array.isArray(booking.rooms) && booking.rooms.length > 0) {
      for (const sr of booking.rooms) {
        if (sr.status === 'reserved' || sr.status === 'confirmed') {
          sr.status         = 'checked_in'
          sr.actualCheckIn  = now
          subRoomCount++
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

    const refCheckIn = booking.actualCheckIn ?? booking.checkIn
    if (refCheckIn && actualCO < new Date(refCheckIn)) {
      return res.status(400).json({
        success: false,
        message: `Giờ trả phòng (${new Date(actualCO).toLocaleString('vi-VN')}) phải sau giờ nhận phòng (${new Date(refCheckIn).toLocaleString('vi-VN')})`,
      })
    }

    const conflictBooking = await Booking.findOne({
      _id:    { $ne: booking._id },
      $or: [
        { roomId:         booking.roomId },
        { 'rooms.roomId': booking.roomId },
      ],
      status:   { $in: ['confirmed', 'reserved', 'checked_in', 'checked_out'] },
      checkIn:  { $lt: actualCO },
      checkOut: { $gt: refCheckIn },
    }).sort({ checkIn: 1 })

    if (conflictBooking) {
      let conflictRoomCheckIn = conflictBooking.checkIn
      let conflictRoomActualCheckIn = conflictBooking.actualCheckIn
      if (Array.isArray(conflictBooking.rooms) && conflictBooking.rooms.length > 0) {
        const cSub = conflictBooking.rooms.find(r => String(r.roomId?._id ?? r.roomId) === String(booking.roomId))
        if (cSub) {
          conflictRoomCheckIn = cSub.checkIn ?? conflictBooking.checkIn
          conflictRoomActualCheckIn = cSub.actualCheckIn ?? conflictBooking.actualCheckIn
        }
      }
      const limitTime = conflictRoomActualCheckIn ?? conflictRoomCheckIn
      if (actualCO > new Date(limitTime)) {
        return res.status(400).json({
          success: false,
          code: 'CONFLICT_NEW_BOOKING',
          message: `Phòng ${booking.roomNumber} đã có booking khác (${conflictBooking.customerName}) nhận phòng lúc ${new Date(limitTime).toLocaleString('vi-VN')}. Giờ trả phòng phải trước thời điểm này.`,
          data: {
            conflictBookingId:    conflictBooking._id,
            conflictCustomerName: conflictBooking.customerName,
            conflictCheckIn:      limitTime,
            requestedCheckOut:    actualCO,
          },
        })
      }
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

        console.log(`[checkout] Custom price + early/late: ${nightsToCharge} đêm × custom = ${newRoomAmount.toLocaleString('vi-VN')}đ`)
      } catch (calcErr) {
        console.error('Recalc custom price on checkout failed:', calcErr)
      }
    } else if (checkOutDiffMin > 1 && !hasCustomPriceItems) {
      try {
        const room   = await Room.findById(booking.roomId).populate('typeId')
        const branch = await Branch.findById(booking.branchId)
        const policy = booking.policyId ? await PricePolicy.findById(booking.policyId) : null
        const capacity = room?.typeId?.capacity ?? 2

        const priceResult = calculatePrice({
          checkIn:   booking.actualCheckIn ?? booking.checkIn,
          checkOut:  actualCO,
          priceType: booking.priceType,
          policy, branch,
          adults:    booking.adults,
          children:  booking.children,
          capacity,
        })

        // ⭐ NOTE: KHÔNG block checkout vì priceResult.error
        //   Lý do: tại thời điểm checkout, booking đã tồn tại, policy có thể đã thay đổi.
        //   Nếu có error → giữ nguyên giá cũ (không recalc) để không ảnh hưởng flow checkout.
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
        items: [{
          description: `Phòng ${booking.roomNumber} – ${booking.roomType} × ${booking.nights} đêm`,
          quantity:    booking.nights,
          unitPrice:   Math.round(booking.roomAmount / Math.max(1, booking.nights)),
          amount:      booking.roomAmount,
        }],
      })
    } else {
      invoice.roomAmount      = booking.roomAmount
      invoice.servicesAmount  = booking.servicesAmount ?? 0
      invoice.discount        = booking.discount ?? 0
      invoice.totalAmount     = booking.totalAmount
      invoice.remainingAmount = Math.max(0, booking.totalAmount - (invoice.paidAmount ?? 0))
      invoice.paymentStatus   = invoice.paidAmount >= booking.totalAmount ? 'paid' :
                                invoice.paidAmount > 0 ? 'partial' : 'unpaid'
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
    console.log(`[checkoutRoom] booking=${booking._id} room=${sub.roomNumber} body.actualCheckOut=${actualCheckOut} → actualCO=${actualCO.toISOString()}`)

    const refCheckIn = sub.actualCheckIn ?? sub.checkIn ?? booking.actualCheckIn ?? booking.checkIn
    if (refCheckIn && actualCO < new Date(refCheckIn)) {
      return res.status(400).json({
        success: false,
        message: `Giờ trả phòng (${new Date(actualCO).toLocaleString('vi-VN')}) phải sau giờ nhận phòng (${new Date(refCheckIn).toLocaleString('vi-VN')})`,
      })
    }

    const subRoomId = String(sub.roomId?._id ?? sub.roomId)
    const conflictBooking = await Booking.findOne({
      _id:    { $ne: booking._id },
      $or: [
        { roomId:         subRoomId },
        { 'rooms.roomId': subRoomId },
      ],
      status:   { $in: ['confirmed', 'reserved', 'checked_in', 'checked_out'] },
      checkIn:  { $lt: actualCO },
      checkOut: { $gt: refCheckIn },
    }).sort({ checkIn: 1 })

    if (conflictBooking) {
      let conflictRoomCheckIn = conflictBooking.checkIn
      let conflictRoomActualCheckIn = conflictBooking.actualCheckIn
      if (Array.isArray(conflictBooking.rooms) && conflictBooking.rooms.length > 0) {
        const cSub = conflictBooking.rooms.find(r => String(r.roomId?._id ?? r.roomId) === subRoomId)
        if (cSub) {
          conflictRoomCheckIn = cSub.checkIn ?? conflictBooking.checkIn
          conflictRoomActualCheckIn = cSub.actualCheckIn ?? conflictBooking.actualCheckIn
        }
      }
      const limitTime = conflictRoomActualCheckIn ?? conflictRoomCheckIn
      if (actualCO > new Date(limitTime)) {
        return res.status(400).json({
          success: false,
          code: 'CONFLICT_NEW_BOOKING',
          message: `Phòng ${sub.roomNumber} đã có booking khác (${conflictBooking.customerName}) nhận phòng lúc ${new Date(limitTime).toLocaleString('vi-VN')}. Giờ trả phòng phải trước thời điểm này.`,
          data: {
            conflictBookingId:   conflictBooking._id,
            conflictCustomerName: conflictBooking.customerName,
            conflictCheckIn:     limitTime,
            requestedCheckOut:   actualCO,
          },
        })
      }
    }

    const checkOutDiffMin = Math.abs((actualCO - booking.checkOut) / 60000)
    if (checkOutDiffMin > 1) {
      try {
        const room   = await Room.findById(sub.roomId).populate('typeId')
        const branch = await Branch.findById(booking.branchId)
        const policy = sub.policyId ? await PricePolicy.findById(sub.policyId) : null
        const capacity = room?.typeId?.capacity ?? 2

        const priceResult = calculatePrice({
          checkIn:   sub.actualCheckIn ?? sub.checkIn ?? booking.checkIn,
          checkOut:  actualCO,
          priceType: sub.priceType ?? booking.priceType,
          policy, branch,
          adults:    sub.adults   ?? booking.adults,
          children:  sub.children ?? booking.children,
          capacity,
        })

        // ⭐ NOTE: KHÔNG block checkout vì priceResult.error (tương tự checkout đơn)
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
              capacity,
            })
            const seg1Amount = seg1Items.reduce((s, b) => s + Number(b.amount ?? 0), 0)
            const seg2Items  = (seg2Result.breakdown ?? []).map(b => ({
              label:  String(b.label ?? '').replace(/^\[[^\]]+\]\s*/, ''),
              amount: Number(b.amount ?? 0),
              type:   b.type === 'surcharge' ? 'surcharge' : 'base',
              meta:   { ...(b.meta || {}), segment: 2, roomNumber: sub.roomNumber },
            })).map(item => ({
              ...item,
              label: `[${sub.roomNumber}] ${item.label}`,
            }))

            sub.roomAmount     = seg1Amount + (seg2Result.roomAmount ?? 0)
            sub.priceBreakdown = [...seg1Items, ...seg2Items]
            console.log('[checkoutRoom] preserved seg1:', seg1Items.length, 'items, seg1Amount=', seg1Amount,
                        '| seg2 amount=', seg2Result.roomAmount, '| total=', sub.roomAmount)
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

    sub.status         = 'checked_out'

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

    await booking.save()

    if (invoice) {
      invoice.roomAmount      = booking.roomAmount
      invoice.servicesAmount  = booking.servicesAmount ?? 0
      invoice.discount        = booking.discount ?? 0
      invoice.totalAmount     = booking.totalAmount
      invoice.remainingAmount = Math.max(0, booking.totalAmount - paidAmount)
      invoice.paymentStatus   = paidAmount >= booking.totalAmount ? 'paid' :
                                paidAmount > 0 ? 'partial' : 'unpaid'
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
      metadata: { reason, newStatus, roomNumber: booking.roomNumber },
    })

    res.json({ success: true, message: 'Hoàn tác thành công', data: { booking } })
  } catch (err) { next(err) }
}

const undoRoom = async (req, res, next) => {
  try {
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
      metadata: { reason, roomId, roomNumber: sub.roomNumber, prevStatus, newSubStatus, bookingId: booking._id },
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
        const capacity = room?.typeId?.capacity ?? 2

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
            console.log('[calc-bill move]', sr.roomNumber, 'seg1Items count=', seg1Items.length,
                        'seg1Amount=', seg1Amount, 'splitAt=', splitAt)

            const seg2Result = calculatePrice({
              checkIn:   splitAt,
              checkOut:  effectiveCheckOut,
              priceType: sr.priceType ?? booking.priceType,
              policy, branch,
              adults:    sr.adults   ?? booking.adults,
              children:  sr.children ?? booking.children,
              capacity,
            })
            const seg2Items = (seg2Result.breakdown ?? []).map(b => ({
              ...b,
              meta: { ...(b.meta || {}), segment: 2, roomNumber: sr.roomNumber },
            }))

            subPriceResult = {
              roomAmount: seg1Amount + (seg2Result.roomAmount ?? 0),
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
              capacity,
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

        console.log(`[calc-bill SINGLE] booking=${booking._id} room=${sr.roomNumber} subTotal=${subTotalAmount} sr.paidAmount=${sr.paidAmount ?? 0}`)

        const otherCheckedIn = booking.rooms.filter(r =>
          r !== sr && r.status === 'checked_in'
        )
        const isLastCheckedInRoom = otherCheckedIn.length === 0

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
        console.log(`[calc-bill SINGLE result] room=${sr.roomNumber} isLast=${isLastCheckedInRoom} invoicePaid=${invoicePaidTotal} otherPaid=${otherSubPaidSum} excess=${excessInvoicePaid} subPaid=${subPaidAmount} subRemain=${subRemainingAmount}`)

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
    const capacity = room?.typeId?.capacity ?? 2

    const hasCustomPrice = (booking.priceBreakdown ?? []).some(b => b.meta?.customPrice === true)

    const hasTransferred = (booking.transferHistory ?? []).length > 0
    const lastTransfer = hasTransferred ? booking.transferHistory[booking.transferHistory.length - 1] : null

    let priceResult
    if (hasCustomPrice) {
      if (mode === 'now') {
        const now = new Date()
        const parseTime = (str, refDate) => {
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
          capacity,
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
          capacity,
        })
        const seg2Items = (seg2Result.breakdown ?? []).map(b => ({
          ...b,
          label: `[${booking.roomNumber}] ${b.label}`,
          meta:  { ...(b.meta || {}), segment: 2, roomNumber: booking.roomNumber },
        }))

        priceResult = {
          roomAmount:       oldSegmentsAmount + (seg2Result.roomAmount ?? 0),
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
        capacity,
      })
    }

    // ⭐ NOTE: KHÔNG block calculate-bill vì priceResult.error
    //   Chỉ log warning. UI vẫn hiển thị giá hiện tại của booking để user xử lý.
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

    console.log('[getAvailableByType] checkIn=', ci.toISOString(), 'checkOut=', co.toISOString())
    console.log('[getAvailableByType] allRooms count:', allRooms.length,
      'rooms:', allRooms.map(r => `${r.number}(${r.roomStatus})`).join(', '))
    console.log('[getAvailableByType] conflicts count:', conflicts.length)
    conflicts.forEach(b => {
      console.log(`  - booking ${b._id} status=${b.status} customer=${b.customerName}`,
        `roomId=${b.roomId}`, `rooms=${(b.rooms||[]).length}`,
        `ci=${b.checkIn?.toISOString?.()} co=${b.checkOut?.toISOString?.()}`)
    })

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
      const capacity = room.typeId?.capacity ?? 2
      const isAvailable = !bookedRoomIds.has(String(room._id))

      if (!typeMap.has(typeId)) {
        typeMap.set(typeId, {
          typeId, typeName, capacity,
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
        capacity,
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

// ⭐ HELPER: Tính giá cho cả nhóm phòng — dùng chung cho previewGroup + createGroup
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
      capacity:  room.typeId?.capacity ?? 2,
    })

    // ⭐ NEW: Throw error nếu policy không enable loại giá user yêu cầu
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
      capacity:         room.typeId?.capacity ?? 2,
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
        typeId:     line.typeId,
        typeName:   line.typeName,
        capacity:   line.capacity,
        rooms:      [],
        subTotal:   0,
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
    // ⭐ NEW: Catch error 400 từ calculateGroupPrice (priceResult.error)
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

    for (const r of roomsInput) {
      const conflict = await Booking.findOne({
        $or: [
          { roomId: r.roomId },
          { 'rooms.roomId': r.roomId },
        ],
        status:   { $in: ['confirmed', 'reserved', 'checked_in'] },
        checkIn:  { $lt: checkOutDate },
        checkOut: { $gt: checkInDate },
      })
      if (conflict) {
        const room = await Room.findById(r.roomId)
        return res.status(400).json({
          success: false,
          message: `Phòng ${room?.number ?? r.roomId} đã có đặt phòng trùng lịch`,
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
      // ⭐ NEW: Catch error 400 từ calculateGroupPrice
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
      console.log(`[createGroup] subRoom ${i} breakdown:`, breakdown.length, 'items, first:', breakdown[0])

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

module.exports = {
  getAll, getOne, create, update,
  previewPrice, changeDates, changeDatesRoom, moveRoom,
  checkin, checkout, cancel, undo,
  getAvailableByDate,
  applyDiscount,
  calculateBill,
  changePolicy,
  // ⭐ NEW (group)
  createGroup,
  getAvailableByType,
  previewGroup,
  // ⭐ NEW (per-room actions cho đoàn)
  checkinRoom,
  checkoutRoom,
  undoRoom,
}