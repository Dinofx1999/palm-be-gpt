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

const computeRoomStatusCounts = async (branchId) => {
  const roomFilter = {}
  if (branchId) roomFilter.branchId = new mongoose.Types.ObjectId(branchId)

  const allRooms = await Room.find(roomFilter).select('_id roomStatus').lean()
  const totalRooms = allRooms.length

  const activeBookings = await Booking.find({
    ...(branchId ? { branchId: new mongoose.Types.ObjectId(branchId) } : {}),
    status: { $in: ['reserved', 'confirmed', 'checked_in'] },
  }).select('roomId rooms status').lean()

  const roomToStatus = new Map()
  const STATUS_PRIORITY = { checked_in: 3, confirmed: 2, reserved: 1 }
  for (const bk of activeBookings) {
    const roomIds = []
    if (bk.roomId) roomIds.push(String(bk.roomId))
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

const computeRevenueData = async (branchId, from, to, granularity) => {
  const matchStage = {
    status: 'checked_out',
    actualCheckOut: { $gte: from, $lte: to },
  }
  if (branchId) matchStage.branchId = new mongoose.Types.ObjectId(branchId)

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

// ⭐ NEW: Top phòng bán chạy trong range (theo doanh thu)
//   - Đếm số booking đã trả phòng (checked_out) trong from-to
//   - Tách cả group: nếu booking là đoàn, count từng sub-room
const computeTopRooms = async (branchId, from, to, limit = 5) => {
  const matchStage = {
    status: 'checked_out',
    actualCheckOut: { $gte: from, $lte: to },
  }
  if (branchId) matchStage.branchId = new mongoose.Types.ObjectId(branchId)

  const pipeline = [
    { $match: matchStage },
    {
      $facet: {
        singles: [
          { $match: { $or: [
            { rooms: { $exists: false } },
            { rooms: { $size: 0 } },
          ] } },
          {
            $group: {
              _id: '$roomId',
              roomNumber: { $first: '$roomNumber' },
              roomType:   { $first: '$roomType' },
              bookings:   { $sum: 1 },
              revenue:    { $sum: { $ifNull: ['$totalAmount', 0] } },
              nights:     { $sum: { $ifNull: ['$nights', 1] } },
            },
          },
        ],
        groups: [
          { $match: { rooms: { $exists: true, $not: { $size: 0 } } } },
          { $unwind: '$rooms' },
          { $match: { 'rooms.status': 'checked_out' } },
          {
            $group: {
              _id: '$rooms.roomId',
              roomNumber: { $first: '$rooms.roomNumber' },
              roomType:   { $first: '$rooms.roomType' },
              bookings:   { $sum: 1 },
              revenue:    { $sum: { $ifNull: ['$rooms.roomAmount', 0] } },
              nights:     { $sum: { $ifNull: ['$rooms.nights', 1] } },
            },
          },
        ],
      },
    },
    { $project: { all: { $concatArrays: ['$singles', '$groups'] } } },
    { $unwind: '$all' },
    {
      $group: {
        _id: '$all._id',
        roomNumber: { $first: '$all.roomNumber' },
        roomType:   { $first: '$all.roomType' },
        bookings:   { $sum: '$all.bookings' },
        revenue:    { $sum: '$all.revenue' },
        nights:     { $sum: '$all.nights' },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: limit },
  ]

  const result = await Booking.aggregate(pipeline)
  return result.map(r => ({
    roomId:     String(r._id),
    roomNumber: r.roomNumber ?? '—',
    typeName:   r.roomType ?? '',
    bookings:   r.bookings ?? 0,
    revenue:    r.revenue ?? 0,
    nights:     r.nights ?? 0,
  }))
}

// ⭐ NEW: Doanh thu theo loại phòng (cho pie chart)
const computeRevenueByRoomType = async (branchId, from, to) => {
  const matchStage = {
    status: 'checked_out',
    actualCheckOut: { $gte: from, $lte: to },
  }
  if (branchId) matchStage.branchId = new mongoose.Types.ObjectId(branchId)

  const pipeline = [
    { $match: matchStage },
    {
      $facet: {
        singles: [
          { $match: { $or: [
            { rooms: { $exists: false } },
            { rooms: { $size: 0 } },
          ] } },
          {
            $group: {
              _id: '$roomType',
              revenue: { $sum: { $ifNull: ['$totalAmount', 0] } },
              count:   { $sum: 1 },
            },
          },
        ],
        groups: [
          { $match: { rooms: { $exists: true, $not: { $size: 0 } } } },
          { $unwind: '$rooms' },
          { $match: { 'rooms.status': 'checked_out' } },
          {
            $group: {
              _id: '$rooms.roomType',
              revenue: { $sum: { $ifNull: ['$rooms.roomAmount', 0] } },
              count:   { $sum: 1 },
            },
          },
        ],
      },
    },
    { $project: { all: { $concatArrays: ['$singles', '$groups'] } } },
    { $unwind: '$all' },
    {
      $group: {
        _id: '$all._id',
        revenue: { $sum: '$all.revenue' },
        count:   { $sum: '$all.count' },
      },
    },
    { $sort: { revenue: -1 } },
  ]

  const result = await Booking.aggregate(pipeline)
  return result.map(r => ({
    typeName: r._id ?? 'Khác',
    revenue:  r.revenue ?? 0,
    count:    r.count ?? 0,
  }))
}

const getStats = async (req, res, next) => {
  try {
    const { branchId } = req.query
    const { range, from, to, granularity, buckets } = parseDateRange(req.query)

    // ⭐ NEW: Tính kỳ trước (cùng độ dài, lùi về trước period)
    //   - day: lùi 1 ngày (hôm qua)
    //   - week: lùi 7 ngày
    //   - month: lùi 30 ngày
    //   - custom: lùi đúng số ngày của range hiện tại
    const periodMs = to.getTime() - from.getTime()
    const prevTo   = new Date(from.getTime() - 1)             // 1ms trước "from" hiện tại
    const prevFrom = new Date(prevTo.getTime() - periodMs)
    prevFrom.setHours(0, 0, 0, 0)
    prevTo.setHours(23, 59, 59, 999)

    const today = new Date()
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0)
    const endOfDay   = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999)

    const branchFilter = branchId ? { branchId: new mongoose.Types.ObjectId(branchId) } : {}

    const [
      roomStatus,
      revenueData,
      // ⭐ NEW: Doanh thu kỳ trước (để chart so sánh)
      revenueDataPrev,
      todayCheckIns,
      todayCheckOuts,
      pendingBookings,
      todayRevenueAgg,
      topRooms,
      revenueByRoomType,
    ] = await Promise.all([
      computeRoomStatusCounts(branchId),
      computeRevenueData(branchId, from, to, granularity),
      computeRevenueData(branchId, prevFrom, prevTo, granularity),
      Booking.countDocuments({
        ...branchFilter,
        actualCheckIn: { $gte: startOfDay, $lte: endOfDay },
      }),
      Booking.countDocuments({
        ...branchFilter,
        actualCheckOut: { $gte: startOfDay, $lte: endOfDay },
      }),
      Booking.countDocuments({
        ...branchFilter,
        status: { $in: ['reserved', 'confirmed'] },
      }),
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
      computeTopRooms(branchId, from, to, 5),
      computeRevenueByRoomType(branchId, from, to),
    ])

    const todayRevenue = todayRevenueAgg[0]?.total ?? 0

    const aov = revenueData.totalBookings > 0
      ? Math.round(revenueData.totalRevenue / revenueData.totalBookings)
      : 0

    const arpu = roomStatus.totalRooms > 0
      ? Math.round(revenueData.totalRevenue / roomStatus.totalRooms)
      : 0

    const occupancyRate = roomStatus.totalRooms > 0
      ? Math.round((roomStatus.counts.occupied / roomStatus.totalRooms) * 100)
      : 0

    // ⭐ NEW: % thay đổi so với kỳ trước
    //   - prev > 0: tính %  ((cur - prev) / prev) * 100
    //   - prev = 0 và cur > 0: 100% (tăng từ 0)
    //   - cả 2 = 0: 0%
    const prevRev = revenueDataPrev.totalRevenue
    const curRev  = revenueData.totalRevenue
    let revenueChangePct = 0
    if (prevRev > 0) {
      revenueChangePct = Math.round(((curRev - prevRev) / prevRev) * 100)
    } else if (curRev > 0) {
      revenueChangePct = 100
    }

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
        todayRevenue,
        rangeRevenue:   revenueData.totalRevenue,
        rangeBookings:  revenueData.totalBookings,
        revenueChart:   revenueData.revenueChart,
        // ⭐ NEW: kỳ trước + % thay đổi
        previousRangeRevenue:  revenueDataPrev.totalRevenue,
        previousRangeBookings: revenueDataPrev.totalBookings,
        revenueChartPrevious:  revenueDataPrev.revenueChart,
        revenueChangePct,
        previousRange: { from: prevFrom, to: prevTo },
        range:         { type: range, from, to, granularity, buckets },

        // ── Activity hôm nay ──
        todayCheckIns,
        todayCheckOuts,
        pendingBookings,

        // ── KPI ──
        aov,
        arpu,

        // Top rooms + pie
        topRooms,
        revenueByRoomType,
      },
    })
  } catch (err) {
    console.error('[dashboardController.getStats] Error:', err)
    next(err)
  }
}

module.exports = { getStats }