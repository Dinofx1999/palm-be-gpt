// backend/src/utils/invoiceTransactionHelper.js
//
// ⭐ NEW 14/05/2026: Auto-sync transaction theo INVOICE PAYMENT
//
// Mục đích:
//   Mỗi khi user POST /api/invoices/:id/payment (khách trả tiền) → tự động
//   tạo 1 record Transaction (type=income) tương ứng → báo cáo dòng tiền chính xác.
//
//   - Khách trả nhiều lần → mỗi lần 1 transaction riêng
//   - Mỗi payment có id riêng (sub-doc trong invoice.payments[]) → idempotent
//   - Lưu paymentMethod (cash/transfer/card) → FE có thể filter sau
//
// Cách dùng (trong invoiceController.js):
//   const { syncInvoicePayment, removeInvoicePayment }
//     = require('../utils/invoiceTransactionHelper');
//
//   // Khi POST /payment thành công
//   await syncInvoicePayment(invoice, payment, { userId: req.user.id });
//
//   // Khi xoá payment
//   await removeInvoicePayment(payment._id);
//
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');

/**
 * Auto-tạo / cập nhật Transaction từ 1 Payment của Invoice.
 *
 * @param {Object} invoice  - Invoice document (đã populate branchId hoặc lean)
 * @param {Object} payment  - 1 sub-document trong invoice.payments[]
 * @param {Object} opts
 *   @param {String} opts.userId   - User thực hiện (lưu recordedBy)
 *   @param {String} opts.action   - 'create' | 'delete' (mặc định 'create')
 *
 * @returns {Promise<{ created?, updated?, deleted?, skipped? }>}
 */
async function syncInvoicePayment(invoice, payment, opts = {}) {
  const { userId, action = 'create' } = opts;

  if (!invoice?._id) return { skipped: 'no_invoice' };
  if (!payment?._id) return { skipped: 'no_payment' };

  const paymentId = payment._id;
  const branchId = invoice.branchId?._id || invoice.branchId;
  if (!branchId) {
    console.warn('[syncInvoicePayment] Invoice không có branchId');
    return { skipped: 'no_branch' };
  }

  // ─── DELETE ──────────────────────────────────────────────────────────
  if (action === 'delete') {
    const r = await Transaction.deleteOne({
      relatedType: 'invoice_payment',
      relatedId: paymentId,
    });
    return { deleted: r.deletedCount > 0 };
  }

  // ─── CREATE / UPDATE (idempotent) ────────────────────────────────────
  const rawAmount = Number(payment.amount) || 0;
  if (rawAmount === 0) return { skipped: 'zero_amount' };

  const isRefund = payment.type === 'refund' || rawAmount < 0;
  const txType = isRefund ? 'expense' : 'income';
  const amount = Math.abs(rawAmount);

  const invoiceCode = invoice.invoiceCode
    || invoice.invoiceNumber
    || `INV_${String(invoice._id).slice(-6).toUpperCase()}`;
  const customer = invoice.customerName || 'Khách lẻ';
  const roomInfo = invoice.roomNumber ? ` — Phòng ${invoice.roomNumber}` : '';

  const description = isRefund
    ? `Hoàn tiền ${invoiceCode} — ${customer}${roomInfo}${payment.note ? ` (${payment.note})` : ''}`
    : `Thanh toán ${invoiceCode} — ${customer}${roomInfo}`;

  const category = isRefund ? 'Hoàn tiền khách' : 'Tiền phòng';

  const pmMap = {
    cash: 'cash',
    transfer: 'transfer',
    bank: 'transfer',
    momo: 'transfer',
    vnpay: 'transfer',
    zalopay: 'transfer',
    card: 'card',
    credit: 'card',
    debit: 'card',
  };

  // ⭐ NEW 14/05/2026: Resolve paymentMethod
  //   Frontend có thể gửi:
  //   - "cash" / "transfer" / "card" (string đơn giản)
  //   - "69abc..." (ObjectId của PaymentMethod document)
  //
  let rawMethod = String(payment.method || payment.paymentMethod || '').toLowerCase();
  let paymentMethod = pmMap[rawMethod];

  // Nếu method là ObjectId → lookup PaymentMethod để lấy type thực
  if (!paymentMethod && mongoose.Types.ObjectId.isValid(payment.method)) {
    try {
      const PaymentMethod = mongoose.model('PaymentMethod');
      const pmDoc = await PaymentMethod.findById(payment.method).select('type').lean();
      if (pmDoc?.type) {
        paymentMethod = pmMap[String(pmDoc.type).toLowerCase()] || 'other';
        console.log(`[syncInvoicePayment] Resolved ObjectId ${payment.method} → type "${pmDoc.type}" → "${paymentMethod}"`);
      }
    } catch (err) {
      console.warn('[syncInvoicePayment] PaymentMethod lookup failed:', err.message);
    }
  }

  // Fallback cuối
  if (!paymentMethod) paymentMethod = 'cash';

  const occurredOn = payment.paidAt || payment.createdAt || new Date();

  // ⭐ Recorder: user thực hiện (cho audit / recordedBy)
  const recorder = userId || payment.createdBy || invoice.issuedBy;

  // ⭐ UPDATED 14/05/2026 v2: Auto-link shiftId theo BRANCH (không phải user)
  //   Vì workflow mới: 1 branch chỉ có 1 ca mở tại 1 lần
  //   → Mọi giao dịch trong branch đó đều thuộc ca đang mở (bất kể ai tạo)
  //   - Có ca mở trong branch → gắn shiftId
  //   - Không có → shiftId=null (vd: Admin tạo từ máy admin chưa mở ca)
  let shiftId = null;
  try {
    const Shift = require('../models/Shift');
    const openShift = await Shift.findOne({
      branchId,
      status: 'open',
    }).select('_id').lean();
    if (openShift) {
      shiftId = openShift._id;
    }
  } catch (shiftErr) {
    console.warn('[syncInvoicePayment] Shift lookup failed:', shiftErr.message);
  }

  // Idempotent: tìm theo paymentId
  const existing = await Transaction.findOne({
    relatedType: 'invoice_payment',
    relatedId: paymentId,
  });

  if (existing) {
    existing.type = txType;
    existing.amount = amount;
    existing.description = description;
    existing.category = category;
    existing.paymentMethod = paymentMethod;
    existing.occurredOn = new Date(occurredOn);
    // ⭐ Update shiftId nếu chưa có (đừng đè nếu đã gán đúng ca rồi)
    if (!existing.shiftId && shiftId) {
      existing.shiftId = shiftId;
    }
    if (userId) existing.updatedBy = userId;
    await existing.save();
    return { updated: existing.toObject() };
  }

  const tx = await Transaction.create({
    type: txType,
    category,
    amount,
    description,
    branchId,
    occurredOn: new Date(occurredOn),
    paymentMethod,
    relatedType: 'invoice_payment',
    relatedId: paymentId,
    recordedBy: recorder,
    shiftId,                                    // ⭐ NEW
    note: isRefund
      ? `Auto-tạo từ refund invoice ${invoiceCode}`
      : `Auto-tạo từ payment invoice ${invoiceCode}`,
  });

  return { created: tx.toObject() };
}

/**
 * Xoá transaction liên quan 1 payment (khi user xoá payment riêng lẻ)
 */
async function removeInvoicePayment(paymentId) {
  if (!paymentId) return { deleted: false };
  const r = await Transaction.deleteOne({
    relatedType: 'invoice_payment',
    relatedId: paymentId,
  });
  return { deleted: r.deletedCount > 0 };
}

/**
 * Xoá TẤT CẢ transaction của 1 invoice (khi xoá toàn bộ invoice)
 */
async function removeAllInvoiceTransactions(invoiceId) {
  if (!invoiceId) return { deleted: 0 };
  const Invoice = require('../models/Invoice');
  const inv = await Invoice.findById(invoiceId).select('payments').lean();
  if (!inv?.payments?.length) return { deleted: 0 };

  const paymentIds = inv.payments.map(p => p._id);
  const r = await Transaction.deleteMany({
    relatedType: 'invoice_payment',
    relatedId: { $in: paymentIds },
  });
  return { deleted: r.deletedCount };
}

/**
 * Sync TẤT CẢ payments của 1 invoice (upsert)
 *   Hữu ích khi invoice bị edit (payment thay đổi giá/phương thức)
 *   hoặc dùng để backfill.
 */
async function syncAllInvoicePayments(invoice, opts = {}) {
  if (!invoice?.payments?.length) return { synced: 0 };

  const results = { created: 0, updated: 0, skipped: 0 };
  for (const payment of invoice.payments) {
    try {
      const r = await syncInvoicePayment(invoice, payment, opts);
      if (r.created) results.created++;
      else if (r.updated) results.updated++;
      else results.skipped++;
    } catch (err) {
      console.error('[syncAllInvoicePayments]', err.message);
      results.skipped++;
    }
  }
  return results;
}

/**
 * Backfill data cũ: sync TẤT CẢ invoice đã có payment trong DB
 */
async function backfillInvoiceTransactions(filter = {}, opts = {}) {
  const Invoice = require('../models/Invoice');
  // ⭐ Không populate branchId vì syncInvoicePayment chỉ cần ObjectId
  //   (Nếu populate khi model Branch chưa load → MissingSchemaError)
  const invoices = await Invoice.find({
    ...filter,
    'payments.0': { $exists: true },
  }).lean();

  const stats = { totalInvoices: invoices.length, created: 0, updated: 0, skipped: 0 };
  for (const inv of invoices) {
    const r = await syncAllInvoicePayments(inv, opts);
    stats.created += r.created || 0;
    stats.updated += r.updated || 0;
    stats.skipped += r.skipped || 0;
  }
  return stats;
}

module.exports = {
  syncInvoicePayment,
  removeInvoicePayment,
  removeAllInvoiceTransactions,
  syncAllInvoicePayments,
  backfillInvoiceTransactions,
};