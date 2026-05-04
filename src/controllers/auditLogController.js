const AuditLog = require('../models/AuditLog');
const User     = require('../models/User');
const mongoose = require('mongoose');

// ⭐ Helper: enrich logs với fullName từ User collection
//   Logs cũ có thể lưu userName=username thay vì fullName.
//   Logic: query User theo userId, override userName = fullName nếu User có fullName.
async function enrichUserNames(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return logs

  // Lấy distinct userId không null
  const userIds = [...new Set(
    logs.map(l => l.userId).filter(Boolean).map(id => String(id))
  )]
  if (userIds.length === 0) return logs

  try {
    const users = await User.find({ _id: { $in: userIds } })
      .select('fullName username email')
      .lean()
    const map = new Map(users.map(u => [String(u._id), u]))

    return logs.map(l => {
      const obj = l.toObject ? l.toObject() : { ...l }
      const u = obj.userId ? map.get(String(obj.userId)) : null
      if (u) {
        // Ưu tiên fullName → username → email → giữ nguyên userName cũ
        obj.userName = u.fullName || u.username || u.email || obj.userName || ''
      }
      return obj
    })
  } catch (err) {
    console.error('[enrichUserNames] error:', err.message)
    return logs
  }
}

// GET /audit-logs?entityType=&entityId=&branchId=&page=1&limit=20
const getAll = async (req, res, next) => {
  try {
    const {
      entityType, entityId, branchId, userId, action,
      from, to, page = 1, limit = 20,
    } = req.query

    const filter = {}
    if (entityType) filter.entityType = entityType
    if (entityId)   filter.entityId   = entityId
    if (branchId)   filter.branchId   = branchId
    if (userId)     filter.userId     = userId
    if (action)     filter.action     = action

    if (from || to) {
      filter.createdAt = {}
      if (from) filter.createdAt.$gte = new Date(from)
      if (to)   filter.createdAt.$lte = new Date(to)
    }

    const total = await AuditLog.countDocuments(filter)
    const rawData = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit)
    const data = await enrichUserNames(rawData)

    res.json({ success: true, data: { data, total, page: +page, limit: +limit } })
  } catch (err) { next(err) }
}

// GET /audit-logs/recent?limit=20
// Endpoint nhanh cho icon thông báo ở header
const getRecent = async (req, res, next) => {
  try {
    const { limit = 20, branchId } = req.query
    const filter = {}
    if (branchId) filter.branchId = branchId

    const rawData = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(+limit, 50))
    const data = await enrichUserNames(rawData)
    res.json({ success: true, data: { data, total: data.length } })
  } catch (err) { next(err) }
}

// ⭐ GET /audit-logs/by-booking/:bookingId
//   Trả tất cả log liên quan đến 1 booking — từ:
//   - entityType=Booking + entityId=bookingId
//   - entityType=Invoice với invoice của booking
//   - entityType=BookingService với booking metadata
//   - Hoặc bất cứ log nào có metadata.bookingId match
const getByBooking = async (req, res, next) => {
  try {
    const { bookingId } = req.params
    const { limit = 200 } = req.query
    if (!bookingId) {
      return res.status(400).json({ success: false, message: 'Thiếu bookingId' })
    }

    // ⭐ bookingId trong metadata được lưu là ObjectId (Mixed type giữ nguyên kiểu)
    //   nên cần match cả ObjectId lẫn string (để chắc chắn trong mọi trường hợp)
    let bookingObjectId = null
    try {
      if (mongoose.Types.ObjectId.isValid(bookingId)) {
        bookingObjectId = new mongoose.Types.ObjectId(bookingId)
      }
    } catch { /* ignore */ }

    const filter = {
      $or: [
        { entityType: 'Booking', entityId: bookingId },
        // Match metadata.bookingId — thử cả ObjectId và string
        { 'metadata.bookingId': bookingId },
        ...(bookingObjectId ? [{ 'metadata.bookingId': bookingObjectId }] : []),
      ],
    }

    const rawData = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(+limit, 500))
    const data = await enrichUserNames(rawData)

    res.json({ success: true, data: { data, total: data.length } })
  } catch (err) { next(err) }
}

module.exports = { getAll, getRecent, getByBooking };