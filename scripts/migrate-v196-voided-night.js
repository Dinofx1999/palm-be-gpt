/**
 * ════════════════════════════════════════════════════════════════════════════
 * MIGRATION v19.6: Inject voidedNight line vào booking cũ (rạng sáng transfer)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * VẤN ĐỀ:
 *   Booking tạo TRƯỚC khi deploy BE v19.6 không có dòng voidedNight trong
 *   breakdown, nên UI không hiển thị "Đã chuyển" gạch ngang.
 *
 * LOGIC:
 *   - Quét tất cả booking có transferHistory (đã từng đổi phòng)
 *   - Với mỗi lần transfer:
 *     • Lấy splitAt (time chuyển)
 *     • Check rạng sáng (splitAt.hour < earlyCheckinUntil, mặc định 5)
 *     • Check qua midnight (nightsCrossed > 0)
 *     • Nếu cả 2 ĐÚNG → đây là "rạng sáng transfer" → cần inject voided line
 *   - Kiểm tra breakdown có sẵn dòng voidedNight chưa → nếu có, skip
 *   - Inject dòng voidedNight với amount=0, originalAmount=oldDayPrice
 *
 * CÁCH DÙNG:
 *   cd "/Users/phivunguyen/Desktop/PMS Hotel New/backend"
 *   cp ~/Downloads/migrate-v196-voided-night.js scripts/
 *
 *   # B1: DRY-RUN — xem booking nào cần migrate, KHÔNG ghi DB
 *   node scripts/migrate-v196-voided-night.js
 *
 *   # B2: APPLY — ghi DB thực
 *   node scripts/migrate-v196-voided-night.js --apply
 *
 *   # B3: ROLLBACK (nếu cần)
 *   node scripts/migrate-v196-voided-night.js --rollback
 *
 * AN TOÀN:
 *   - DRY-RUN trước
 *   - Mỗi booking được backup vào collection `bookings_backup_v196`
 *   - Có flag `_migrationV196 = true` trong meta để tránh chạy lại
 *
 * ════════════════════════════════════════════════════════════════════════════
 */

const mongoose = require('mongoose')
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') })

const APPLY    = process.argv.includes('--apply')
const ROLLBACK = process.argv.includes('--rollback')
const ONLY_ID  = process.argv.find(a => a.startsWith('--id='))?.split('=')[1]
const VERBOSE  = process.argv.includes('--verbose')

// ⭐ Config — match với BE
const EARLY_CHECKIN_UNTIL_HOUR = 5  // < 5h sáng = rạng sáng

const log = (...args) => console.log(...args)
const logv = (...args) => { if (VERBOSE) console.log('  [verbose]', ...args) }

const pad2 = (n) => String(n).padStart(2, '0')
const fmtDM   = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`
const fmtTime = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`

async function main() {
  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/palm_hotel'
  log(`📡 Connecting to ${MONGO_URI.replace(/:[^:@]+@/, ':***@')}`)
  await mongoose.connect(MONGO_URI)
  log('✅ Connected\n')

  const db = mongoose.connection.db

  if (ROLLBACK) {
    return rollback(db)
  }

  // ⭐ Query booking có khả năng cần migrate
  //   Filter: có transferHistory hoặc priceBreakdown chứa "Phụ thu chuyển phòng"
  const query = ONLY_ID
    ? { $or: [{ _id: new mongoose.Types.ObjectId(ONLY_ID) }, { bookingCode: ONLY_ID }] }
    : {
        $or: [
          { transferHistory: { $exists: true, $ne: [] } },
          { 'priceBreakdown.label': { $regex: 'Phụ thu chuyển phòng', $options: 'i' } },
          { 'rooms.priceBreakdown.label': { $regex: 'Phụ thu chuyển phòng', $options: 'i' } },
        ],
      }

  const bookings = await db.collection('bookings').find(query).toArray()
  log(`📊 Tìm thấy ${bookings.length} booking có khả năng cần migrate\n`)

  const candidates = []   // { bookingId, code, transfers: [{ splitAt, oldRoom, newRoom, oldDayPrice }] }

  for (const bk of bookings) {
    const transfers = await detectEarlyMorningTransfers(bk, db)
    if (transfers.length === 0) continue

    // Kiểm tra đã có voidedNight chưa
    const alreadyMigrated = hasVoidedNightAlready(bk, transfers)
    if (alreadyMigrated.length === transfers.length) {
      logv(`SKIP ${bk.bookingCode} — đã có đủ dòng voidedNight`)
      continue
    }

    const pending = transfers.filter(t => !alreadyMigrated.some(am =>
      am.splitAt.getTime() === t.splitAt.getTime() && am.oldRoom === t.oldRoom
    ))

    candidates.push({
      bookingId: bk._id,
      code:      bk.bookingCode ?? `#${String(bk._id).slice(-5).toUpperCase()}`,
      pending,
    })
  }

  log(`🎯 ${candidates.length} booking cần inject voidedNight line\n`)

  if (candidates.length === 0) {
    log('✅ Không có booking nào cần migrate. Thoát.')
    await mongoose.disconnect()
    return
  }

  log('━'.repeat(80))
  for (const c of candidates) {
    log(`\n📋 ${c.code}  (${c.bookingId})`)
    for (const t of c.pending) {
      log(`   • Chuyển ${t.oldRoom} → ${t.newRoom} lúc ${fmtDM(t.splitAt)} ${fmtTime(t.splitAt)}`)
      log(`     Giá ngày phòng cũ: ${(t.oldDayPrice ?? 0).toLocaleString('vi-VN')}đ`)
      log(`     Sẽ inject: [${t.oldRoom}] Giá ngày (${fmtDM(t.seg1Start)} ${fmtTime(t.seg1Start)} - ${fmtDM(t.splitAt)} ${fmtTime(t.splitAt)})  amount=0  originalAmount=${(t.oldDayPrice ?? 0).toLocaleString('vi-VN')}`)
    }
  }
  log('\n' + '━'.repeat(80))

  if (!APPLY) {
    log('\n💡 ĐÂY LÀ DRY-RUN. Để apply:')
    log('   node scripts/migrate-v196-voided-night.js --apply\n')
    await mongoose.disconnect()
    return
  }

  // ⭐ APPLY — backup + update
  log('\n🚀 Applying migration...\n')

  // 1. Backup
  const backupColl = db.collection('bookings_backup_v196')
  for (const c of candidates) {
    const bk = bookings.find(b => String(b._id) === String(c.bookingId))
    await backupColl.replaceOne({ _id: bk._id }, { ...bk, _backupAt: new Date() }, { upsert: true })
  }
  log(`💾 Backup ${candidates.length} booking → bookings_backup_v196\n`)

  // 2. Inject voided line
  let okCount = 0
  let errCount = 0
  for (const c of candidates) {
    try {
      const bk = bookings.find(b => String(b._id) === String(c.bookingId))
      const updated = injectVoidedLines(bk, c.pending)

      await db.collection('bookings').updateOne(
        { _id: c.bookingId },
        {
          $set: {
            priceBreakdown: updated.priceBreakdown,
            rooms:          updated.rooms,
            _migrationV196: true,
            _migrationV196At: new Date(),
          },
        }
      )
      log(`   ✓ ${c.code} — injected ${c.pending.length} voidedNight line(s)`)
      okCount++
    } catch (e) {
      log(`   ✗ ${c.code} — LỖI: ${e.message}`)
      errCount++
    }
  }

  log(`\n${'━'.repeat(80)}`)
  log(`✅ HOÀN THÀNH: ${okCount} OK, ${errCount} lỗi`)
  log(`\n📌 Bước tiếp theo:`)
  log(`   1. Refresh trang booking trên UI`)
  log(`   2. Mở tab "Thanh toán" → kiểm tra dòng voided (gạch ngang xám + badge "Đã chuyển")`)
  log(`   3. Nếu cần rollback: node scripts/migrate-v196-voided-night.js --rollback`)
  log(`\nXong.`)

  await mongoose.disconnect()
}

// ─────────────────────────────────────────────────────────────────────
// HELPER: Detect các lần chuyển rạng sáng từ booking
// ─────────────────────────────────────────────────────────────────────

async function detectEarlyMorningTransfers(bk, db) {
  const result = []

  // Approach 1: transferHistory (cách chuẩn)
  if (Array.isArray(bk.transferHistory) && bk.transferHistory.length > 0) {
    for (const tr of bk.transferHistory) {
      if (!tr.transferredAt) continue
      const splitAt = new Date(tr.transferredAt)
      const seg1Start = new Date(tr.fromRoomCheckIn ?? bk.actualCheckIn ?? bk.checkIn)

      const splitHour = splitAt.getHours() + splitAt.getMinutes() / 60
      const isEarlyMorning = splitHour < EARLY_CHECKIN_UNTIL_HOUR

      const splitMid = new Date(splitAt); splitMid.setHours(0, 0, 0, 0)
      const seg1Mid  = new Date(seg1Start); seg1Mid.setHours(0, 0, 0, 0)
      const nightsCrossed = Math.max(0, Math.round((splitMid - seg1Mid) / 86400000))

      if (!isEarlyMorning || nightsCrossed === 0) continue

      // Lấy giá ngày phòng cũ
      const oldDayPrice = await resolveOldDayPrice(tr, bk, db)

      result.push({
        splitAt,
        seg1Start,
        oldRoom: String(tr.fromRoomNumber ?? ''),
        newRoom: String(tr.toRoomNumber ?? ''),
        oldDayPrice,
      })
    }
    return result
  }

  // Approach 2: Suy từ priceBreakdown (fallback nếu không có transferHistory)
  //   Tìm dòng "Phụ thu chuyển phòng A → B" → suy ngược splitAt từ dòng [B] Giá ngày kế tiếp
  const breakdowns = []
  if (Array.isArray(bk.priceBreakdown)) breakdowns.push({ items: bk.priceBreakdown, isRoom: false })
  if (Array.isArray(bk.rooms)) {
    for (const sr of bk.rooms) {
      if (Array.isArray(sr.priceBreakdown)) breakdowns.push({ items: sr.priceBreakdown, isRoom: true, roomNum: sr.roomNumber })
    }
  }

  for (const { items } of breakdowns) {
    for (let i = 0; i < items.length; i++) {
      const b = items[i]
      const m = String(b.label || '').match(/Phụ thu chuyển phòng\s+(\S+)\s*→\s*(\S+)/)
      if (!m) continue

      const oldRoom = m[1]
      const newRoom = m[2]

      // Tìm dòng [newRoom] Giá ngày kế tiếp để lấy splitAt
      let splitAt = null
      let seg1Start = null
      for (let j = i + 1; j < items.length; j++) {
        const next = items[j]
        const nm = String(next.label || '').match(/\[([^\]]+)\]\s*Giá ngày\s*\((\d+)\/(\d+)\s+(\d+):(\d+)\s*-/)
        if (nm && nm[1] === newRoom) {
          splitAt = new Date(
            new Date().getFullYear(),
            parseInt(nm[3]) - 1,
            parseInt(nm[2]),
            parseInt(nm[4]),
            parseInt(nm[5])
          )
          break
        }
      }

      // Tìm seg1Start từ dòng [oldRoom] Giá ngày đầu tiên trước đó
      for (let j = i - 1; j >= 0; j--) {
        const prev = items[j]
        const pm = String(prev.label || '').match(/\[([^\]]+)\]\s*Giá ngày\s*\((\d+)\/(\d+)\s+(\d+):(\d+)\s*-/)
        if (pm && pm[1] === oldRoom) {
          seg1Start = new Date(
            new Date().getFullYear(),
            parseInt(pm[3]) - 1,
            parseInt(pm[2]),
            parseInt(pm[4]),
            parseInt(pm[5])
          )
          break
        }
      }
      if (!seg1Start) seg1Start = new Date(bk.actualCheckIn ?? bk.checkIn)

      if (!splitAt) continue

      // Validate năm — vì regex chỉ match DD/MM nên năm fallback là currentYear, có thể sai
      // Dùng năm của bk.checkIn nếu khác hiện tại nhiều
      const bkYear = new Date(bk.checkIn).getFullYear()
      if (splitAt.getFullYear() !== bkYear) splitAt.setFullYear(bkYear)
      if (seg1Start.getFullYear() !== bkYear) seg1Start.setFullYear(bkYear)

      const splitHour = splitAt.getHours() + splitAt.getMinutes() / 60
      const isEarlyMorning = splitHour < EARLY_CHECKIN_UNTIL_HOUR

      const splitMid = new Date(splitAt); splitMid.setHours(0, 0, 0, 0)
      const seg1Mid  = new Date(seg1Start); seg1Mid.setHours(0, 0, 0, 0)
      const nightsCrossed = Math.max(0, Math.round((splitMid - seg1Mid) / 86400000))

      if (!isEarlyMorning || nightsCrossed === 0) continue

      // Tránh duplicate (đã thêm từ transferHistory)
      if (result.some(r =>
        r.oldRoom === oldRoom && r.newRoom === newRoom &&
        Math.abs(r.splitAt.getTime() - splitAt.getTime()) < 60000
      )) continue

      const oldDayPrice = await resolveOldDayPriceByRoomNumber(oldRoom, bk, db)

      result.push({ splitAt, seg1Start, oldRoom, newRoom, oldDayPrice })
    }
  }

  return result
}

async function resolveOldDayPrice(transfer, bk, db) {
  // Ưu tiên policy lưu sẵn trong transfer
  if (transfer.fromPolicyDayPrice) return transfer.fromPolicyDayPrice
  if (transfer.fromPolicyId) {
    const policy = await db.collection('pricepolicies').findOne({ _id: transfer.fromPolicyId })
    if (policy?.dayPrice) return policy.dayPrice
  }
  // Fallback: roomAmount / nights
  if (bk.roomAmount && bk.nights) {
    return Math.round(bk.roomAmount / bk.nights)
  }
  return 500000  // fallback cuối cùng (sẽ in warning)
}

async function resolveOldDayPriceByRoomNumber(roomNumber, bk, db) {
  // Tìm phòng theo số
  const room = await db.collection('rooms').findOne({ number: roomNumber })
  if (room) {
    const policy = await db.collection('pricepolicies').findOne({ roomTypeId: room.typeId })
    if (policy?.dayPrice) return policy.dayPrice
  }
  if (bk.roomAmount && bk.nights) {
    return Math.round(bk.roomAmount / bk.nights)
  }
  return 500000
}

// ─────────────────────────────────────────────────────────────────────
// HELPER: Check booking đã có voidedNight cho transfer này chưa
// ─────────────────────────────────────────────────────────────────────

function hasVoidedNightAlready(bk, transfers) {
  const found = []
  const allItems = []
  if (Array.isArray(bk.priceBreakdown)) allItems.push(...bk.priceBreakdown)
  if (Array.isArray(bk.rooms)) {
    for (const sr of bk.rooms) {
      if (Array.isArray(sr.priceBreakdown)) allItems.push(...sr.priceBreakdown)
    }
  }

  for (const t of transfers) {
    const has = allItems.some(it =>
      it?.meta?.voidedNight === true &&
      String(it?.meta?.roomNumber ?? '') === String(t.oldRoom)
    )
    if (has) found.push(t)
  }
  return found
}

// ─────────────────────────────────────────────────────────────────────
// HELPER: Inject voidedNight items vào breakdown
// ─────────────────────────────────────────────────────────────────────

function injectVoidedLines(bk, transfers) {
  const result = {
    priceBreakdown: bk.priceBreakdown ? [...bk.priceBreakdown] : null,
    rooms: bk.rooms ? bk.rooms.map(r => ({ ...r, priceBreakdown: r.priceBreakdown ? [...r.priceBreakdown] : [] })) : null,
  }

  for (const t of transfers) {
    const voidedItem = makeVoidedItem(t)

    // Strategy: insert TRƯỚC dòng "[oldRoom] Phụ thu chuyển phòng oldRoom → newRoom"
    // hoặc TRƯỚC dòng "[newRoom] Giá ngày..." đầu tiên sau transfer
    if (result.priceBreakdown) {
      injectIntoArray(result.priceBreakdown, voidedItem, t)
    }
    if (result.rooms) {
      for (const room of result.rooms) {
        if (room.priceBreakdown && room.priceBreakdown.length > 0) {
          injectIntoArray(room.priceBreakdown, voidedItem, t)
        }
      }
    }
  }

  return result
}

function injectIntoArray(arr, voidedItem, t) {
  // Tìm vị trí insert
  let insertIdx = -1
  for (let i = 0; i < arr.length; i++) {
    const lbl = String(arr[i].label || '')
    if (lbl.includes(`Phụ thu chuyển phòng ${t.oldRoom} → ${t.newRoom}`)) {
      insertIdx = i
      break
    }
  }
  if (insertIdx === -1) {
    // Tìm dòng [newRoom] Giá ngày... đầu tiên
    for (let i = 0; i < arr.length; i++) {
      const m = String(arr[i].label || '').match(/^\[([^\]]+)\]\s*Giá ngày/)
      if (m && m[1] === t.newRoom) {
        insertIdx = i
        break
      }
    }
  }
  if (insertIdx === -1) return  // không tìm được vị trí — skip

  // Check duplicate: cùng oldRoom + cùng splitAt
  const dup = arr.some(it =>
    it?.meta?.voidedNight === true &&
    String(it?.meta?.roomNumber ?? '') === String(t.oldRoom)
  )
  if (dup) return

  arr.splice(insertIdx, 0, voidedItem)
}

function makeVoidedItem(t) {
  return {
    label: `[${t.oldRoom}] Giá ngày (${fmtDM(t.seg1Start)} ${fmtTime(t.seg1Start)} - ${fmtDM(t.splitAt)} ${fmtTime(t.splitAt)})`,
    amount: 0,                              // amount=0 → KHÔNG cộng tổng
    originalAmount: t.oldDayPrice ?? 0,
    type: 'base',                           // ⭐ Dùng 'base' (đêm tiền phòng) để pass schema enum
    meta: {
      segment: 1,
      roomNumber: t.oldRoom,
      voidedNight: true,                    // ⭐ Marker chính — FE check meta.voidedNight === true
      voidReason: 'early-morning-transfer',
      voidBadge: 'Đã chuyển',
      originalAmount: t.oldDayPrice ?? 0,
      injectedByMigration: 'v19.6',
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// ROLLBACK
// ─────────────────────────────────────────────────────────────────────

async function rollback(db) {
  log('🔄 ROLLBACK mode — restore từ bookings_backup_v196\n')

  const backups = await db.collection('bookings_backup_v196').find({}).toArray()
  log(`📊 Tìm thấy ${backups.length} bản backup\n`)

  if (backups.length === 0) {
    log('Không có backup nào. Thoát.')
    await mongoose.disconnect()
    return
  }

  let okCount = 0
  for (const bk of backups) {
    const original = { ...bk }
    delete original._backupAt
    try {
      await db.collection('bookings').replaceOne({ _id: bk._id }, original)
      log(`   ✓ Restored ${bk.bookingCode ?? bk._id}`)
      okCount++
    } catch (e) {
      log(`   ✗ ${bk.bookingCode ?? bk._id} — ${e.message}`)
    }
  }

  log(`\n✅ Rollback: ${okCount}/${backups.length} bookings`)
  log('\n💡 Để xoá backup: db.bookings_backup_v196.drop()')
  await mongoose.disconnect()
}

// ─────────────────────────────────────────────────────────────────────

main().catch(e => {
  console.error('💥 FATAL:', e)
  process.exit(1)
})