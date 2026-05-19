/**
 * Script sync: booking.transferFee từ transferHistory[].fee
 *
 * Booking cũ (vd BK_JF242D) có transferFee = 0 dù trong transferHistory có fee.
 * → Bill thiếu phí chuyển phòng.
 *
 * Fix runtime (calculateBill) đã có fallback dùng historyFee, nhưng:
 *   - Các nơi khác đọc booking.transferFee trực tiếp (vd reports) vẫn sai
 *   - Tốt nhất sync 1 lần để data thống nhất
 *
 * Chạy:
 *   node scripts/sync-transfer-fee.js              # dry-run
 *   node scripts/sync-transfer-fee.js --apply      # ghi DB
 */

require('dotenv').config({ path: __dirname + '/../.env' })
const mongoose = require('mongoose')
const Booking = require('../src/models/Booking')

const APPLY = process.argv.includes('--apply')

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Sync booking.transferFee từ transferHistory')
  console.log(`  Mode: ${APPLY ? '🚨 APPLY' : '🔍 DRY-RUN'}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const mongoUri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.MONGO_URL ||
    process.env.DATABASE_URL ||
    'mongodb://localhost:27017/palm_pms'

  await mongoose.connect(mongoUri)
  console.log('✓ Connected\n')

  const bookings = await Booking.find({
    transferHistory: { $exists: true, $not: { $size: 0 } },
  })
  console.log(`Found ${bookings.length} booking có transferHistory\n`)

  let mismatched = 0
  let totalAddedFee = 0

  for (const bk of bookings) {
    const historyFee = (bk.transferHistory || [])
      .reduce((s, t) => s + (Number(t?.fee) || 0), 0)
    const currentFee = bk.transferFee || 0

    if (historyFee > currentFee) {
      mismatched++
      const diff = historyFee - currentFee
      totalAddedFee += diff
      console.log(`✓ ${bk.bookingCode}: transferFee ${currentFee} → ${historyFee} (+${diff.toLocaleString('vi-VN')}đ)`)

      if (APPLY) {
        const servicesAmount = bk.servicesAmount ?? 0
        const discount       = bk.discount       ?? 0
        const roomAmount     = bk.roomAmount     ?? 0
        const roomPart       = bk.isFreeRoom ? 0 : roomAmount
        bk.transferFee = historyFee
        bk.totalAmount = Math.max(0, roomPart + servicesAmount - discount + historyFee)
        await bk.save()
      }
    }
  }

  console.log('')
  console.log(`Tổng: ${mismatched} booking cần sync, tổng phí cộng thêm ${totalAddedFee.toLocaleString('vi-VN')}đ`)
  console.log(APPLY ? '✓ ĐÃ GHI DB' : '⚠ DRY-RUN — chưa ghi')
  await mongoose.disconnect()
}

main().catch(err => {
  console.error('✗ Error:', err)
  process.exit(1)
})