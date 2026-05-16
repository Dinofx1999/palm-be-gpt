/**
 * Apply tạm log để debug calculateBill mode='now' cho booking đã transferred
 * 
 * Cách dùng:
 * 1. Copy file này vào backend/scripts/
 * 2. node scripts/patch-debug-calculate-bill.js
 * 3. Restart BE
 * 4. Mở booking BK_JF242D, xem console log của BE
 * 5. Gửi log đó cho em xem
 */

const fs = require('fs')
const path = require('path')

const filePath = path.resolve(__dirname, '..', 'src', 'controllers', 'bookingController.js')
let content = fs.readFileSync(filePath, 'utf-8')

// Insert debug log right after effectiveCheckOut definition
const marker = `    let effectiveCheckOut
    if (mode === 'now') {
      const refTime = atTime ? new Date(atTime) : new Date()
      effectiveCheckOut = refTime < effectiveCheckIn ? new Date(effectiveCheckIn.getTime() + 60000) : refTime
    } else {
      effectiveCheckOut = booking.checkOut
    }`

const replacement = `    let effectiveCheckOut
    if (mode === 'now') {
      const refTime = atTime ? new Date(atTime) : new Date()
      effectiveCheckOut = refTime < effectiveCheckIn ? new Date(effectiveCheckIn.getTime() + 60000) : refTime
    } else {
      effectiveCheckOut = booking.checkOut
    }

    // ⭐ DEBUG LOG (remove sau khi fix)
    console.log('[DEBUG calculateBill]', {
      bookingCode:        booking.bookingCode,
      mode,
      atTime,
      effectiveCheckIn:   effectiveCheckIn?.toISOString?.(),
      effectiveCheckOut:  effectiveCheckOut?.toISOString?.(),
      bookingCheckOut:    booking.checkOut?.toISOString?.(),
      hasTransferred:     (booking.transferHistory ?? []).length > 0,
      lastTransferAt:     booking.transferHistory?.length > 0
        ? booking.transferHistory[booking.transferHistory.length - 1].transferAt?.toISOString?.()
        : null,
      breakdownCount:     (booking.priceBreakdown ?? []).length,
      hasSegments:        (booking.priceBreakdown ?? []).some(b => b.meta?.segment != null),
    })`

if (!content.includes(marker)) {
  console.error('❌ Không tìm thấy marker trong file. File có thể không đúng phiên bản.')
  process.exit(1)
}

if (content.includes('DEBUG calculateBill')) {
  console.log('ℹ️  File đã có DEBUG log, không cần patch lại.')
  process.exit(0)
}

content = content.replace(marker, replacement)
fs.writeFileSync(filePath, content)
console.log('✓ Đã thêm DEBUG log vào calculateBill')
console.log('Bây giờ:')
console.log('  1. Restart BE (killall -9 node && cd backend && npm run dev)')
console.log('  2. Mở booking BK_JF242D, xem console của BE')
console.log('  3. Copy log "[DEBUG calculateBill]" gửi cho em')