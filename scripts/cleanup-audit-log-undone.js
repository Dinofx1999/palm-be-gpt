/**
 * Script cleanup: unset `metadata.undone` / `metadata.undoneAt` / `metadata.undoneBy`
 * khỏi AuditLog đã bị fix #6 (mark undone) dust lại trong DB.
 *
 * Bối cảnh: fix #6 (19/05/2026) mark log checkout cũ là undone khi user undo,
 * mục đích là không hiển thị "giờ checkout gần nhất" sai. Nhưng business logic
 * thật sự là CẦN giờ cũ làm gợi ý cho recheckout → fix #6 sai hướng và đã rollback.
 * Tuy nhiên data đã bị mark vẫn còn trong DB → cần dọn.
 *
 * Chạy:
 *   node scripts/cleanup-audit-log-undone.js              # dry-run
 *   node scripts/cleanup-audit-log-undone.js --apply      # ghi DB
 */

require('dotenv').config({ path: __dirname + '/../.env' })
const mongoose = require('mongoose')

const APPLY = process.argv.includes('--apply')

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Cleanup: unset metadata.undone trên AuditLog')
  console.log(`  Mode: ${APPLY ? '🚨 APPLY (sẽ ghi DB)' : '🔍 DRY-RUN'}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  const mongoUri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.MONGO_URL ||
    process.env.DATABASE_URL ||
    'mongodb://localhost:27017/palm_pms'

  await mongoose.connect(mongoUri)
  console.log('✓ Connected\n')

  const db = mongoose.connection.db
  const collections = await db.listCollections().toArray()
  const auditCollName = collections.find(c => /audit/i.test(c.name))?.name
  if (!auditCollName) {
    console.log('✗ Không tìm thấy collection audit')
    await mongoose.disconnect()
    return
  }
  console.log(`▸ Collection: ${auditCollName}`)

  const auditColl = db.collection(auditCollName)

  // Tìm log bị mark
  const count = await auditColl.countDocuments({
    'metadata.undone': true,
  })
  console.log(`▸ Số log bị mark undone: ${count}\n`)

  if (count === 0) {
    console.log('✓ Không có log nào cần dọn — DB sạch.')
    await mongoose.disconnect()
    return
  }

  // List vài log để xem
  const samples = await auditColl.find({ 'metadata.undone': true })
    .sort({ updatedAt: -1 })
    .limit(10)
    .toArray()
  console.log('▸ 10 log gần nhất bị mark:')
  for (const l of samples) {
    console.log(`  - ${String(l._id)} | action=${l.action} | entityId=${l.entityId} | undoneAt=${l.metadata?.undoneAt}`)
  }
  console.log('')

  if (!APPLY) {
    console.log('⚠ DRY-RUN — chưa ghi gì.')
    console.log('  Chạy lại với --apply để unset.')
    await mongoose.disconnect()
    return
  }

  // Apply
  const result = await auditColl.updateMany(
    { 'metadata.undone': true },
    {
      $unset: {
        'metadata.undone': '',
        'metadata.undoneAt': '',
        'metadata.undoneBy': '',
      },
    },
  )

  console.log(`✓ Đã unset undone cho ${result.modifiedCount} log.`)
  await mongoose.disconnect()
}

main().catch(err => {
  console.error('✗ Error:', err)
  process.exit(1)
})