'use strict'
/** Test runner tối giản — không phụ thuộc, in kết quả gọn. */
let passed = 0, failed = 0
const failures = []

function approxEqual(a, b) { return Number(a) === Number(b) }

function runCase(tc) {
  let actual
  try {
    actual = tc.run()
  } catch (e) {
    failed++
    failures.push({ id: tc.id, name: tc.name, error: 'THREW: ' + e.message })
    return
  }
  const okTotal = approxEqual(actual.total, tc.expectTotal)
  let okBreakdown = true
  if (Array.isArray(tc.expectLines)) {
    const got = (actual.breakdown || []).map(l => Math.round(l.amount))
    okBreakdown = got.length === tc.expectLines.length &&
      got.every((v, i) => v === tc.expectLines[i])
  }
  if (okTotal && okBreakdown) {
    passed++
  } else {
    failed++
    failures.push({
      id: tc.id, name: tc.name,
      expectTotal: tc.expectTotal, gotTotal: actual.total,
      expectLines: tc.expectLines,
      gotLines: (actual.breakdown || []).map(l => ({ amt: Math.round(l.amount), label: l.label })),
    })
  }
}

function report(groupName) {
  console.log(`\n${'═'.repeat(64)}\n${groupName}\n${'═'.repeat(64)}`)
}

function summary() {
  console.log(`\n${'━'.repeat(64)}`)
  console.log(`TỔNG: ${passed} PASS / ${failed} FAIL  (tổng ${passed + failed} test)`)
  if (failures.length > 0) {
    console.log(`\n❌ CHI TIẾT ${failures.length} CASE LỖI:`)
    for (const f of failures.slice(0, 40)) {
      console.log(`\n  [${f.id}] ${f.name}`)
      if (f.error) { console.log(`     ${f.error}`); continue }
      console.log(`     Tổng: nhận ${fmt(f.gotTotal)} — kỳ vọng ${fmt(f.expectTotal)}`)
      if (f.expectLines) {
        console.log(`     Dòng kỳ vọng: [${f.expectLines.join(', ')}]`)
        console.log(`     Dòng nhận được:`)
        f.gotLines.forEach(l => console.log(`        ${fmt(l.amt).padStart(10)}  ${l.label}`))
      }
    }
  }
  return failed === 0
}

function fmt(n) { return (Number(n) || 0).toLocaleString('vi-VN') }

module.exports = { runCase, report, summary, get passed() { return passed }, get failed() { return failed } }