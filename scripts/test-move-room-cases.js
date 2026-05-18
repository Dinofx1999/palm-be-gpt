/**
 * ════════════════════════════════════════════════════════════════════════════
 * MOVE-ROOM TEST CASES v2 — Sau khi anh confirm Q1 + Q2
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Thay đổi vs v1:
 * - Q1: KHÔNG inject dòng "Điều chỉnh -100K". Thay bằng cách switch policy
 *       sang loại mới → recalculate giá ngày trực tiếp theo policy mới.
 * - Q2: isFreeRoom = miễn phí toàn bộ hiển thị tiền phòng, CHỈ hiện phí chuyển.
 *
 * Anh chạy: node test-move-room-cases-v2.js
 * Verify từng case, sau đó em code.
 * ════════════════════════════════════════════════════════════════════════════
 */

const pad = (n) => String(n).padStart(2, '0')
const fmtMoney = (n) => (n ?? 0).toLocaleString('vi-VN')

function runCase(testCase) {
  console.log('═'.repeat(82))
  console.log(`📋 ${testCase.name}`)
  console.log('─'.repeat(82))
  console.log('INPUT:')
  for (const [k, v] of Object.entries(testCase.input)) {
    console.log(`  ${k.padEnd(22)} ${v}`)
  }
  console.log('\nEXPECTED BREAKDOWN:')
  let total = 0
  for (let i = 0; i < testCase.expected.length; i++) {
    const e = testCase.expected[i]
    console.log(`  ${(i + 1).toString().padStart(2)}. ${e.label.padEnd(60)} ${fmtMoney(e.amount).padStart(10)}`)
    total += e.amount
    if (e.note) console.log(`      └─ ${e.note}`)
  }
  console.log('  ' + '─'.repeat(74))
  console.log(`  ${'Tổng:'.padEnd(64)} ${fmtMoney(total).padStart(10)}`)
  console.log(`  ${'Expected tổng (theo spec):'.padEnd(64)} ${fmtMoney(testCase.expectedTotal).padStart(10)}`)
  console.log(`  ${total === testCase.expectedTotal ? '✓ MATCH' : '✗ MISMATCH'}`)
  if (testCase.metaNote) console.log(`\n  📌 ${testCase.metaNote}`)
  console.log()
}

// ────────────────────────────────────────────────────────────────────────────
// CASE A — Chuyển phòng rồi checkout 14:00 cùng ngày
// ────────────────────────────────────────────────────────────────────────────
runCase({
  name: 'CASE A — Chuyển phòng rồi checkout 14:00 cùng ngày',
  input: {
    'Phòng cũ':           '602 (500K/đêm)',
    'Phòng mới':          '502 (550K/đêm, slot giờ 2h = 100K)',
    'Check-in':           '15/05 15:33',
    'Chuyển phòng':       '16/05 11:56',
    'Phí chuyển':         '50.000',
    'Checkout thực tế':   '16/05 14:00',
  },
  expected: [
    { label: '[602] Giá ngày (15/05 15:33 → 16/05 11:56)',         amount: 500000 },
    { label: 'Phụ thu chuyển phòng 602 → 502',                      amount: 50000  },
    { label: '[502] Giá nghỉ giờ (16/05 11:56 → 16/05 14:00)',     amount: 100000, note: 'Slot 2h của policy 502' },
  ],
  expectedTotal: 650000,
})

// ────────────────────────────────────────────────────────────────────────────
// CASE B — Chuyển phòng rồi ở tiếp qua đêm
// ────────────────────────────────────────────────────────────────────────────
runCase({
  name: 'CASE B — Chuyển phòng rồi ở tiếp qua đêm',
  input: {
    'Phòng cũ':           '602 (500K/đêm)',
    'Phòng mới':          '502 (550K/đêm)',
    'Check-in':           '15/05 15:33',
    'Chuyển phòng':       '16/05 11:56',
    'Phí chuyển':         '50.000',
    'Checkout thực tế':   '18/05 12:00',
  },
  expected: [
    { label: '[602] Giá ngày (15/05 15:33 → 16/05 11:56)',         amount: 500000 },
    { label: 'Phụ thu chuyển phòng 602 → 502',                      amount: 50000  },
    { label: '[502] Giá ngày (16/05 11:56 → 17/05 12:00)',         amount: 550000, note: 'Absorb 11:56→14:00' },
    { label: '[502] Giá ngày (17/05 14:00 → 18/05 12:00)',         amount: 550000 },
  ],
  expectedTotal: 1650000,
})

// ────────────────────────────────────────────────────────────────────────────
// CASE C — Đổi cùng loại giá trong ngày check-in
// ────────────────────────────────────────────────────────────────────────────
runCase({
  name: 'CASE C — Đổi CÙNG loại giá trong ngày check-in',
  input: {
    'Phòng cũ':           '604 Deluxe (550K/đêm)',
    'Phòng mới':          '605 Deluxe (CÙNG loại 550K)',
    'Check-in':           '15/05 15:00',
    'Chuyển phòng':       '15/05 18:00',
    'Phí chuyển':         '0',
    'Checkout':           '16/05 12:00',
  },
  expected: [
    { label: '[604] Giá ngày (15/05 15:00 → 16/05 12:00)',         amount: 550000, note: 'KHÔNG split, chỉ log transfer' },
  ],
  expectedTotal: 550000,
  metaNote: 'transferHistory log 604→605 — KHÔNG ảnh hưởng breakdown',
})

// ────────────────────────────────────────────────────────────────────────────
// CASE D-1 — Khác loại, KHÔNG tick "Đổi loại giá"
// ────────────────────────────────────────────────────────────────────────────
runCase({
  name: 'CASE D-1 — Khác loại trong ngày CI, KHÔNG tick "Đổi loại giá"',
  input: {
    'Phòng cũ':           '604 Deluxe (550K)',
    'Phòng mới':          '504 Standard (450K)',
    'Check-in':           '15/05 15:00',
    'Chuyển phòng':       '15/05 18:00',
    'Checkout':           '16/05 12:00',
    'Đổi loại giá':       'KHÔNG tick',
  },
  expected: [
    { label: '[604] Deluxe - Giá ngày (15/05 15:00 → 16/05 12:00)', amount: 550000, note: 'Giữ giá Deluxe' },
  ],
  expectedTotal: 550000,
})

// ────────────────────────────────────────────────────────────────────────────
// CASE D-2 — Khác loại, CÓ tick "Đổi loại giá" — DÙNG POLICY MỚI
// ────────────────────────────────────────────────────────────────────────────
runCase({
  name: 'CASE D-2 — Khác loại trong ngày CI, CÓ tick → switch policy',
  input: {
    'Phòng cũ':           '604 Deluxe (550K)',
    'Phòng mới':          '504 Standard (450K)',
    'Check-in':           '15/05 15:00',
    'Chuyển phòng':       '15/05 18:00',
    'Checkout':           '16/05 12:00',
    'Đổi loại giá':       'CÓ tick → áp policy Standard cho cả đêm',
  },
  expected: [
    { label: '[504] Standard - Giá ngày (15/05 15:00 → 16/05 12:00)', amount: 450000, note: 'Recalc theo policy Standard' },
  ],
  expectedTotal: 450000,
  metaNote: 'KHÔNG có dòng adjust -100K. Booking.policyId được switch sang Standard, label hiển thị phòng MỚI 504',
})

// ────────────────────────────────────────────────────────────────────────────
// CASE E — Khác loại sau khi đã ở qua đêm, CÓ tick
// ────────────────────────────────────────────────────────────────────────────
runCase({
  name: 'CASE E — Khác loại sau qua đêm, CÓ tick "Đổi loại giá"',
  input: {
    'Phòng cũ':           '604 Deluxe (550K)',
    'Phòng mới':          '504 Standard (450K)',
    'Check-in':           '15/05 15:00',
    'Chuyển phòng':       '16/05 15:00',
    'Checkout':           '17/05 12:00',
    'Đổi loại giá':       'CÓ tick',
  },
  expected: [
    { label: '[604] Deluxe - Giá ngày (15/05 15:00 → 16/05 12:00)',   amount: 550000, note: 'Đêm 1 giữ giá cũ Deluxe' },
    { label: '[504] Standard - Giá ngày (16/05 15:00 → 17/05 12:00)', amount: 450000, note: 'Đêm 2 áp policy mới Standard' },
  ],
  expectedTotal: 1000000,
  metaNote: 'Đoạn 16/05 12:00 → 15:00 KHÔNG tính tiền (đoạn trống giữa)',
})

// ────────────────────────────────────────────────────────────────────────────
// CASE F-1 — Rạng sáng, KHÔNG tick
// ────────────────────────────────────────────────────────────────────────────
runCase({
  name: 'CASE F-1 — Rạng sáng (02:00) KHÔNG tick',
  input: {
    'Phòng cũ':           '604 Deluxe (550K)',
    'Phòng mới':          '504 Standard (450K)',
    'Check-in':           '15/05 20:00',
    'Chuyển phòng':       '16/05 02:00',
    'Checkout':           '16/05 12:00',
    'Đổi loại giá':       'KHÔNG tick',
  },
  expected: [
    { label: '[604] Deluxe - Giá ngày (15/05 20:00 → 16/05 12:00)', amount: 550000, note: 'Rạng sáng = vẫn đêm 15/05, không split' },
  ],
  expectedTotal: 550000,
})

// ────────────────────────────────────────────────────────────────────────────
// CASE F-2 — Rạng sáng, CÓ tick — SWITCH POLICY
// ────────────────────────────────────────────────────────────────────────────
runCase({
  name: 'CASE F-2 — Rạng sáng CÓ tick → switch policy',
  input: {
    'Phòng cũ':           '604 Deluxe (550K)',
    'Phòng mới':          '504 Standard (450K)',
    'Check-in':           '15/05 20:00',
    'Chuyển phòng':       '16/05 02:00',
    'Checkout':           '16/05 12:00',
    'Đổi loại giá':       'CÓ tick',
  },
  expected: [
    { label: '[504] Standard - Giá ngày (15/05 20:00 → 16/05 12:00)', amount: 450000, note: 'Recalc theo policy mới' },
  ],
  expectedTotal: 450000,
  metaNote: 'KHÔNG có dòng adjust. Cả đêm áp policy Standard, label = phòng mới',
})

// ────────────────────────────────────────────────────────────────────────────
// CASE G — Phí chuyển phòng (1 dòng, không nhân lên)
// ────────────────────────────────────────────────────────────────────────────
runCase({
  name: 'CASE G — Phí chuyển = 1 dòng cố định',
  input: {
    'Chuyển':             '602 → 502 lúc 16/05 11:56',
    'Phí chuyển':         '50.000',
  },
  expected: [
    { label: 'Phụ thu chuyển phòng 602 → 502',                     amount: 50000 },
  ],
  expectedTotal: 50000,
})

// ────────────────────────────────────────────────────────────────────────────
// CASE H — Đoàn nhiều phòng
// ────────────────────────────────────────────────────────────────────────────
runCase({
  name: 'CASE H — Đoàn 5 phòng, chỉ đổi 604 → 504',
  input: {
    'Đoàn 5 phòng':       '601, 602, 603, 604, 605',
    'Đổi':                'Chỉ 604 → 504 lúc 16/05 15:00',
  },
  expected: [
    { label: '601, 602, 603, 605: priceBreakdown KHÔNG đổi',       amount: 0 },
    { label: '604: priceBreakdown recalc theo Case E (nếu tick)',   amount: 0 },
  ],
  expectedTotal: 0,
  metaNote: 'Chỉ touch sub-room.rooms[i] tương ứng phòng đổi. KHÔNG re-price đoàn.',
})

// ────────────────────────────────────────────────────────────────────────────
// CASE I (MỚI) — isFreeRoom=true + có đổi phòng
// ────────────────────────────────────────────────────────────────────────────
runCase({
  name: 'CASE I (mới) — isFreeRoom + đổi phòng có phí',
  input: {
    'Phòng cũ':           '604 Deluxe',
    'Phòng mới':          '504 Standard',
    'Check-in':           '15/05 15:00',
    'Chuyển phòng':       '16/05 11:00',
    'Phí chuyển':         '50.000',
    'Checkout':           '17/05 12:00',
    'isFreeRoom':         'TRUE — miễn phí tiền phòng',
  },
  expected: [
    { label: 'Phụ thu chuyển phòng 604 → 504',                     amount: 50000, note: 'Chỉ còn dòng này' },
  ],
  expectedTotal: 50000,
  metaNote: 'isFreeRoom = ẨN HẾT các dòng "Giá ngày/giờ", chỉ giữ phí chuyển',
})

console.log('═'.repeat(82))
console.log('📌 GHI CHÚ THAY ĐỔI v2:')
console.log()
console.log('  D-2 / F-2 (đổi loại giá, có tick):')
console.log('    v1: 2 dòng = giá cũ 550K + adjust -100K = 450K')
console.log('    v2: 1 dòng = giá mới 450K (Standard) — switch policy, KHÔNG có dòng adjust')
console.log()
console.log('  I (mới — isFreeRoom):')
console.log('    Bỏ toàn bộ dòng "Giá ngày/giờ", chỉ giữ "Phụ thu chuyển phòng"')
console.log()
console.log('  Em chờ anh xác nhận v2 đúng trước khi code BE.')
console.log('═'.repeat(82))