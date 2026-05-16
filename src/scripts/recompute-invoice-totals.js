// backend/src/scripts/recompute-invoice-totals.js
//
// ⭐ Migration 15/05/2026: Recompute paidAmount + remainingAmount + paymentStatus
//   cho tất cả invoice, BỎ QUA các payment đã isDeleted.
//
// Run: cd backend && node src/scripts/recompute-invoice-totals.js
//
require('dotenv').config()
const mongoose = require('mongoose')
const Invoice = require('../models/Invoice')

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) {
    console.error('❌ MONGODB_URI not set')
    process.exit(1)
  }

  console.log('🔌 Connecting to MongoDB...')
  await mongoose.connect(uri)
  console.log('✓ Connected')

  const invoices = await Invoice.find({})
  console.log(`📋 Found ${invoices.length} invoices`)

  let fixed = 0
  let unchanged = 0

  for (const inv of invoices) {
    const validPayments = (inv.payments ?? []).filter(p => !p.isDeleted)
    const newPaidAmount = validPayments.reduce((s, p) => s + (p.amount ?? 0), 0)
    const newRemaining = Math.max(0, (inv.totalAmount ?? 0) - newPaidAmount)
    const newStatus =
      newPaidAmount >= (inv.totalAmount ?? 0) ? 'paid'
      : newPaidAmount > 0 ? 'partial'
      : 'unpaid'

    const changed =
      inv.paidAmount !== newPaidAmount ||
      inv.remainingAmount !== newRemaining ||
      inv.paymentStatus !== newStatus

    if (changed) {
      console.log(
        `  📝 ${inv.invoiceCode || inv._id}: ` +
        `paid ${inv.paidAmount}→${newPaidAmount}, ` +
        `remain ${inv.remainingAmount}→${newRemaining}, ` +
        `status ${inv.paymentStatus}→${newStatus}`
      )
      inv.paidAmount = newPaidAmount
      inv.remainingAmount = newRemaining
      inv.paymentStatus = newStatus
      await inv.save()
      fixed++
    } else {
      unchanged++
    }
  }

  console.log(`\n✅ Done: ${fixed} fixed, ${unchanged} unchanged`)
  await mongoose.disconnect()
  process.exit(0)
}

run().catch(err => {
  console.error('❌', err)
  process.exit(1)
})