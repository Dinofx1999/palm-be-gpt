/**
 * ════════════════════════════════════════════════════════════════════════════
 * ROLLBACK migration v19.6 v1/v2 cũ (CHẠY CÁI NÀY TRƯỚC)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Mục đích:
 *   - Khôi phục priceBreakdown từ backup_v196 và backup_v196_2
 *   - Xoá flag _migrationV196, _migrationV196_2 nếu còn sót
 *   - Xoá item nào có meta.voidedNight = true (đã bỏ logic này)
 *   - Xoá item nào có meta.injectedByMigration (do v1/v2 cũ inject sai)
 *
 * Usage:
 *   node scripts/rollback-v196-all.js              # dry-run
 *   node scripts/rollback-v196-all.js --apply      # apply
 * ════════════════════════════════════════════════════════════════════════════
 */

const mongoose = require('mongoose')
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') })

const APPLY = process.argv.includes('--apply')

async function main() {
  const URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/palm_hotel'
  await mongoose.connect(URI)
  const db = mongoose.connection.db
  console.log('Connected.\n')

  console.log('═'.repeat(70))
  console.log('🔄 ROLLBACK migration v19.6 (v1 + v2)')
  console.log('═'.repeat(70))

  const collections = await db.listCollections().toArray()
  const collNames = collections.map(c => c.name)

  // 1. Restore từ backup
  for (const backupName of ['bookings_backup_v196', 'bookings_backup_v196_2']) {
    if (!collNames.includes(backupName)) {
      console.log(`⊘ Không có ${backupName}`)
      continue
    }
    const backups = await db.collection(backupName).find({}).toArray()
    console.log(`\n📦 ${backupName}: ${backups.length} bản backup`)
    let restored = 0
    for (const bk of backups) {
      const original = { ...bk }
      delete original._backupAt
      try {
        if (APPLY) {
          await db.collection('bookings').replaceOne({ _id: bk._id }, original)
        }
        console.log(`   ${APPLY ? '✓' : '[dry]'} restore ${bk.bookingCode || bk._id}`)
        restored++
      } catch (e) {
        console.log(`   ✗ ${bk.bookingCode || bk._id}: ${e.message}`)
      }
    }
    console.log(`   → ${restored}/${backups.length} restored`)
  }

  // 2. Xoá flag + item rác trong booking
  console.log('\n📋 Cleanup các item rác (voidedNight, injectedByMigration):')
  const dirty = await db.collection('bookings').find({
    $or: [
      { _migrationV196: { $exists: true } },
      { _migrationV196_2: { $exists: true } },
      { 'priceBreakdown.meta.voidedNight': true },
      { 'priceBreakdown.meta.injectedByMigration': { $exists: true } },
      { 'rooms.priceBreakdown.meta.voidedNight': true },
      { 'rooms.priceBreakdown.meta.injectedByMigration': { $exists: true } },
    ],
  }).toArray()

  console.log(`   Tìm thấy ${dirty.length} booking có item rác`)
  let cleaned = 0
  for (const bk of dirty) {
    let modified = false

    const cleanBreakdown = (arr) => {
      if (!Array.isArray(arr)) return arr
      const filtered = arr.filter(it => {
        const isVoided = it && it.meta && it.meta.voidedNight === true
        const isInjected = it && it.meta && it.meta.injectedByMigration
        return !isVoided && !isInjected
      })
      if (filtered.length !== arr.length) modified = true
      return filtered
    }

    const newRoot = cleanBreakdown(bk.priceBreakdown || [])
    const newRooms = (bk.rooms || []).map(r => ({
      ...r,
      priceBreakdown: cleanBreakdown(r.priceBreakdown || []),
    }))

    if (modified || bk._migrationV196 || bk._migrationV196_2) {
      if (APPLY) {
        await db.collection('bookings').updateOne(
          { _id: bk._id },
          {
            $set: { priceBreakdown: newRoot, rooms: newRooms },
            $unset: { _migrationV196: '', _migrationV196_2: '', _migrationV196At: '', _migrationV196_2At: '' },
          }
        )
      }
      console.log(`   ${APPLY ? '✓' : '[dry]'} ${bk.bookingCode || bk._id}`)
      cleaned++
    }
  }
  console.log(`   → ${cleaned} booking đã cleanup`)

  console.log('\n' + '═'.repeat(70))
  if (!APPLY) {
    console.log('💡 DRY-RUN. Để apply:')
    console.log('   node scripts/rollback-v196-all.js --apply\n')
  } else {
    console.log('✅ Rollback xong.')
    console.log('💡 Nếu chắc chắn không cần backup nữa, xoá:')
    console.log('   mongo: db.bookings_backup_v196.drop()')
    console.log('   mongo: db.bookings_backup_v196_2.drop()')
  }
  console.log()

  await mongoose.disconnect()
}

main().catch(e => { console.error('💥', e); process.exit(1) })
