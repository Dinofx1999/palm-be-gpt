// Chạy: node check-mongo-setup.js
// Đặt file này cùng cấp với index.js của backend

require('dotenv').config()
const mongoose = require('mongoose')

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI

;(async () => {
  if (!MONGO_URI) {
    console.error('❌ Không tìm thấy MONGO_URI trong .env')
    console.error('   Kiểm tra biến: MONGO_URI / MONGODB_URI / DB_URI')
    process.exit(1)
  }

  console.log('🔍 Kết nối tới:', MONGO_URI.replace(/\/\/[^@]+@/, '//***:***@'))

  try {
    await mongoose.connect(MONGO_URI)
    const admin = mongoose.connection.db.admin()

    // Check replica set
    let replInfo = null
    try {
      replInfo = await admin.command({ replSetGetStatus: 1 })
    } catch (e) {
      // standalone sẽ throw "not running with --replSet"
    }

    // Check server info
    const serverInfo = await admin.serverInfo()
    const buildInfo = await admin.command({ buildInfo: 1 })

    console.log('\n══════════════════════════════════════════')
    console.log('📊 MongoDB Setup Report')
    console.log('══════════════════════════════════════════')
    console.log(`Version:        ${serverInfo.version}`)
    console.log(`Storage engine: ${buildInfo.storageEngines?.join(', ') ?? 'n/a'}`)
    console.log(`Replica set:    ${replInfo ? `✅ YES (${replInfo.set})` : '❌ NO (standalone)'}`)

    if (replInfo) {
      console.log(`Set name:       ${replInfo.set}`)
      console.log(`Members:        ${replInfo.members?.length ?? 0}`)
      console.log(`\n✅ TRANSACTION SUPPORTED — có thể dùng session.withTransaction()`)
    } else {
      console.log(`\n⚠️  TRANSACTION NOT SUPPORTED`)
      console.log(`   Bạn có 2 lựa chọn:`)
      console.log(`   1. Convert sang replica set (1 node cũng OK):`)
      console.log(`      mongod --replSet rs0 --dbpath /data/db`)
      console.log(`      rồi vào mongosh chạy: rs.initiate()`)
      console.log(`   2. Hoặc dùng compensating actions (rollback thủ công khi fail)`)
    }

    // Check connection string có /?replicaSet không
    const hasReplicaSetParam = /[?&]replicaSet=/.test(MONGO_URI)
    if (hasReplicaSetParam) {
      console.log(`\n📝 Connection string có "?replicaSet=..." → driver nhận biết RS`)
    }

    // Check existing duplicate data (chuẩn bị cho migration)
    console.log('\n══════════════════════════════════════════')
    console.log('🔍 Data sanity check')
    console.log('══════════════════════════════════════════')

    const Invoice = mongoose.connection.collection('invoices')
    const dupInvoices = await Invoice.aggregate([
      { $match: { bookingId: { $ne: null } } },
      { $group: { _id: '$bookingId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 5 },
    ]).toArray()
    console.log(`Duplicate invoices (cùng bookingId): ${dupInvoices.length > 0 ? `⚠️ ${dupInvoices.length}+ trường hợp` : '✅ Không có'}`)
    if (dupInvoices.length > 0) {
      console.log('   IDs:', dupInvoices.map(d => d._id.toString()).join(', '))
    }

    const Room = mongoose.connection.collection('rooms')
    const orphanRooms = await Room.aggregate([
      { $match: { currentBookingId: { $ne: null } } },
      { $lookup: {
          from: 'bookings',
          localField: 'currentBookingId',
          foreignField: '_id',
          as: 'booking',
      }},
      { $match: {
          $or: [
            { booking: { $size: 0 } },
            { 'booking.status': { $in: ['cancelled', 'checked_out'] } },
          ],
      }},
      { $project: { number: 1, currentBookingId: 1, 'booking.status': 1 } },
      { $limit: 10 },
    ]).toArray()
    console.log(`Orphan Room.currentBookingId: ${orphanRooms.length > 0 ? `⚠️ ${orphanRooms.length}+ phòng` : '✅ Không có'}`)
    if (orphanRooms.length > 0) {
      console.log('   Rooms:', orphanRooms.map(r => `${r.number}(→${r.booking[0]?.status ?? 'NOT FOUND'})`).join(', '))
    }

    const Booking = mongoose.connection.collection('bookings')
    const cancelledWithRooms = await Booking.find({
      status: 'cancelled',
      rooms: { $exists: true, $ne: [] },
      'rooms.status': { $in: ['reserved', 'checked_in'] },
    }).limit(5).toArray()
    console.log(`Booking cancelled nhưng sub-room còn active: ${cancelledWithRooms.length > 0 ? `⚠️ ${cancelledWithRooms.length}+ booking` : '✅ Không có'}`)

    console.log('\n══════════════════════════════════════════')
    console.log('Hoàn tất kiểm tra')
    console.log('══════════════════════════════════════════')

    await mongoose.disconnect()
    process.exit(0)
  } catch (err) {
    console.error('❌ Lỗi:', err.message)
    process.exit(1)
  }
})()