// ════════════════════════════════════════════════════════════════════════════
// 📁 FILE: migrations/003-migrate-inactive-to-dirty.js
// 🎯 PHASE 2: Convert roomStatus='inactive' (do checkout) → 'dirty'
//
// ⚠️ CHẠY 1 LẦN trước khi deploy code Phase 2
// 🚀 USAGE: node migrations/003-migrate-inactive-to-dirty.js
//
// ════════════════════════════════════════════════════════════════════════════
// VẤN ĐỀ:
//   Trước Phase 2, khi khách checkout → code set Room.roomStatus = 'inactive'.
//   Sau Phase 2, ý nghĩa của 'inactive' đổi thành "admin disable".
//   → Cần migrate: phòng nào đang 'inactive' DO CHECKOUT → đổi sang 'dirty'
//
// CHIẾN LƯỢC NHẬN DIỆN:
//   Một phòng được coi là "đang inactive do checkout" nếu THỎA MÃN cả 2:
//   (a) roomStatus hiện tại = 'inactive'
//   (b) Có AuditLog action 'checkout' hoặc 'checkout_room' cho phòng này trong 30 ngày gần đây
//   (c) currentBookingId = null (booking đã đóng, không còn ai ở)
//
// Phòng KHÔNG match điều kiện trên → giữ nguyên 'inactive' (đúng nghĩa admin disable)
//
// IDEMPOTENT: chạy nhiều lần OK (chỉ chuyển phòng nào còn 'inactive', đã 'dirty' rồi thì skip)
// ════════════════════════════════════════════════════════════════════════════

require('dotenv').config()
const mongoose = require('mongoose')

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI
const LOOKBACK_DAYS = 30  // chỉ xét audit log trong 30 ngày gần đây

;(async () => {
  try {
    await mongoose.connect(MONGO_URI)
    console.log('✅ Connected to MongoDB')

    const Room     = mongoose.connection.collection('rooms')
    const AuditLog = mongoose.connection.collection('auditlogs')

    // 1. Tìm tất cả phòng đang inactive và không có booking active
    const inactiveRooms = await Room.find({
      roomStatus: 'inactive',
      currentBookingId: null,
    }, { projection: { _id: 1, number: 1, branchId: 1, updatedAt: 1 } }).toArray()

    console.log(`\n🔍 Found ${inactiveRooms.length} rooms in 'inactive' state with no current booking`)

    if (inactiveRooms.length === 0) {
      console.log('✅ Nothing to migrate.')
      await mongoose.disconnect()
      process.exit(0)
    }

    const lookbackDate = new Date(Date.now() - LOOKBACK_DAYS * 86400000)
    let toUpdate = []
    let keepInactive = []

    for (const room of inactiveRooms) {
      // 2. Check xem có audit log checkout nào liên quan đến phòng này không
      //    AuditLog metadata.roomNumber === room.number
      const checkoutLog = await AuditLog.findOne({
        action:                   { $in: ['checkout', 'checkout_room'] },
        'metadata.roomNumber':    String(room.number),
        branchId:                 room.branchId,
        createdAt:                { $gte: lookbackDate },
      }, { projection: { _id: 1, createdAt: 1, action: 1 } })

      if (checkoutLog) {
        toUpdate.push({
          roomId:         room._id,
          roomNumber:     room.number,
          lastCheckoutAt: checkoutLog.createdAt,
        })
        console.log(`  ✓ Room ${room.number}: checkout log found at ${checkoutLog.createdAt.toISOString()} → will mark 'dirty'`)
      } else {
        keepInactive.push(room.number)
      }
    }

    console.log(`\n📊 Migration plan:`)
    console.log(`  Will mark 'dirty':       ${toUpdate.length}`)
    console.log(`  Keep 'inactive' as-is:   ${keepInactive.length}`)
    if (keepInactive.length > 0 && keepInactive.length <= 20) {
      console.log(`    (rooms: ${keepInactive.join(', ')})`)
    }

    if (toUpdate.length === 0) {
      console.log('\n✅ No rooms need migration.')
      await mongoose.disconnect()
      process.exit(0)
    }

    console.log('\n🔧 Performing migration...')
    let updatedCount = 0
    for (const item of toUpdate) {
      const result = await Room.updateOne(
        { _id: item.roomId },
        {
          $set: {
            roomStatus:     'dirty',
            lastCheckoutAt: item.lastCheckoutAt,
            // KHÔNG set lastCleanedAt — phòng đang dirty, chưa được dọn
          },
        }
      )
      if (result.modifiedCount > 0) updatedCount++
    }

    console.log(`\n✅ Migrated ${updatedCount}/${toUpdate.length} rooms to 'dirty'`)
    console.log(`✅ Kept ${keepInactive.length} rooms as 'inactive' (admin-disabled)`)

    // 3. Verify
    const dirtyCount = await Room.countDocuments({ roomStatus: 'dirty' })
    const inactiveCount = await Room.countDocuments({ roomStatus: 'inactive' })
    console.log(`\n📊 Final state:`)
    console.log(`  Total dirty rooms:    ${dirtyCount}`)
    console.log(`  Total inactive rooms: ${inactiveCount}`)

    await mongoose.disconnect()
    process.exit(0)
  } catch (err) {
    console.error('❌ Migration failed:', err)
    process.exit(1)
  }
})()