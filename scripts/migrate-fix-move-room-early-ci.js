/**
 * Migration script: Re-fix priceBreakdown cho booking đã move-room
 * v20.2 — 19/05/2026 — THAY THẾ v20.1 (có bug)
 *
 * ════════════════════════════════════════════════════════════════════════════
 * BUG CỦA v20.1 (migrate-fix-move-room-early-ci.js):
 *   1. `standardCI = new Date(plannedCheckIn).setHours(14, 0)` — DÙNG NGÀY CỦA
 *      plannedCheckIn nhưng giờ 14:00. Nếu plannedCheckIn = NGÀY KẾ của actualCheckIn
 *      (vd booking 1 đêm), standardCI sẽ là 14:00 NGÀY MAI thay vì 14:00 hôm nhận
 *      → earlyMin sai từ vài giờ thành 18h+.
 *   2. Không kiểm tra "early-checkin night" (CI rạng sáng ≤ 5h → đã 1 đêm trọn).
 *   3. `hourPrice = hourSlots[0].price` lấy slot ĐẦU bất kỳ, không khớp pickSlot.
 *   4. Chiến lược `Math.ceil(effectiveHr) × hourPrice` không khớp pickSlot
 *      (pickSlot chọn slot có time ≤ hours, không nhân giờ × giá).
 *
 * v20.2 SỬA BẰNG CÁCH:
 *   Không tự cài đặt logic. Dùng thẳng `calculatePrice()` của priceCalculator
 *   với checkIn=actualCheckIn, checkOut=transferAt, policy=oldPolicy.
 *   Surcharge "Nhận phòng sớm" trong kết quả là KHỚP với runtime.
 *
 *   Trước khi inject:
 *     - Nếu booking đã có "Nhận phòng sớm" do v20.1 chèn (meta.migrationFix='v20.1'),
 *       XÓA đi trước.
 *     - Nếu calculatePrice không trả surcharge → KHÔNG inject (chuẩn rồi).
 *
 * CÁCH CHẠY:
 *   node scripts/migrate-fix-move-room-early-ci-v20.2.js [--dry-run] [--bookingCode=BK_XXX]
 * ════════════════════════════════════════════════════════════════════════════
 */

require('dotenv').config({ path: __dirname + '/../.env' })
const mongoose = require('mongoose')

const Booking     = require('../src/models/Booking')
const Branch      = require('../src/models/Branch')
const PricePolicy = require('../src/models/PricePolicy')
const Room        = require('../src/models/Room')
const { calculatePrice } = require('../src/utils/priceCalculator')

const dryRun = process.argv.includes('--dry-run')
const filterCode = process.argv.find(a => a.startsWith('--bookingCode='))?.split('=')[1]
const verbose = process.argv.includes('--verbose')

const isEarlyCheckinSurcharge = (item) => {
  if (!item || item.type !== 'surcharge') return false
  const lbl = String(item.label || '')
  return lbl.includes('Nhận phòng sớm') || lbl.includes('early_checkin')
}

const isV201Stale = (item) => item?.meta?.migrationFix === 'v20.1'

async function fixBooking(booking, opts = {}) {
  if (!booking.transferHistory || booking.transferHistory.length === 0) {
    return { skipped: true, reason: 'no_transfer' }
  }
  if (!booking.actualCheckIn) {
    return { skipped: true, reason: 'no_actualCheckIn' }
  }

  const branch = await Branch.findById(booking.branchId)
  if (!branch) return { skipped: true, reason: 'no_branch' }

  // Lấy phòng đầu tiên (oldest room — trước khi move)
  const firstTransfer = booking.transferHistory[0]
  const oldRoomNumber = firstTransfer.fromRoomNumber

  // Tìm policy gốc của phòng cũ
  let oldPolicy = null
  if (firstTransfer.oldPolicyId) {
    oldPolicy = await PricePolicy.findById(firstTransfer.oldPolicyId)
  }
  if (!oldPolicy && booking.policySnapshot && booking.policySnapshot.dayPrice) {
    oldPolicy = booking.policySnapshot.toObject
      ? booking.policySnapshot.toObject()
      : booking.policySnapshot
  }
  if (!oldPolicy) {
    return { skipped: true, reason: 'no_old_policy' }
  }

  // Tìm Room cũ để lấy maxAdults/maxChildren/maxOccupancy
  let oldRoomDoc = null
  try {
    oldRoomDoc = await Room.findOne({
      number: oldRoomNumber,
      branchId: booking.branchId,
    }).populate('typeId')
  } catch {}
  const maxAdults    = oldRoomDoc?.typeId?.maxAdults    ?? oldRoomDoc?.typeId?.capacity ?? 2
  const maxChildren  = oldRoomDoc?.typeId?.maxChildren  ?? 0
  const maxOccupancy = oldRoomDoc?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)

  // ⭐ Gọi calculatePrice với policy CŨ + actualCheckIn → transferAt để xem
  //   có sinh "Nhận phòng sớm" hợp lệ không.
  const transferAt = new Date(firstTransfer.transferAt)
  const result = calculatePrice({
    checkIn:   booking.actualCheckIn,
    checkOut:  transferAt,
    priceType: booking.priceType || 'day',
    policy:    oldPolicy,
    branch,
    adults:    booking.adults    || 2,
    children:  booking.children  || 0,
    maxAdults, maxChildren, maxOccupancy,
  })

  // Lấy surcharge "Nhận phòng sớm" từ kết quả (nếu có)
  const validEarlyCI = (result?.breakdown || []).find(b => isEarlyCheckinSurcharge(b))

  // Lấy state hiện tại của priceBreakdown
  const breakdown = Array.isArray(booking.priceBreakdown)
    ? booking.priceBreakdown.map(b => (b.toObject ? b.toObject() : b))
    : []

  // Phân loại các item early CI hiện có
  const existingEarlyCI    = breakdown.filter(b => isEarlyCheckinSurcharge(b))
  const v201StaleEarlyCI   = existingEarlyCI.filter(b => isV201Stale(b))
  const otherEarlyCI       = existingEarlyCI.filter(b => !isV201Stale(b))

  // Xây breakdown mới = breakdown cũ - v201Stale (giữ "Nhận phòng sớm" hợp lệ khác nếu có)
  let newBreakdown = breakdown.filter(b => !(isEarlyCheckinSurcharge(b) && isV201Stale(b)))

  let addedItem = null
  const needsInject = validEarlyCI && otherEarlyCI.length === 0
  if (needsInject) {
    // Inject "Nhận phòng sớm" hợp lệ từ calculatePrice — kèm prefix [oldRoom]
    addedItem = {
      label:  `[${oldRoomNumber}] ${validEarlyCI.label}`,
      amount: validEarlyCI.amount,
      type:   'surcharge',
      meta:   { roomNumber: oldRoomNumber, preserved: true, migrationFix: 'v20.2' },
    }

    // Inject sau item base đầu tiên của oldRoomNumber
    let insertAt = -1
    for (let i = 0; i < newBreakdown.length; i++) {
      const it = newBreakdown[i]
      const itRoomNum = it?.meta?.roomNumber
      const lbl = String(it?.label || '')
      const matchByMeta  = it?.type === 'base' && String(itRoomNum) === String(oldRoomNumber)
      const matchByLabel = it?.type === 'base' && lbl.includes(`[${oldRoomNumber}]`)
      if (matchByMeta || matchByLabel) {
        insertAt = i + 1
        break
      }
    }
    if (insertAt < 0) insertAt = 1  // sau base item đầu tiên (mặc định)
    newBreakdown.splice(insertAt, 0, addedItem)
  }

  // Nếu không thay đổi gì → skip
  if (v201StaleEarlyCI.length === 0 && !addedItem) {
    return { skipped: true, reason: 'no_change_needed' }
  }

  // Recompute roomAmount + totalAmount
  const newRoomAmount = newBreakdown
    .filter(b => !(b.meta && b.meta.transferFee))
    .reduce((s, b) => s + (Number(b.amount) || 0), 0)

  const servicesAmount = booking.servicesAmount ?? 0
  const discount       = booking.discount       ?? 0
  const transferFee    = booking.transferFee    ?? 0
  const roomPart       = booking.isFreeRoom ? 0 : newRoomAmount
  const newTotalAmount = Math.max(0, roomPart + servicesAmount - discount + transferFee)

  const issue = {
    bookingCode: booking.bookingCode,
    oldRoomNumber,
    removedV201:  v201StaleEarlyCI.map(b => ({ label: b.label, amount: b.amount })),
    removedTotal: v201StaleEarlyCI.reduce((s, b) => s + (Number(b.amount) || 0), 0),
    added:        addedItem ? { label: addedItem.label, amount: addedItem.amount } : null,
    oldRoomAmount:  booking.roomAmount,
    newRoomAmount,
    oldTotalAmount: booking.totalAmount,
    newTotalAmount,
  }

  if (!opts.dryRun) {
    // Backup priceBreakdown cũ (chỉ backup 1 lần đầu)
    if (!booking._priceBreakdownBackupV20Fix) {
      booking._priceBreakdownBackupV20Fix = booking.priceBreakdown
    }
    booking.priceBreakdown = newBreakdown
    booking.roomAmount     = newRoomAmount
    booking.totalAmount    = newTotalAmount
    booking._migrationV20_2At = new Date()
    booking.markModified('priceBreakdown')
    booking.markModified('_priceBreakdownBackupV20Fix')
    await booking.save()
  }

  return { fixed: true, issue }
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Migration v20.2: Re-fix "Nhận phòng sớm" sau bug v20.1')
  console.log(`  Mode:   ${dryRun ? '🔍 DRY-RUN (không ghi DB)' : '🚨 APPLY (sẽ ghi DB)'}`)
  if (filterCode) console.log(`  Filter: bookingCode=${filterCode}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')

  const mongoUri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.MONGO_URL ||
    process.env.DATABASE_URL ||
    process.env.DB_URI ||
    process.env.DB_URL ||
    'mongodb://localhost:27017/palm_pms'

  const maskedUri = mongoUri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@')
  console.log(`Connecting: ${maskedUri}`)
  await mongoose.connect(mongoUri)
  console.log('✓ Connected to MongoDB')
  console.log('')

  const query = { transferHistory: { $exists: true, $not: { $size: 0 } } }
  if (filterCode) query.bookingCode = filterCode

  const bookings = await Booking.find(query)
  console.log(`Found ${bookings.length} booking đã move-room`)
  console.log('')

  const stats = { fixed: 0, skipped: 0, errors: 0 }
  const reasons = {}
  let totalRefunded = 0
  let totalAdded    = 0

  for (const b of bookings) {
    try {
      const result = await fixBooking(b, { dryRun })
      if (result.fixed) {
        stats.fixed++
        const iss = result.issue
        const lines = []
        if (iss.removedV201.length > 0) {
          for (const r of iss.removedV201) {
            lines.push(`     ✗ Xóa: "${r.label}" — ${r.amount.toLocaleString('vi-VN')}đ`)
            totalRefunded += r.amount
          }
        }
        if (iss.added) {
          lines.push(`     + Thêm: "${iss.added.label}" — ${iss.added.amount.toLocaleString('vi-VN')}đ`)
          totalAdded += iss.added.amount
        }
        console.log(`✓ ${iss.bookingCode}`)
        for (const l of lines) console.log(l)
        console.log(`     roomAmount:  ${iss.oldRoomAmount.toLocaleString('vi-VN')}đ → ${iss.newRoomAmount.toLocaleString('vi-VN')}đ`)
        console.log(`     totalAmount: ${iss.oldTotalAmount.toLocaleString('vi-VN')}đ → ${iss.newTotalAmount.toLocaleString('vi-VN')}đ`)
        console.log('')
      } else {
        stats.skipped++
        reasons[result.reason] = (reasons[result.reason] || 0) + 1
        if (verbose) {
          console.log(`  · [${b.bookingCode}] skip — ${result.reason}`)
        }
      }
    } catch (e) {
      stats.errors++
      console.error(`✗ ${b.bookingCode}: ${e.message}`)
      if (verbose) console.error(e.stack)
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Summary')
  console.log(`    Fixed:           ${stats.fixed}`)
  console.log(`    Skipped:         ${stats.skipped}`)
  console.log(`    Reasons:`, reasons)
  console.log(`    Errors:          ${stats.errors}`)
  console.log(`    Tổng đã hoàn:    ${totalRefunded.toLocaleString('vi-VN')}đ (từ v20.1 stale)`)
  console.log(`    Tổng phụ thu hợp lệ: ${totalAdded.toLocaleString('vi-VN')}đ`)
  console.log(`    Trạng thái:      ${dryRun ? '⚠ DRY-RUN — chưa ghi' : '✓ ĐÃ GHI DB'}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  if (dryRun) {
    console.log('')
    console.log('⚠️  DRY RUN — không có thay đổi nào được ghi vào DB.')
    console.log('   Chạy lại không có --dry-run để apply.')
  }

  await mongoose.disconnect()
}

main().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})