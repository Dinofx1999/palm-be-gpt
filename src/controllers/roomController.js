const Room    = require('../models/Room');
const Booking = require('../models/Booking');

// ── Tính trạng thái động theo booking.status ──────────
// ⭐ FIX 14/05/2026:
//   - Phòng có booking SẮP TỚI (now < checkIn) → 'available' (vẫn trống)
//     Trước đây trả 'reserved' → user thấy "Đã đặt" ngay từ hôm trước
//   - Thông tin booking sắp tới được gắn vào field `upcomingBooking` riêng
const computeRealStatus = (room, activeBooking, subRoom = null) => {
  if (room.roomStatus === 'maintenance') return 'maintenance'
  if (room.roomStatus === 'inactive')    return 'cleaning'

  if (!activeBooking)                       return 'available'
  if (activeBooking.status === 'cancelled') return 'available'

  const effectiveStatus = subRoom?.status ?? activeBooking.status

  if (effectiveStatus === 'checked_in') {
    // Khách đã check-in → đang ở (bất kể giờ checkOut đã qua hay chưa)
    return 'occupied'
  }

  if (effectiveStatus === 'checked_out') {
    return 'checkout'
  }

  if (effectiveStatus === 'reserved' || effectiveStatus === 'confirmed') {
    const now = new Date()
    const refCheckIn  = new Date(subRoom?.checkIn  ?? activeBooking.checkIn)
    const refCheckOut = new Date(subRoom?.checkOut ?? activeBooking.checkOut)

    // ⭐ NEW: Nếu CHƯA tới giờ check-in → phòng vẫn TRỐNG
    //   (booking là upcoming, chưa ảnh hưởng đến trạng thái phòng hiện tại)
    if (now < refCheckIn) {
      return 'available'
    }

    // Đã quá giờ checkOut nhưng vẫn ở status reserved/confirmed
    // (lỗi nghiệp vụ: lễ tân quên đổi sang checked_out) → coi như checkout
    if (now >= refCheckOut) return 'checkout'

    // now ∈ [checkIn, checkOut] mà chưa checked_in → "reserved" hợp lệ
    //   (vd khách đã đến trong khung giờ nhưng lễ tân chưa bấm CI)
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

    // ⭐ NEW: Tách booking thành 2 nhóm:
    //   - currentMap: booking đang ảnh hưởng đến phòng (đang ở, đã reserve và checkIn <= now)
    //   - upcomingMap: booking sắp tới (now < checkIn) — không đổi realStatus nhưng FE cần biết
    const currentMap  = {}    // roomId → { booking, subRoom }
    const upcomingMap = {}    // roomId → { booking, subRoom } (booking gần nhất sắp tới)

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

        const refCheckIn = new Date(subRoom?.checkIn ?? bk.checkIn)
        // ⭐ Booking sắp tới: status reserved/confirmed VÀ chưa tới giờ check-in
        const isUpcoming = (effectiveStatus === 'reserved' || effectiveStatus === 'confirmed')
                          && now < refCheckIn

        if (isUpcoming) {
          // Gắn vào upcomingMap — pick booking gần nhất (checkIn sớm nhất)
          if (!upcomingMap[rid]
              || refCheckIn < new Date(upcomingMap[rid].subRoom?.checkIn ?? upcomingMap[rid].booking.checkIn)) {
            upcomingMap[rid] = { booking: bk, subRoom }
          }
        } else {
          // Booking hiện tại (checked_in hoặc đã tới giờ check-in)
          if (!currentMap[rid]) {
            currentMap[rid] = { booking: bk, subRoom }
          } else {
            const cur = currentMap[rid]
            const curStatus = cur.subRoom?.status ?? cur.booking.status
            const newStatus = effectiveStatus
            // Ưu tiên checked_in
            if (curStatus !== 'checked_in' && newStatus === 'checked_in') {
              currentMap[rid] = { booking: bk, subRoom }
            } else if (curStatus === newStatus && new Date(bk.checkIn) < new Date(cur.booking.checkIn)) {
              currentMap[rid] = { booking: bk, subRoom }
            }
          }
        }
      }
    }

    let result = rooms.map(r => {
      const obj      = r.toObject()
      const ridStr   = r._id.toString()
      const entry    = currentMap[ridStr] ?? { booking: null, subRoom: null }
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
        policyName:   subRoom?.policyName ?? booking.policyName ?? '',
        priceType:    subRoom?.priceType  ?? booking.priceType  ?? '',
        source:       booking.source ?? '',
      } : null
      obj.currentBookingId = booking?._id ?? null

      // ⭐ NEW 14/05/2026: Booking sắp tới (phòng vẫn trống)
      //   FE dùng để hiển thị badge 📅 góc phải + tooltip
      const upcomingEntry = upcomingMap[ridStr]
      if (upcomingEntry) {
        const ub = upcomingEntry.booking
        const usr = upcomingEntry.subRoom
        const upCheckIn = usr?.checkIn ?? ub.checkIn
        obj.upcomingBooking = {
          id:           ub._id,
          customerName: ub.customerName,
          customerPhone: ub.customerPhone ?? '',
          checkIn:      upCheckIn,
          checkOut:     usr?.checkOut ?? ub.checkOut,
          status:       usr?.status ?? ub.status,
          isGroup:      ub.isGroup ?? false,
          groupName:    ub.groupName ?? '',
          policyName:   usr?.policyName ?? ub.policyName ?? '',
          priceType:    usr?.priceType  ?? ub.priceType  ?? '',
          source:       ub.source ?? '',
          // Tiện cho FE: số giờ nữa đến check-in
          hoursUntil:   Math.max(0, Math.round((new Date(upCheckIn) - now) / 3600000)),
        }
      } else {
        obj.upcomingBooking = null
      }

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
    // ⭐ Lấy TẤT CẢ booking liên quan (cả hiện tại + upcoming)
    const allBookings = await Booking.find({
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

    // ⭐ Tách thành booking hiện tại + booking sắp tới
    let currentBooking = null
    let currentSubRoom = null
    let upcomingBooking = null
    let upcomingSubRoom = null

    for (const bk of allBookings) {
      let subRoom = null
      if (bk.roomId.toString() !== room._id.toString()) {
        subRoom = (bk.rooms ?? []).find(r =>
          r.roomId && r.roomId.toString() === room._id.toString()
        ) ?? null
      }

      const effectiveStatus = subRoom?.status ?? bk.status
      const refCheckIn = new Date(subRoom?.checkIn ?? bk.checkIn)
      const isUpcoming = (effectiveStatus === 'reserved' || effectiveStatus === 'confirmed')
                        && now < refCheckIn

      if (isUpcoming) {
        // Pick booking gần nhất
        if (!upcomingBooking || refCheckIn < new Date(upcomingSubRoom?.checkIn ?? upcomingBooking.checkIn)) {
          upcomingBooking = bk
          upcomingSubRoom = subRoom
        }
      } else {
        // Booking hiện tại — ưu tiên checked_in
        if (!currentBooking
            || (effectiveStatus === 'checked_in'
                && (currentSubRoom?.status ?? currentBooking.status) !== 'checked_in')) {
          currentBooking = bk
          currentSubRoom = subRoom
        }
      }
    }

    const obj         = room.toObject()
    obj.realStatus    = computeRealStatus(room, currentBooking, currentSubRoom)
    obj.activeBooking = currentBooking ?? null

    // ⭐ NEW: upcomingBooking
    if (upcomingBooking) {
      const ub = upcomingBooking
      const usr = upcomingSubRoom
      const upCheckIn = usr?.checkIn ?? ub.checkIn
      obj.upcomingBooking = {
        id:           ub._id,
        customerName: ub.customerName,
        customerPhone: ub.customerPhone ?? '',
        checkIn:      upCheckIn,
        checkOut:     usr?.checkOut ?? ub.checkOut,
        status:       usr?.status ?? ub.status,
        isGroup:      ub.isGroup ?? false,
        groupName:    ub.groupName ?? '',
        policyName:   usr?.policyName ?? ub.policyName ?? '',
        priceType:    usr?.priceType  ?? ub.priceType  ?? '',
        source:       ub.source ?? '',
        hoursUntil:   Math.max(0, Math.round((new Date(upCheckIn) - now) / 3600000)),
      }
    } else {
      obj.upcomingBooking = null
    }

    res.json({ success: true, data: { room: obj } })
  } catch (err) { next(err) }
}

// ── GET AVAILABLE ─────────────────────────────────────
// ⚠️ KHÔNG đổi logic này:
//   - Khi user pick checkIn/checkOut → check overlap booking → đúng
//   - Khi không pick → chỉ trả phòng KHÔNG có active booking nào
//   Đây là endpoint dành riêng cho "đặt phòng cho ngày X" — booking
//   tương lai vẫn phải loại ra để tránh double-book.
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