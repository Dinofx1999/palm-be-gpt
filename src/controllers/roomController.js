const Room    = require('../models/Room');
const Booking = require('../models/Booking');

// ── Tính trạng thái động theo booking.status ──────────
const computeRealStatus = (room, activeBooking, subRoom = null) => {
  if (room.roomStatus === 'maintenance') return 'maintenance'
  if (room.roomStatus === 'inactive')    return 'cleaning'

  if (!activeBooking)                       return 'available'
  if (activeBooking.status === 'cancelled') return 'available'

  const effectiveStatus = subRoom?.status ?? activeBooking.status

  if (effectiveStatus === 'checked_in') {
    const refCheckOut = subRoom?.checkOut ?? activeBooking.checkOut
    const now = new Date()
    if (refCheckOut && now >= new Date(refCheckOut)) return 'occupied'
    return 'occupied'
  }

  if (effectiveStatus === 'checked_out') {
    return 'checkout'
  }

  if (effectiveStatus === 'reserved' || effectiveStatus === 'confirmed') {
    const now = new Date()
    if (now >= new Date(activeBooking.checkOut)) return 'checkout'
    return 'reserved'
  }

  if (effectiveStatus === 'cancelled') return 'available'

  return 'available'
}

const findActiveBookingForRoom = (allBookings, roomId) => {
  const ridStr = roomId.toString()
  for (const bk of allBookings) {
    if (bk.roomId && bk.roomId.toString() === ridStr) {
      return { booking: bk, subRoom: null }
    }
    if (Array.isArray(bk.rooms) && bk.rooms.length > 0) {
      const sub = bk.rooms.find(r => r.roomId && r.roomId.toString() === ridStr)
      if (sub) return { booking: bk, subRoom: sub }
    }
  }
  return { booking: null, subRoom: null }
}

// ── GET ALL ───────────────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    const { status, floorId, typeId, branchId, page = 1, limit = 50 } = req.query
    const filter = {}
    if (floorId)  filter.floorId  = floorId
    if (typeId)   filter.typeId   = typeId
    if (branchId) filter.branchId = branchId

    const rooms   = await Room.find(filter).populate('typeId').sort({ number: 1 })
    const roomIds = rooms.map(r => r._id)
    const now     = new Date()

    const activeBookings = await Booking.find({
      $or: [
        { roomId:         { $in: roomIds } },
        { 'rooms.roomId': { $in: roomIds } },
      ],
      $and: [
        {
          $or: [
            { status: 'checked_in' },
            {
              status:   { $in: ['confirmed', 'reserved'] },
              checkOut: { $gte: now },
            },
          ],
        },
      ],
    })

    const bookingMap = {}
    for (const bk of activeBookings) {
      const relatedRooms = []

      if (bk.roomId) {
        const rootRidStr = bk.roomId.toString()
        const matchingSub = Array.isArray(bk.rooms)
          ? bk.rooms.find(sr => sr.roomId && sr.roomId.toString() === rootRidStr)
          : null
        relatedRooms.push({ roomId: rootRidStr, subRoom: matchingSub ?? null })
      }

      if (Array.isArray(bk.rooms)) {
        for (const sr of bk.rooms) {
          if (sr.roomId) {
            const ridStr = sr.roomId.toString()
            if (bk.roomId && bk.roomId.toString() === ridStr) continue
            relatedRooms.push({ roomId: ridStr, subRoom: sr })
          }
        }
      }

      for (const { roomId: rid, subRoom } of relatedRooms) {
        const effectiveStatus = subRoom?.status ?? bk.status
        if (effectiveStatus === 'checked_out' || effectiveStatus === 'cancelled') {
          continue
        }

        if (!bookingMap[rid]) {
          bookingMap[rid] = { booking: bk, subRoom }
        } else {
          const cur = bookingMap[rid]
          const curStatus = cur.subRoom?.status ?? cur.booking.status
          const newStatus = effectiveStatus
          if (curStatus !== 'checked_in' && newStatus === 'checked_in') {
            bookingMap[rid] = { booking: bk, subRoom }
          } else if (curStatus === newStatus && new Date(bk.checkIn) < new Date(cur.booking.checkIn)) {
            bookingMap[rid] = { booking: bk, subRoom }
          }
        }
      }
    }

    let result = rooms.map(r => {
      const obj      = r.toObject()
      const entry    = bookingMap[r._id.toString()] ?? { booking: null, subRoom: null }
      const booking  = entry.booking
      const subRoom  = entry.subRoom

      obj.realStatus = computeRealStatus(r, booking, subRoom)
      obj.activeBooking = booking ? {
        id:           booking._id,
        customerName: booking.customerName,
        checkIn:      subRoom?.checkIn  ?? booking.checkIn,
        checkOut:     subRoom?.checkOut ?? booking.checkOut,
        actualCheckIn:  subRoom?.actualCheckIn  ?? booking.actualCheckIn  ?? null,
        actualCheckOut: subRoom?.actualCheckOut ?? booking.actualCheckOut ?? null,
        nights:       subRoom?.nights ?? booking.nights,
        status:       subRoom?.status ?? booking.status,
        isGroup:      booking.isGroup ?? false,
        groupName:    booking.groupName ?? '',
        isGroupMember: !!subRoom,
        totalRoomsInBooking: Array.isArray(booking.rooms) ? booking.rooms.length : 1,
        // ⭐ NEW 11/05/2026: Tên chính sách giá để FE hiển thị trong card grid
        //   Ưu tiên sub-room.policyName (đoàn — mỗi phòng có policy riêng)
        //   Fallback booking.policyName (đơn)
        policyName:   subRoom?.policyName ?? booking.policyName ?? '',
        priceType:    subRoom?.priceType  ?? booking.priceType  ?? '',
        // ⭐ NEW 12/05/2026: Nguồn khách (Trực tiếp / Booking.com / Agoda / ...)
        //   source là field cấp booking — đoàn dùng chung 1 nguồn cho cả đoàn,
        //   không phải mỗi phòng có nguồn riêng → không có fallback từ subRoom.
        source:       booking.source ?? '',
      } : null
      obj.currentBookingId = booking?._id ?? null
      return obj
    })

    if (status) result = result.filter(r => r.realStatus === status)

    const total = result.length
    const data  = result.slice((+page - 1) * +limit, +page * +limit)

    res.json({ success: true, data: { data, total, page: +page, limit: +limit } })
  } catch (err) { next(err) }
}

// ── GET ONE ───────────────────────────────────────────
const getOne = async (req, res, next) => {
  try {
    const room = await Room.findById(req.params.id)
    if (!room)
      return res.status(404).json({ success: false, message: 'Không tìm thấy phòng' })

    const now = new Date()
    const activeBooking = await Booking.findOne({
      $or: [
        { roomId: room._id },
        { 'rooms.roomId': room._id },
      ],
      $and: [
        {
          $or: [
            { status: 'checked_in' },
            {
              status:   { $in: ['confirmed', 'reserved'] },
              checkOut: { $gte: now },
            },
          ],
        },
      ],
    }).sort({ status: -1, checkIn: 1 })

    let subRoom = null
    if (activeBooking) {
      if (activeBooking.roomId.toString() !== room._id.toString()) {
        subRoom = (activeBooking.rooms ?? []).find(r =>
          r.roomId && r.roomId.toString() === room._id.toString()
        ) ?? null
      }
    }

    const obj         = room.toObject()
    obj.realStatus    = computeRealStatus(room, activeBooking, subRoom)
    obj.activeBooking = activeBooking ?? null

    res.json({ success: true, data: { room: obj } })
  } catch (err) { next(err) }
}

// ── GET AVAILABLE ─────────────────────────────────────
const getAvailable = async (req, res, next) => {
  try {
    const { branchId, checkIn, checkOut } = req.query

    const filter = { roomStatus: 'active' }
    if (branchId) filter.branchId = branchId

    const rooms = await Room.find(filter).populate('typeId').sort({ number: 1 })
    const roomIds = rooms.map(r => r._id)

    if (checkIn && checkOut) {
      const checkInDate  = new Date(checkIn)
      const checkOutDate = new Date(checkOut)

      const conflictBookings = await Booking.find({
        $or: [
          { roomId:         { $in: roomIds } },
          { 'rooms.roomId': { $in: roomIds } },
        ],
        status:   { $in: ['confirmed', 'reserved', 'checked_in'] },
        checkIn:  { $lt: checkOutDate },
        checkOut: { $gt: checkInDate },
      })

      const conflictIds = new Set()
      for (const b of conflictBookings) {
        if (b.roomId) conflictIds.add(b.roomId.toString())
        if (Array.isArray(b.rooms)) {
          for (const sr of b.rooms) {
            if (sr.roomId) conflictIds.add(sr.roomId.toString())
          }
        }
      }

      const available = rooms.filter(r => !conflictIds.has(r._id.toString()))
      return res.json({ success: true, data: { data: available, total: available.length } })
    }

    const now = new Date()
    const activeBookings = await Booking.find({
      $or: [
        { roomId:         { $in: roomIds } },
        { 'rooms.roomId': { $in: roomIds } },
      ],
      $and: [
        {
          $or: [
            { status: 'checked_in' },
            {
              status:   { $in: ['confirmed', 'reserved'] },
              checkOut: { $gte: now },
            },
          ],
        },
      ],
    })

    const occupiedIds = new Set()
    for (const bk of activeBookings) {
      if (bk.roomId) occupiedIds.add(bk.roomId.toString())
      if (Array.isArray(bk.rooms)) {
        for (const sr of bk.rooms) {
          if (sr.roomId && (sr.status === 'reserved' || sr.status === 'checked_in')) {
            occupiedIds.add(sr.roomId.toString())
          }
        }
      }
    }

    const available = rooms.filter(r => {
      if (r.roomStatus !== 'active') return false
      return !occupiedIds.has(r._id.toString())
    })

    res.json({ success: true, data: { data: available, total: available.length } })
  } catch (err) { next(err) }
}

const create = async (req, res, next) => {
  try {
    const { number, typeId, floorId, branchId } = req.body
    if (!number || !typeId || !floorId || !branchId)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc' })

    const exists = await Room.findOne({ number, branchId })
    if (exists)
      return res.status(400).json({ success: false, message: `Phòng số ${number} đã tồn tại` })

    const room = await Room.create(req.body)
    res.status(201).json({ success: true, message: 'Tạo phòng thành công', data: { room } })
  } catch (err) { next(err) }
}

const update = async (req, res, next) => {
  try {
    const room = await Room.findByIdAndUpdate(
      req.params.id, req.body, { new: true, runValidators: true }
    )
    if (!room)
      return res.status(404).json({ success: false, message: 'Không tìm thấy phòng' })
    res.json({ success: true, message: 'Cập nhật thành công', data: { room } })
  } catch (err) { next(err) }
}

const updateStatus = async (req, res, next) => {
  try {
    const { status, notes } = req.body
    const valid = ['available', 'occupied', 'checkout', 'cleaning', 'maintenance', 'reserved']
    if (!status || !valid.includes(status))
      return res.status(400).json({ success: false, message: `Status không hợp lệ. Chọn: ${valid.join(', ')}` })

    const room = await Room.findByIdAndUpdate(
      req.params.id, { status, notes: notes ?? null }, { new: true }
    )
    if (!room)
      return res.status(404).json({ success: false, message: 'Không tìm thấy phòng' })
    res.json({ success: true, message: 'Cập nhật trạng thái thành công', data: { room } })
  } catch (err) { next(err) }
}

const remove = async (req, res, next) => {
  try {
    const room = await Room.findById(req.params.id)
    if (!room)
      return res.status(404).json({ success: false, message: 'Không tìm thấy phòng' })

    const now = new Date()
    const activeBooking = await Booking.findOne({
      $or: [
        { roomId: room._id },
        { 'rooms.roomId': room._id },
      ],
      status:   { $in: ['confirmed', 'reserved', 'checked_in'] },
      checkOut: { $gte: now },
    })
    if (activeBooking)
      return res.status(400).json({ success: false, message: 'Không thể xoá phòng đang có đặt phòng' })

    await room.deleteOne()
    res.json({ success: true, message: 'Đã xoá phòng' })
  } catch (err) { next(err) }
}

module.exports = { getAll, getOne, getAvailable, create, update, updateStatus, remove }