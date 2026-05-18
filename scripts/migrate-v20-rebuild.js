/**
 * ════════════════════════════════════════════════════════════════════════════
 * MIGRATION v20.0 — Rebuild priceBreakdown cho booking có transferHistory
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Logic:
 *   1. Tìm booking có transferHistory
 *   2. Replay transfer cuối cùng: dùng computeMoveRoomBreakdown để tạo breakdown đúng
 *   3. Cập nhật priceBreakdown + roomAmount + totalAmount
 *   4. Backup vào bookings_backup_v20
 *
 * CHẠY SAU rollback-v196-all.js
 *
 * Usage:
 *   node scripts/migrate-v20-rebuild.js                   # dry-run all
 *   node scripts/migrate-v20-rebuild.js --code=BK_XXXXXX  # 1 booking
 *   node scripts/migrate-v20-rebuild.js --apply           # apply all
 *   node scripts/migrate-v20-rebuild.js --rollback        # rollback
 * ════════════════════════════════════════════════════════════════════════════
 */

const mongoose = require('mongoose')
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') })

const { computeMoveRoomBreakdown } = require(path.resolve(__dirname, '..', 'src', 'utils', 'moveRoomBreakdown'))

const APPLY = process.argv.includes('--apply')
const ROLLBACK = process.argv.includes('--rollback')
const CODE = process.argv.find(a => a.startsWith('--code='))?.split('=')[1]

const BACKUP_COLL = 'bookings_backup_v20'

const pad = (n) => String(n).padStart(2, '0')
const fmtMoney = (n) => (n ?? 0).toLocaleString('vi-VN')

async function main() {
  const URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/palm_hotel'
  await mongoose.connect(URI)
  console.log('Connected.\n')
  const db = mongoose.connection.db

  if (ROLLBACK) return rollback(db)

  const query = CODE
    ? { bookingCode: CODE }
    : { transferHistory: { $exists: true, $not: { $size: 0 } } }

  const bookings = await db.collection('bookings').find(query).toArray()
  console.log(`📊 ${bookings.length} booking có transferHistory\n`)

  const candidates = []

  for (const bk of bookings) {
    // Lấy lần transfer cuối cùng (mới nhất)
    const transfers = (bk.transferHistory || [])
      .filter(t => t.transferAt && t.fromRoomNumber && t.toRoomNumber)
      .sort((a, b) => new Date(a.transferAt) - new Date(b.transferAt))

    if (transfers.length === 0) continue
    const lastTransfer = transfers[transfers.length - 1]

    // Resolve policies
    const oldPolicy = await resolvePolicy(db, lastTransfer.oldPolicyId, lastTransfer.fromRoomNumber, bk.branchId, bk)
    const newPolicy = await resolvePolicy(db, lastTransfer.newPolicyId, lastTransfer.toRoomNumber, bk.branchId, bk)

    if (!oldPolicy || !newPolicy) {
      console.log(`⊘ ${bk.bookingCode}: thiếu policy, skip`)
      continue
    }

    // Resolve room types
    const oldRoomType = await resolveRoomType(db, lastTransfer.fromRoomNumber, bk.branchId)
    const newRoomType = await resolveRoomType(db, lastTransfer.toRoomNumber, bk.branchId)

    // Tính breakdown mới
    let newItems = []
    try {
      newItems = computeMoveRoomBreakdown({
        actualCheckIn:   new Date(bk.actualCheckIn || bk.checkIn),
        plannedCheckOut: new Date(bk.checkOut),
        transferAt:      new Date(lastTransfer.transferAt),
        oldRoom: {
          number: lastTransfer.fromRoomNumber,
          type:   oldRoomType,
          policy: oldPolicy,
        },
        newRoom: {
          number: lastTransfer.toRoomNumber,
          type:   newRoomType,
          policy: newPolicy,
        },
        transferFee: 0,  // fee tách riêng ở booking.transferFee
        changeRate:  oldRoomType !== newRoomType,
        isFreeRoom:  !!bk.isFreeRoom,
      })
    } catch (e) {
      console.log(`⊘ ${bk.bookingCode}: compute error: ${e.message}`)
      continue
    }

    // Loại bỏ fee item, BE handle riêng
    const breakdownItems = newItems
      .filter(it => !(it.meta && it.meta.transferFee))
      .map(it => ({
        label: it.label,
        amount: it.amount,
        type: it.type === 'surcharge' ? 'surcharge' : 'base',
        meta: it.meta || {},
      }))

    const newRoomAmount = breakdownItems.reduce((s, b) => s + (b.amount || 0), 0)
    const oldRoomAmount = bk.roomAmount || 0
    const diff = newRoomAmount - oldRoomAmount

    candidates.push({
      bookingId: bk._id,
      code:      bk.bookingCode || String(bk._id).slice(-6),
      bk,
      oldRoomAmount,
      newRoomAmount,
      diff,
      breakdownItems,
      lastTransfer,
    })
  }

  console.log(`🎯 ${candidates.length} booking cần rebuild\n`)
  console.log('━'.repeat(70))
  for (const c of candidates) {
    const arrow = c.diff === 0 ? '=' : (c.diff > 0 ? `+${fmtMoney(c.diff)}` : fmtMoney(c.diff))
    console.log(`📋 ${c.code}: ${fmtMoney(c.oldRoomAmount)} → ${fmtMoney(c.newRoomAmount)} (${arrow})`)
    for (let i = 0; i < c.breakdownItems.length; i++) {
      const it = c.breakdownItems[i]
      console.log(`   ${i+1}. ${it.label.padEnd(60)} ${fmtMoney(it.amount).padStart(12)}`)
    }
  }
  console.log('━'.repeat(70))

  if (!APPLY) {
    console.log(`\n💡 DRY-RUN. Để apply:`)
    console.log(`   node scripts/migrate-v20-rebuild.js --apply\n`)
    await mongoose.disconnect()
    return
  }

  console.log('\n🚀 Applying...\n')

  // Backup
  const backupColl = db.collection(BACKUP_COLL)
  for (const c of candidates) {
    await backupColl.replaceOne(
      { _id: c.bookingId },
      { ...c.bk, _backupAt: new Date() },
      { upsert: true }
    )
  }
  console.log(`💾 Backup ${candidates.length} → ${BACKUP_COLL}`)

  // Apply
  let ok = 0
  let fail = 0
  for (const c of candidates) {
    try {
      // Tính discount + totalAmount
      const servicesAmount = c.bk.servicesAmount || 0
      const transferFee = c.bk.transferFee || 0
      let discount = c.bk.discount || 0
      if ((c.bk.discountPercent || 0) > 0 || (c.bk.discountAmount || 0) > 0 || c.bk.isFreeRoom) {
        const roomPart = c.bk.isFreeRoom ? 0 : c.newRoomAmount
        const sub = roomPart + servicesAmount
        const pctDisc = Math.round(sub * (c.bk.discountPercent || 0) / 100)
        discount = pctDisc + (c.bk.discountAmount || 0)
      }
      const subtotal = c.newRoomAmount + servicesAmount
      const totalAmount = Math.max(0, subtotal - discount + transferFee)

      await db.collection('bookings').updateOne(
        { _id: c.bookingId },
        {
          $set: {
            priceBreakdown: c.breakdownItems,
            roomAmount: c.newRoomAmount,
            discount,
            totalAmount,
            _migrationV20: true,
            _migrationV20At: new Date(),
          },
        }
      )

      // Sync invoice
      const invoice = await db.collection('invoices').findOne({ bookingId: c.bookingId })
      if (invoice) {
        const paid = invoice.paidAmount || 0
        const remaining = Math.max(0, totalAmount - paid)
        await db.collection('invoices').updateOne(
          { _id: invoice._id },
          {
            $set: {
              roomAmount: c.newRoomAmount,
              discount,
              totalAmount,
              remainingAmount: remaining,
              paymentStatus: paid >= totalAmount ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
            },
          }
        )
      }

      console.log(`   ✓ ${c.code}`)
      ok++
    } catch (e) {
      console.log(`   ✗ ${c.code}: ${e.message}`)
      fail++
    }
  }

  console.log(`\n${'━'.repeat(70)}`)
  console.log(`✅ DONE: ${ok} OK, ${fail} fail`)
  console.log(`Rollback: node scripts/migrate-v20-rebuild.js --rollback\n`)

  await mongoose.disconnect()
}

async function resolvePolicy(db, policyId, roomNumber, branchId, bk) {
  // Ưu tiên policyId trong transferHistory
  if (policyId) {
    const p = await db.collection('pricepolicies').findOne({ _id: typeof policyId === 'string' ? new mongoose.Types.ObjectId(policyId) : policyId })
    if (p && p.dayPrice) return formatPolicy(p)
  }

  // Tìm theo room number trong branch
  const room = await db.collection('rooms').findOne({ number: roomNumber, branchId })
  if (room) {
    const p = await db.collection('pricepolicies').findOne({ roomTypeId: room.typeId, branchId })
    if (p && p.dayPrice) return formatPolicy(p)
  }

  // Fallback: dùng policySnapshot của booking
  if (bk.policySnapshot && bk.policySnapshot.dayPrice) {
    return formatPolicy(bk.policySnapshot)
  }

  return null
}

function formatPolicy(p) {
  const slots = (p.hourSlots || p.dayEarlyCheckIn || [])
    .map(s => {
      const time = s.time || s.duration || ''
      const m = String(time).match(/(\d+)/)
      return {
        durationHours: m ? parseInt(m[1]) : 2,
        price: s.price || 0,
      }
    })
  return {
    dayPrice: p.dayPrice || 0,
    hourSlots: slots,
  }
}

async function resolveRoomType(db, roomNumber, branchId) {
  const room = await db.collection('rooms').findOne({ number: roomNumber, branchId })
  if (!room) return ''
  if (room.typeName) return room.typeName
  if (room.typeId) {
    const type = await db.collection('roomtypes').findOne({ _id: room.typeId })
    if (type) return type.name || ''
  }
  return ''
}

async function rollback(db) {
  console.log(`🔄 ROLLBACK ${BACKUP_COLL}\n`)
  const backups = await db.collection(BACKUP_COLL).find({}).toArray()
  console.log(`${backups.length} backups\n`)

  let ok = 0
  for (const bk of backups) {
    const original = { ...bk }
    delete original._backupAt
    try {
      if (APPLY) await db.collection('bookings').replaceOne({ _id: bk._id }, original)
      console.log(`   ${APPLY ? '✓' : '[dry]'} ${bk.bookingCode || bk._id}`)
      ok++
    } catch (e) {
      console.log(`   ✗ ${e.message}`)
    }
  }
  console.log(`\n${ok}/${backups.length} restored`)
  if (!APPLY) console.log('\nĐể apply rollback: thêm --apply')
  await mongoose.disconnect()
}

main().catch(e => { console.error('💥', e); process.exit(1) })