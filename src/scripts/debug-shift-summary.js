// debug-shift-summary.js
//
// Đặt ở đâu cũng được — script tự tìm /backend root
// Chạy 1 trong 2 cách:
//   cd backend && node debug-shift-summary.js
//   cd backend && node src/scripts/debug-shift-summary.js
//
require('dotenv').config();
const path = require('path');
const fs = require('fs');

// ⭐ Tự tìm backend root (chứa folder src/)
function findBackendRoot(start) {
  let cur = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(cur, 'src', 'config'))
        && fs.existsSync(path.join(cur, 'src', 'models'))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  throw new Error('Không tìm thấy backend root');
}

const ROOT = findBackendRoot(process.cwd());
console.log(`📁 Backend root: ${ROOT}\n`);

const DB = require(path.join(ROOT, 'src', 'config', 'database'));

(async () => {
  await DB.connect();

  const Shift = require(path.join(ROOT, 'src', 'models', 'Shift'));
  const Transaction = require(path.join(ROOT, 'src', 'models', 'Transaction'));

  // Tìm tất cả ca đang mở
  const openShifts = await Shift.find({ status: 'open' }).lean();
  if (openShifts.length === 0) {
    console.log('❌ Không có ca nào đang mở');
    process.exit(0);
  }

  for (const shift of openShifts) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📌 Ca: ${shift.shiftCode}`);
    console.log(`   _id:    ${shift._id}`);
    console.log(`   Mở lúc: ${shift.openedAt}`);
    console.log(`   Branch: ${shift.branchId}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const txs = await Transaction.find({ shiftId: shift._id }).lean();
    console.log(`\n📋 Có ${txs.length} giao dịch trong ca:\n`);

    if (txs.length === 0) {
      console.log('   (Không có giao dịch)\n');
      continue;
    }

    // Phân loại theo paymentMethod thực
    const byMethod = {};
    for (const t of txs) {
      const pm = t.paymentMethod ?? '(null)';
      const pmStr = String(pm);
      if (!byMethod[pmStr]) byMethod[pmStr] = { count: 0, totalIn: 0, totalOut: 0 };
      byMethod[pmStr].count++;
      if (t.type === 'income') byMethod[pmStr].totalIn += t.amount;
      else byMethod[pmStr].totalOut += t.amount;
    }

    console.log('💰 Tổng theo paymentMethod (raw từ DB):');
    for (const [pm, info] of Object.entries(byMethod)) {
      console.log(`   - "${pm}" (len=${pm.length}): ${info.count} gd | thu ${info.totalIn.toLocaleString('vi-VN')}đ | chi ${info.totalOut.toLocaleString('vi-VN')}đ`);
    }

    console.log('\n📋 Chi tiết các giao dịch:');
    for (const t of txs.slice(0, 20)) {
      const desc = (t.description ?? '').slice(0, 60);
      console.log(`   ${t.type === 'income' ? '↑' : '↓'} ${t.amount.toLocaleString('vi-VN').padStart(12)}đ | pm="${t.paymentMethod}" | ${t.category} | ${desc}`);
    }
    if (txs.length > 20) console.log(`   ... và ${txs.length - 20} gd khác`);

    // Compute summary với code mới
    console.log('\n🔍 computeShiftSummary kết quả:');
    const summary = await Shift.computeShiftSummary(shift._id);
    console.log(`   cashIn:     ${summary.cashIn.toLocaleString('vi-VN')}đ`);
    console.log(`   transferIn: ${summary.transferIn.toLocaleString('vi-VN')}đ`);
    console.log(`   cardIn:     ${summary.cardIn.toLocaleString('vi-VN')}đ`);
    console.log(`   otherIn:    ${summary.otherIn.toLocaleString('vi-VN')}đ`);
    console.log(`   cashOut:    ${summary.cashOut.toLocaleString('vi-VN')}đ`);
    console.log(`   total tx:   ${summary.transactionCount}`);
  }

  process.exit(0);
})().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});