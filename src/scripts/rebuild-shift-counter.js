// backend/src/scripts/rebuild-shift-counter.js
//
// ⭐ Migration 16/05/2026: Đồng bộ ShiftCounter theo MAX shiftCode hiện có của từng branch
//
// Lý do:
//   - Đổi format shiftCode "#1" → "PALM-1", "DAUTRE-1"
//   - Counter có thể đang lệch (vd Branch B chưa từng dùng counter riêng)
//   - Script này quét tất cả Shift trong DB → tính MAX số → set counter = MAX + 1
//
// Run: cd backend && node src/scripts/rebuild-shift-counter.js
//
require('dotenv').config()
const mongoose = require('mongoose')

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) {
    console.error('❌ MONGODB_URI not set')
    process.exit(1)
  }

  console.log('🔌 Connecting to MongoDB...')
  await mongoose.connect(uri)
  console.log('✓ Connected')

  const Shift = require('../models/Shift')
  const ShiftCounter = require('../models/ShiftCounter')
  const Branch = require('../models/Branch')

  const branches = await Branch.find({}).select('_id name code slug').lean()
  console.log(`\n📋 Found ${branches.length} branches\n`)

  for (const branch of branches) {
    const branchId = branch._id
    const shifts = await Shift.find({ branchId }).select('shiftCode').lean()

    // Extract số từ shiftCode (hỗ trợ cả format cũ "#1" lẫn mới "PALM-1")
    let maxNum = 0
    for (const s of shifts) {
      if (!s.shiftCode) continue
      // Match số cuối cùng trong code (vd "#7" → 7, "PALM-3" → 3, "BR-12" → 12)
      const m = String(s.shiftCode).match(/(\d+)\s*$/)
      if (m) {
        const n = parseInt(m[1], 10)
        if (n > maxNum) maxNum = n
      }
    }

    const nextNum = maxNum + 1
    const label = branch.name || branch.code || String(branchId)
    console.log(`  📍 ${label}: ${shifts.length} shifts, max=${maxNum} → next=${nextNum}`)

    // Update counter (upsert)
    await ShiftCounter.findOneAndUpdate(
      { branchId },
      { $set: { lastNumber: maxNum } },   // getNext sẽ $inc +1 = nextNum
      { upsert: true, new: true }
    )
  }

  console.log('\n✅ Done — counters rebuilt')
  await mongoose.disconnect()
  process.exit(0)
}

run().catch(err => {
  console.error('❌', err)
  process.exit(1)
})