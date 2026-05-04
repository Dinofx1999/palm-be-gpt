// ─────────────────────────────────────────────────────
// Migration: backfill checkIn/checkOut/nights/priceType cho sub-rooms cũ
//   Trước đây sub-room không có dates riêng → dùng chung booking.checkIn/checkOut
//   Sau khi update schema, cần copy dates từ root sang sub-room cho data cũ
// Run: node scripts/migrate-subroom-dates.js
// ─────────────────────────────────────────────────────
require('dotenv').config()
const mongoose = require('mongoose')
const Booking  = require('../models/Booking')

;(async () => {
  try {
    const MONGO = process.env.MONGO_URI ?? process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/palm_pms'
    await mongoose.connect(MONGO)
    console.log('✅ Connected to', MONGO)

    // Tìm tất cả booking có rooms[] mà sub-room chưa có checkIn
    const bookings = await Booking.find({
      'rooms.0': { $exists: true },   // có ít nhất 1 sub-room
      $or: [
        { 'rooms.checkIn':  { $exists: false } },
        { 'rooms.checkIn':  null },
      ],
    })
    console.log(`Found ${bookings.length} booking(s) cần migration`)

    let updated = 0
    for (const bk of bookings) {
      let changed = false
      for (const sr of bk.rooms) {
        if (!sr.checkIn) {
          sr.checkIn  = bk.checkIn
          changed = true
        }
        if (!sr.checkOut) {
          sr.checkOut = bk.checkOut
          changed = true
        }
        if (!sr.nights) {
          sr.nights = bk.nights
          changed = true
        }
        if (!sr.priceType) {
          sr.priceType = bk.priceType
          changed = true
        }
      }
      if (changed) {
        await bk.save()
        updated++
        console.log(`📋 Booking ${bk._id} (${bk.customerName}): ${bk.rooms.length} sub-rooms backfilled`)
      }
    }

    console.log(`✅ Done. Updated ${updated} booking(s)`)
    process.exit(0)
  } catch (err) {
    console.error('❌ Migration error:', err)
    process.exit(1)
  }
})()