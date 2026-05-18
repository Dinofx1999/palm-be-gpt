/**
 * ════════════════════════════════════════════════════════════════════════════
 * AUDIT MIGRATION v19.6 — Dump tổng quan damage
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Mục đích:
 *   - List TẤT CẢ booking đã bị migration v19.6 v1 (cũ) sửa
 *   - Compare priceBreakdown TRƯỚC (backup) vs SAU (current)
 *   - Highlight: dòng nào injected, tổng amount thay đổi bao nhiêu
 *   - KHÔNG ghi DB — chỉ đọc
 *
 * Usage:
 *   node scripts/audit-migration-v196.js
 *   node scripts/audit-migration-v196.js --code=BK_HVPPGV   # 1 booking cụ thể
 *   node scripts/audit-migration-v196.js --csv > audit.csv  # xuất CSV
 * ════════════════════════════════════════════════════════════════════════════
 */

const mongoose = require('mongoose')
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') })

const CSV  = process.argv.includes('--csv')
const CODE = process.argv.find(a => a.startsWith('--code='))?.split('=')[1]

const BACKUP_COLLECTIONS = ['bookings_backup_v196', 'bookings_backup_v196_2']

async function main() {
  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/palm_hotel'
  await mongoose.connect(MONGO_URI)
  const db = mongoose.connection.db

  // Check backup collections nào tồn tại
  const collections = await db.listCollections().toArray()
  const existingBackups = BACKUP_COLLECTIONS.filter(c =>
    collections.some(coll => coll.name === c)
  )

  if (!CSV) {
    console.log('\n════════════════════════════════════════════════════════════════')
    console.log('🔍 AUDIT MIGRATION v19.6')
    console.log('════════════════════════════════════════════════════════════════')
    console.log(`Backup collections tồn tại: ${existingBackups.join(', ') || '(none)'}`)
  }

  if (existingBackups.length === 0) {
    console.log('\n⚠ Không tìm thấy backup collection nào — chưa có migration nào chạy.')
    await mongoose.disconnect()
    return
  }

  // Lấy tất cả booking từ backup
  const allBackups = []
  for (const collName of existingBackups) {
    let q = {}
    if (CODE) q = { bookingCode: CODE }
    const docs = await db.collection(collName).find(q).toArray()
    docs.forEach(d => allBackups.push({ ...d, _backupColl: collName }))
  }

  if (!CSV) console.log(`📊 Tổng booking có backup: ${allBackups.length}\n`)

  if (allBackups.length === 0) {
    console.log('Không có booking nào trong backup.')
    await mongoose.disconnect()
    return
  }

  // CSV header
  if (CSV) {
    console.log('bookingCode,backupColl,oldTotal,newTotal,diff,injectedCount,suspiciousLines')
  }

  const report = []

  for (const backup of allBackups) {
    const current = await db.collection('bookings').findOne({ _id: backup._id })
    if (!current) {
      report.push({ code: backup.bookingCode, status: '⚠ DELETED', backup, current: null })
      continue
    }

    // Compare priceBreakdown root
    const oldRoot = backup.priceBreakdown ?? []
    const newRoot = current.priceBreakdown ?? []

    const oldTotal = sumBreakdown(oldRoot)
    const newTotal = sumBreakdown(newRoot)

    // Tìm item NEW xuất hiện ở current mà KHÔNG có ở backup
    const injectedRoot = newRoot.filter(n => !oldRoot.some(o =>
      o.label === n.label && o.amount === n.amount
    ))

    // Tìm item SUSPICIOUS: có label match "Giá ngày" nhưng KHÔNG có meta.voidedNight
    // → khả năng là dòng giả do regex parse sai
    const suspicious = injectedRoot.filter(it => {
      const hasGiaNgay = String(it.label || '').match(/Giá ngày/)
      const isVoided = it?.meta?.voidedNight === true
      // Dòng injected hợp lệ phải có voidedNight=true
      // Bất cứ dòng nào injected mà KHÔNG voided → đáng nghi
      return hasGiaNgay && !isVoided
    })

    // Compare sub-rooms
    const subDiffs = []
    if (Array.isArray(current.rooms)) {
      for (let i = 0; i < current.rooms.length; i++) {
        const newSr = current.rooms[i]
        const oldSr = (backup.rooms ?? [])[i]
        if (!oldSr) continue
        const oldSub = oldSr.priceBreakdown ?? []
        const newSub = newSr.priceBreakdown ?? []
        const injected = newSub.filter(n => !oldSub.some(o =>
          o.label === n.label && o.amount === n.amount
        ))
        const susp = injected.filter(it => {
          const hasGiaNgay = String(it.label || '').match(/Giá ngày/)
          const isVoided = it?.meta?.voidedNight === true
          return hasGiaNgay && !isVoided
        })
        if (injected.length > 0 || susp.length > 0) {
          subDiffs.push({
            roomNumber: newSr.roomNumber,
            injected,
            suspicious: susp,
            oldTotal: sumBreakdown(oldSub),
            newTotal: sumBreakdown(newSub),
          })
        }
      }
    }

    const totalSuspicious = suspicious.length + subDiffs.reduce((s, x) => s + x.suspicious.length, 0)
    const totalInjected = injectedRoot.length + subDiffs.reduce((s, x) => s + x.injected.length, 0)

    if (totalInjected === 0 && totalSuspicious === 0) {
      // Backup nhưng không có thay đổi gì — chỉ là restore từ rollback xong
      report.push({ code: backup.bookingCode, status: '✓ unchanged', injectedTotal: 0, suspicious: 0, oldTotal, newTotal, backup, current, injectedRoot, subDiffs, suspicious_root: [] })
    } else {
      report.push({
        code: backup.bookingCode,
        status: totalSuspicious > 0 ? '⚠ SUSPICIOUS' : '✓ migrated',
        injectedTotal: totalInjected,
        suspicious: totalSuspicious,
        oldTotal,
        newTotal,
        backup,
        current,
        injectedRoot,
        subDiffs,
        suspicious_root: suspicious,
      })
    }

    if (CSV) {
      const allLabels = [...suspicious, ...subDiffs.flatMap(s => s.suspicious)]
        .map(it => it.label).join(' | ')
      console.log([
        backup.bookingCode || backup._id,
        backup._backupColl,
        oldTotal,
        newTotal,
        newTotal - oldTotal,
        totalInjected,
        `"${allLabels}"`,
      ].join(','))
    }
  }

  if (CSV) {
    await mongoose.disconnect()
    return
  }

  // ═══ NON-CSV REPORT ═══
  // Sort: SUSPICIOUS đầu tiên, sau là migrated, cuối là unchanged
  report.sort((a, b) => {
    const order = { '⚠ SUSPICIOUS': 0, '✓ migrated': 1, '✓ unchanged': 2, '⚠ DELETED': 3 }
    return (order[a.status] ?? 99) - (order[b.status] ?? 99)
  })

  const suspicious = report.filter(r => r.status === '⚠ SUSPICIOUS')
  const migrated = report.filter(r => r.status === '✓ migrated')
  const unchanged = report.filter(r => r.status === '✓ unchanged')

  console.log('━'.repeat(80))
  console.log(`📊 TỔNG QUAN:`)
  console.log(`   ⚠ SUSPICIOUS: ${suspicious.length}  ← KHẢ NĂNG BUG, cần rollback`)
  console.log(`   ✓ migrated:   ${migrated.length}  ← injected voidedNight đúng`)
  console.log(`   ✓ unchanged:  ${unchanged.length}  ← chỉ có backup, không thay đổi`)
  console.log('━'.repeat(80))

  if (suspicious.length > 0) {
    console.log(`\n${'═'.repeat(80)}`)
    console.log(`⚠ ${suspicious.length} BOOKING NGHI NGỜ BUG (có dòng "Giá ngày" injected nhưng KHÔNG voidedNight)`)
    console.log('═'.repeat(80))
    for (const r of suspicious) {
      console.log(`\n📋 ${r.code}  (diff: ${(r.newTotal - r.oldTotal).toLocaleString('vi-VN')}đ)`)
      console.log(`   Trước: ${r.oldTotal.toLocaleString('vi-VN')}đ  →  Sau: ${r.newTotal.toLocaleString('vi-VN')}đ`)

      if (r.suspicious_root.length > 0) {
        console.log(`   Root suspicious lines:`)
        for (const s of r.suspicious_root) {
          console.log(`     ✗ ${s.label}  ${(s.amount ?? 0).toLocaleString('vi-VN')}đ`)
        }
      }
      for (const sd of r.subDiffs) {
        if (sd.suspicious.length > 0) {
          console.log(`   Sub-room ${sd.roomNumber} suspicious:`)
          for (const s of sd.suspicious) {
            console.log(`     ✗ ${s.label}  ${(s.amount ?? 0).toLocaleString('vi-VN')}đ`)
          }
        }
      }
    }
  }

  if (migrated.length > 0) {
    console.log(`\n${'═'.repeat(80)}`)
    console.log(`✓ ${migrated.length} BOOKING ĐƯỢC INJECT VOIDED NIGHT (có vẻ ĐÚNG)`)
    console.log('═'.repeat(80))
    for (const r of migrated) {
      console.log(`\n📋 ${r.code}`)
      console.log(`   Trước: ${r.oldTotal.toLocaleString('vi-VN')}đ  →  Sau: ${r.newTotal.toLocaleString('vi-VN')}đ  (diff: ${(r.newTotal - r.oldTotal).toLocaleString('vi-VN')})`)
      const voidedItems = [...(r.injectedRoot || []), ...r.subDiffs.flatMap(s => s.injected)]
        .filter(it => it?.meta?.voidedNight === true)
      if (voidedItems.length > 0) {
        for (const v of voidedItems) {
          console.log(`   ✓ ${v.label} (gốc ${(v.originalAmount ?? v.meta?.originalAmount ?? 0).toLocaleString('vi-VN')}đ)`)
        }
      }
    }
  }

  console.log(`\n${'━'.repeat(80)}`)
  console.log(`📌 NEXT STEPS:`)
  if (suspicious.length > 0) {
    console.log(`   1. ROLLBACK booking nghi ngờ:`)
    console.log(`      node scripts/migrate-v196-voided-night.js --rollback`)
    console.log(`      (Lưu ý: rollback toàn bộ — cả booking ✓ migrated cũng sẽ revert)`)
    console.log(`   2. Apply lại v2 script (an toàn hơn):`)
    console.log(`      node scripts/migrate-v196-voided-night-v2.js`)
  } else if (migrated.length > 0) {
    console.log(`   ✓ Migration v1 hoạt động đúng, không cần rollback`)
    console.log(`   Có thể cleanup backup: db.bookings_backup_v196.drop()`)
  } else {
    console.log(`   Tất cả booking unchanged — có thể đã rollback rồi.`)
  }
  console.log()

  await mongoose.disconnect()
}

function sumBreakdown(arr) {
  if (!Array.isArray(arr)) return 0
  return arr.reduce((s, it) => s + (Number(it.amount) || 0), 0)
}

main().catch(e => { console.error('💥', e); process.exit(1) })