/**
 * ════════════════════════════════════════════════════════════════════════════
 * PATCH BE v19.6.1: Fix schema enum validation cho voidedNight item
 * ════════════════════════════════════════════════════════════════════════════
 *
 * VẤN ĐỀ:
 *   BE v19.6 set `type: 'info'` cho voidedNight item, nhưng schema
 *   priceBreakdown.type CHỈ accept enum ['base', 'surcharge', 'discount', ...].
 *   → Booking validation failed khi save sau khi đổi phòng rạng sáng.
 *
 * FIX:
 *   Đổi `type: 'info'` → `type: 'base'` trong block voidedNight.
 *   Bản chất dòng này LÀ đêm tiền phòng (chỉ khác amount=0), nên 'base' đúng.
 *   FE vẫn nhận biết qua `meta.voidedNight === true` — không phụ thuộc vào type.
 *
 * CÁCH DÙNG:
 *   cd "/Users/phivunguyen/Desktop/PMS Hotel New/backend"
 *   cp ~/Downloads/patch-be-v196-fix-enum.js scripts/
 *
 *   # Dry-run
 *   node scripts/patch-be-v196-fix-enum.js
 *
 *   # Apply
 *   node scripts/patch-be-v196-fix-enum.js --apply
 *
 *   # Restart Node
 *   killall -9 node && cd backend && npm run dev
 *
 * ════════════════════════════════════════════════════════════════════════════
 */

const fs = require('fs')
const path = require('path')

const APPLY = process.argv.includes('--apply')

const filePath = path.resolve(__dirname, '..', 'src', 'controllers', 'bookingController.js')

if (!fs.existsSync(filePath)) {
  console.error(`❌ Không tìm thấy file: ${filePath}`)
  process.exit(1)
}

let content = fs.readFileSync(filePath, 'utf-8')
const before = content

// ⭐ Tìm block voidedNight và đổi type 'info' → 'base'
//   Pattern khá specific để tránh đụng vào chỗ khác
const OLD_BLOCK = `        items.push({
          label:  \`[\${oldRoomNumber}] Giá ngày (\${fmtDMVoid(seg1Start)} \${fmtTimeVoid(seg1Start)} - \${fmtDMVoid(seg1EndForVoid)} \${fmtTimeVoid(seg1EndForVoid)})\`,
          amount: 0,                          // ⭐ amount=0 để không cộng tổng
          originalAmount: oldDayPrice,        // ⭐ Lưu giá gốc để FE hiển thị gạch ngang
          type:   'info',`

const NEW_BLOCK = `        items.push({
          label:  \`[\${oldRoomNumber}] Giá ngày (\${fmtDMVoid(seg1Start)} \${fmtTimeVoid(seg1Start)} - \${fmtDMVoid(seg1EndForVoid)} \${fmtTimeVoid(seg1EndForVoid)})\`,
          amount: 0,                          // ⭐ amount=0 để không cộng tổng
          originalAmount: oldDayPrice,        // ⭐ Lưu giá gốc để FE hiển thị gạch ngang
          type:   'base',                     // ⭐ v19.6.1: dùng 'base' để pass schema enum (FE check meta.voidedNight)`

if (!content.includes(OLD_BLOCK)) {
  // Thử pattern lỏng hơn — chỉ tìm "type:   'info'" trong context voidedNight
  const looseMatch = content.match(/type:\s*'info'[\s\S]{0,200}voidedNight:\s*true/)
  if (looseMatch) {
    console.error(`⚠ Không match exact block (có thể format khác), nhưng tìm thấy pattern lỏng.`)
    console.error(`  Vị trí trong file: ~${content.indexOf(looseMatch[0])}`)
    console.error(`  Anh có thể tự sửa: tìm "type:   'info'" + "voidedNight: true" → đổi 'info' thành 'base'`)
    process.exit(1)
  }
  console.error(`❌ Không tìm thấy block voidedNight với type:'info'.`)
  console.error(`   Có thể file đã được sửa rồi. Verify bằng:`)
  console.error(`   grep -n "voidedNight" "${filePath}"`)
  process.exit(1)
}

content = content.replace(OLD_BLOCK, NEW_BLOCK)
const changes = content !== before

if (!changes) {
  console.error('❌ Replace không hoạt động — file không đổi.')
  process.exit(1)
}

console.log('✓ Đã match block voidedNight và chuẩn bị đổi type:\'info\' → type:\'base\'')

if (!APPLY) {
  console.log('\n💡 DRY-RUN. Để apply:')
  console.log('   node scripts/patch-be-v196-fix-enum.js --apply')
  console.log('\nSau khi apply nhớ:')
  console.log('   killall -9 node && cd backend && npm run dev')
} else {
  const backupPath = filePath + '.bak-v196-' + Date.now()
  fs.writeFileSync(backupPath, before)
  console.log('💾 Backup → ' + backupPath)
  fs.writeFileSync(filePath, content)
  console.log('✅ Đã apply patch v19.6.1')
  console.log('\nBước tiếp theo:')
  console.log('   killall -9 node && cd backend && npm run dev')
  console.log('   → Sau đó test lại booking đổi phòng rạng sáng')
}