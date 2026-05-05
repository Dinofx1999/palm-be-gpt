const Room    = require('../models/Room');
const Booking = require('../models/Booking');
const Invoice = require('../models/Invoice');
const mongoose = require('mongoose');

// ⭐ Helper: parse range từ query
//   ?range=day | week | month | custom
//   ?from=2026-05-01&to=2026-05-31  (chỉ dùng khi range=custom)
const parseDateRange = (query) => {
  const range = (query.range ?? 'week').toLowerCase()
  const now = new Date()

  let from, to, granularity, buckets
  switch (range) {
    case 'day': {
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
      to   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
      granularity = 'hour'
      buckets = 24
      break
    }
    case 'month': {
      to   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
      from = new Date(to)
      from.setDate(to.getDate() - 29)
      from.setHours(0, 0, 0, 0)
      granularity = 'day'
      buckets = 30
      break
    }
    case 'custom': {
      from = query.from ? new Date(query.from) : new Date(now.getFullYear(), now.getMonth(), 1)
      to   = query.to   ? new Date(query.to)   : new Date()
      from.setHours(0, 0, 0, 0)
      to.setHours(23, 59, 59, 999)
      // Auto granularity theo độ rộng
      const days = Math.ceil((to - from) / 86400000)
      if (days <= 2)       { granularity = 'hour';  buckets = days * 24 }
      else if (days <= 60) { granularity = 'day';   buckets = days }
      else                 { granularity = 'month'; buckets = Math.ceil(days / 30) }
      break
    }
    case 'week':
    default: {
      to   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
      from = new Date(to)
      from.setDate(to.getDate() - 6)
      from.setHours(0, 0, 0, 0)
      granularity = 'day'
      buckets = 7
      break
    }
  }
  return { range, from, to, granularity, buckets }
}

// ⭐ Helper: format date theo granularity
const formatBucketKey = (d, granularity) => {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  if (granularity === 'hour')  return `${yyyy}-${mm}-${dd} ${hh}:00`
  if (granularity === 'day')   return `${yyyy}-${mm}-${dd}`
  if (granularity === 'month') return `${yyyy}-${mm}`
  return `${yyyy}-${mm}-${dd}`
}

// ⭐ Helper: build empty buckets giữa from→to để chart không bị trống
const buildEmptyBuckets = (from, to, granularity) => {
  const out = []
  const cur = new Date(from)
  while (cur <= to) {
    out.push({ key: formatBucketKey(cur, granularity), amount: 0, count: 0 })
    if (granularity === 'hour')  cur.setHours(cur.getHours() + 1)
    if (granularity === 'day')   cur.setDate(cur.getDate() + 1)
    if (granularity === 'month') cur.setMonth(cur.getMonth() + 1)
  }
  return out
}

// ⭐ Compute room status thực tế (giống logic FE realStatusOf)
//   Cần aggregate Booking active để biết phòng nào đang có khách
const computeRoomStatusCounts = async (branchId) => {
  const roomFilter = {}
  if (branchId) roomFilter.branchId = new mongoose.Types.ObjectId(branchId)

  const allRooms = await Room.find(roomFilter).select('_id roomStatus').lean()
  const totalRooms = allRooms.length

  // Lấy các booking đang active (có thể chiếm phòng)
  const activeBookings = await Booking.find({
    ...(branchId ? { branchId: new mongoose.Types.ObjectId(branchId) } : {}),
    status: { $in: ['reserved', 'confirmed', 'checked_in'] },
  }).select('roomId rooms status').lean()

  // Map roomId → bookingStatus (ưu tiên checked_in > confirmed > reserved)
  const roomToStatus = new Map()
  const STATUS_PRIORITY = { checked_in: 3, confirmed: 2, reserved: 1 }
  for (const bk of activeBookings) {
    // Booking đơn: roomId
    const roomIds = []
    if (bk.roomId) roomIds.push(String(bk.roomId))
    // Booking đoàn: rooms[]
    if (Array.isArray(bk.rooms)) {
      for (const sr of bk.rooms) {
        if (sr.roomId && sr.status !== 'cancelled') {
          roomIds.push(String(sr.roomId._id ?? sr.roomId))
        }
      }
    }
    for (const rid of roomIds) {
      const prev = roomToStatus.get(rid)
      const prevP = prev ? STATUS_PRIORITY[prev] ?? 0 : 0
      const curP = STATUS_PRIORITY[bk.status] ?? 0
      if (curP > prevP) roomToStatus.set(rid, bk.status)
    }
  }

  // Compute realStatus cho từng room
  const counts = {
    available: 0, reserved: 0, occupied: 0,
    checkout: 0, cleaning: 0, maintenance: 0,
  }
  for (const r of allRooms) {
    const mgmt = r.roomStatus ?? 'active'
    const bookingStatus = roomToStatus.get(String(r._id))

    let real
    if (mgmt === 'maintenance') real = 'maintenance'
    else if (mgmt === 'inactive') real = bookingStatus ? 'occupied' : 'cleaning'
    else if (bookingStatus === 'reserved' || bookingStatus === 'confirmed') real = 'reserved'
    else if (bookingStatus === 'checked_in') real = 'occupied'
    else real = 'available'

    counts[real] = (counts[real] ?? 0) + 1
  }

  return { totalRooms, counts }
}

// ⭐ Compute revenue từ Booking.actualCheckOut
//   - Doanh thu = totalAmount của booking
//   - Chỉ tính booking đã checked_out (có actualCheckOut)
//   - Nếu không có actualCheckOut, fallback checkOut (lịch dự kiến)
const computeRevenueData = async (branchId, from, to, granularity) => {
  const matchStage = {
    status: 'checked_out',
    actualCheckOut: { $gte: from, $lte: to },
  }
  if (branchId) matchStage.branchId = new mongoose.Types.ObjectId(branchId)

  // Bucket format theo granularity
  let bucketFormat
  if (granularity === 'hour')  bucketFormat = '%Y-%m-%d %H:00'
  if (granularity === 'day')   bucketFormat = '%Y-%m-%d'
  if (granularity === 'month') bucketFormat = '%Y-%m'

  const aggResult = await Booking.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id:    { $dateToString: { format: bucketFormat, date: '$actualCheckOut' } },
        amount: { $sum: { $ifNull: ['$totalAmount', 0] } },
        count:  { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ])

  // Build empty buckets + fill
  const empty = buildEmptyBuckets(from, to, granularity)
  const aggMap = new Map(aggResult.map(r => [r._id, { amount: r.amount, count: r.count }]))

  const filled = empty.map(b => {
    const found = aggMap.get(b.key)
    return {
      key:    b.key,
      amount: found?.amount ?? 0,
      count:  found?.count  ?? 0,
    }
  })

  const totalRevenue = filled.reduce((s, b) => s + b.amount, 0)
  const totalBookings = filled.reduce((s, b) => s + b.count, 0)

  return { revenueChart: filled, totalRevenue, totalBookings }
}

const getStats = async (req, res, next) => {
  try {
    const { branchId } = req.query
    const { range, from, to, granularity, buckets } = parseDateRange(req.query)

    const today = new Date()
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0)
    const endOfDay   = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999)

    // Filter theo branchId
    const branchFilter = branchId ? { branchId: new mongoose.Types.ObjectId(branchId) } : {}

    // Run mọi thứ song song
    const [
      roomStatus,
      revenueData,
      todayCheckIns,
      todayCheckOuts,
      pendingBookings,
      todayRevenueAgg,
    ] = await Promise.all([
      computeRoomStatusCounts(branchId),
      computeRevenueData(branchId, from, to, granularity),
      // Nhận phòng hôm nay (đã actual check-in)
      Booking.countDocuments({
        ...branchFilter,
        actualCheckIn: { $gte: startOfDay, $lte: endOfDay },
      }),
      // Trả phòng hôm nay (đã actual check-out)
      Booking.countDocuments({
        ...branchFilter,
        actualCheckOut: { $gte: startOfDay, $lte: endOfDay },
      }),
      // Booking đang chờ check-in (reserved/confirmed)
      Booking.countDocuments({
        ...branchFilter,
        status: { $in: ['reserved', 'confirmed'] },
      }),
      // Doanh thu hôm nay riêng (luôn show, không phụ thuộc range tab)
      Booking.aggregate([
        {
          $match: {
            ...branchFilter,
            status: 'checked_out',
            actualCheckOut: { $gte: startOfDay, $lte: endOfDay },
          },
        },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$totalAmount', 0] } } } },
      ]),
    ])

    const todayRevenue = todayRevenueAgg[0]?.total ?? 0

    // KPI tính từ revenueData của tab range
    const aov = revenueData.totalBookings > 0
      ? Math.round(revenueData.totalRevenue / revenueData.totalBookings)
      : 0

    // ARPU = doanh thu / số phòng đã được dùng (trong range)
    const arpu = roomStatus.totalRooms > 0
      ? Math.round(revenueData.totalRevenue / roomStatus.totalRooms)
      : 0

    const occupancyRate = roomStatus.totalRooms > 0
      ? Math.round((roomStatus.counts.occupied / roomStatus.totalRooms) * 100)
      : 0

    res.json({
      success: true,
      data: {
        // ── Phòng ──
        totalRooms:       roomStatus.totalRooms,
        availableRooms:   roomStatus.counts.available,
        occupiedRooms:    roomStatus.counts.occupied,
        reservedRooms:    roomStatus.counts.reserved,
        checkoutRooms:    roomStatus.counts.checkout,
        cleaningRooms:    roomStatus.counts.cleaning,
        maintenanceRooms: roomStatus.counts.maintenance,
        roomStatusSummary: roomStatus.counts,
        occupancyRate,

        // ── Doanh thu ──
        todayRevenue,                                  // luôn là hôm nay
        rangeRevenue:   revenueData.totalRevenue,      // theo tab range
        rangeBookings:  revenueData.totalBookings,
        revenueChart:   revenueData.revenueChart,      // [{key, amount, count}]
        range:          { type: range, from, to, granularity, buckets },

        // ── Activity hôm nay ──
        todayCheckIns,
        todayCheckOuts,
        pendingBookings,

        // ── KPI ──
        aov,    // Average Order Value (doanh thu / số booking trong range)
        arpu,   // Avg Revenue Per Room (doanh thu / số phòng tổng)
      },
    })
  } catch (err) {
    console.error('[dashboardController.getStats] Error:', err)
    next(err)
  }
}

module.exports = { getStats }