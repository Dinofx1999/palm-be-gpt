const Room    = require('../models/Room');
const Booking = require('../models/Booking');

// ── Tính trạng thái động theo booking.status ──────────
// ⭐ subRoomStatus: nếu là phòng trong đoàn, dùng status RIÊNG của sub-room
const computeRealStatus = (room, activeBooking, subRoom = null) => {
  // Trạng thái quản lý của phòng (override)
  if (room.roomStatus === 'maintenance') return 'maintenance'
  if (room.roomStatus === 'inactive')    return 'cleaning'

  // Không có booking → phòng trống
  if (!activeBooking)                       return 'available'
  if (activeBooking.status === 'cancelled') return 'available'

  // ⭐ Nếu là phòng trong đoàn (sub-room), ưu tiên status riêng
  const effectiveStatus = subRoom?.status ?? activeBooking.status

  if (effectiveStatus === 'checked_in') {
    const now = new Date()
    if (now >= new Date(activeBooking.checkOut)) return 'checkout'
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

// ⭐ HELPER: tìm booking đang active cho 1 phòng (check cả root + sub-rooms)
// Trả về { booking, subRoom } — subRoom có giá trị khi phòng là member của đoàn (KHÔNG phải primary)
const findActiveBookingForRoom = (allBookings, roomId) => {
  const ridStr = roomId.toString()
  for (const bk of allBookings) {
    // Check root
    if (bk.roomId && bk.roomId.toString() === ridStr) {
      return { booking: bk, subRoom: null }
    }
    // Check sub-rooms (đoàn)
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

    // ⭐ Query CẢ root roomId + rooms[].roomId
    const activeBookings = await Booking.find({
      $or: [
        { roomId:         { $in: roomIds } },
        { 'rooms.roomId': { $in: roomIds } },
      ],
      status:   { $in: ['confirmed', 'reserved', 'checked_in'] },
      checkOut: { $gte: now },
    })

    // ⭐ Build map: roomId → { booking, subRoom }
    // Nếu 1 phòng có nhiều booking active, ưu tiên: checked_in > reserved
    const bookingMap = {}
    for (const bk of activeBookings) {
      // Tất cả phòng liên quan đến booking này
      const relatedRooms = []

      // ⭐ Phòng root: phải LINK với sub-room tương ứng trong rooms[] (nếu có)
      // Vì sub-room có status RIÊNG (vd: phòng root đã checkout nhưng booking root vẫn checked_in
      //  vì còn phòng khác đang ở). Nếu subRoom=null thì sẽ fallback về bk.status → SAI.
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
            // Nếu phòng đã có ở root rồi (đã link sub-room ở trên) thì skip
            const ridStr = sr.roomId.toString()
            if (bk.roomId && bk.roomId.toString() === ridStr) continue
            relatedRooms.push({ roomId: ridStr, subRoom: sr })
          }
        }
      }

      for (const { roomId: rid, subRoom } of relatedRooms) {
        // ⭐ Skip nếu sub-room đã checkout/cancelled
        // (Booking root vẫn 'checked_in' vì còn phòng khác đang ở,
        //  nhưng phòng cụ thể này đã trả → KHÔNG được hiển thị "Đang ở")
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
          // Ưu tiên checked_in
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
        // ⭐ Ưu tiên dates per-room (sub.checkIn) — fallback booking root
        //   Mỗi phòng trong đoàn có thể có dates khác nhau sau khi đổi ngày per-room
        checkIn:      subRoom?.checkIn  ?? booking.checkIn,
        checkOut:     subRoom?.checkOut ?? booking.checkOut,
        // ⭐ NEW: Giờ check-in/out THỰC TẾ (sub-room ưu tiên cho đoàn)
        actualCheckIn:  subRoom?.actualCheckIn  ?? booking.actualCheckIn  ?? null,
        actualCheckOut: subRoom?.actualCheckOut ?? booking.actualCheckOut ?? null,
        nights:       subRoom?.nights ?? booking.nights,
        // ⭐ Status RIÊNG của sub-room nếu là phòng đoàn, fallback root status
        status:       subRoom?.status ?? booking.status,
        // ⭐ Info đoàn (FE có thể dùng để hiển thị icon/badge "đoàn")
        isGroup:      booking.isGroup ?? false,
        groupName:    booking.groupName ?? '',
        isGroupMember: !!subRoom,            // true = phòng trong đoàn (không phải primary)
        // Tổng số phòng của booking (đoàn)
        totalRoomsInBooking: Array.isArray(booking.rooms) ? booking.rooms.length : 1,
      } : null
      // ⭐ Để tương thích với code hiện có dùng currentBookingId
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
    // ⭐ Tìm booking trong cả root + rooms[]
    const activeBooking = await Booking.findOne({
      $or: [
        { roomId: room._id },
        { 'rooms.roomId': room._id },
      ],
      status:   { $in: ['confirmed', 'reserved', 'checked_in'] },
      checkOut: { $gte: now },
    }).sort({ status: -1, checkIn: 1 })

    let subRoom = null
    if (activeBooking) {
      // Check xem phòng này là primary hay sub
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

      // ⭐ Conflict check cho cả root + rooms[]
      const conflictBookings = await Booking.find({
        $or: [
          { roomId:         { $in: roomIds } },
          { 'rooms.roomId': { $in: roomIds } },
        ],
        status:   { $in: ['confirmed', 'reserved', 'checked_in'] },
        checkIn:  { $lt: checkOutDate },
        checkOut: { $gt: checkInDate },
      })

      // ⭐ Build set chứa tất cả roomId bị conflict (cả primary + sub-rooms)
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

    // Không có date → check tất cả booking active
    const now = new Date()
    const activeBookings = await Booking.find({
      $or: [
        { roomId:         { $in: roomIds } },
        { 'rooms.roomId': { $in: roomIds } },
      ],
      status:   { $in: ['confirmed', 'reserved', 'checked_in'] },
      checkOut: { $gte: now },
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
      // Phòng có roomStatus override
      if (r.roomStatus !== 'active') return false
      return !occupiedIds.has(r._id.toString())
    })

    res.json({ success: true, data: { data: available, total: available.length } })
  } catch (err) { next(err) }
}

// ── CREATE ────────────────────────────────────────────
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

// ── UPDATE ────────────────────────────────────────────
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

// ── UPDATE STATUS (manual override) ──────────────────
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

// ── DELETE ────────────────────────────────────────────
const remove = async (req, res, next) => {
  try {
    const room = await Room.findById(req.params.id)
    if (!room)
      return res.status(404).json({ success: false, message: 'Không tìm thấy phòng' })

    const now = new Date()
    // ⭐ Check cả root + rooms[]
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