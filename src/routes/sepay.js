// backend/src/routes/sepay.js
// ════════════════════════════════════════════════════════════════════
// Tích hợp SePay — khớp ĐÚNG schema Invoice thật của bạn:
//   - Invoice nối Booking qua `bookingId`
//   - Tiền: totalAmount / paidAmount / remainingAmount
//   - Trạng thái: paymentStatus ('unpaid' | 'partial' | 'paid')
//   - Lịch sử thanh toán: mảng con payments[]
//
// Endpoint:
//   1) POST /sepay/webhook            — SePay đẩy giao dịch vào, lưu SepayTransaction
//   2) GET  /sepay/match              — FE polling: khớp <bookingCode> + <payCode>
//   3) GET  /sepay/transactions       — [NEW] liệt kê/tra cứu giao dịch (cho PMS)
//   4) GET  /sepay/transactions/stats — [NEW] thống kê nhanh
// ════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const Invoice = require('../models/Invoice');
const Booking = require('../models/Booking');
const SepayTransaction = require('../models/SepayTransaction');
const { authenticate } = require('../middleware/auth');

// ── Helpers ──────────────────────────────────────────────────────────

// Chuẩn hoá để so khớp nội dung: viết hoa, bỏ mọi ký tự không phải chữ/số.
//   "BK_YCDMHF 166563" -> "BKYCDMHF166563"
function normalize(s) {
  return String(s || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

// Cập nhật remaining + paymentStatus của invoice theo paidAmount/totalAmount
function recomputeInvoice(invoice) {
  invoice.remainingAmount = Math.max(0, invoice.totalAmount - invoice.paidAmount);
  if (invoice.paidAmount <= 0)               invoice.paymentStatus = 'unpaid';
  else if (invoice.paidAmount >= invoice.totalAmount) invoice.paymentStatus = 'paid';
  else                                       invoice.paymentStatus = 'partial';
}

// ── Middleware xác thực API Key (bạn tự đặt, khớp 2 phía) ──────────────
function verifySepay(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Apikey ${process.env.SEPAY_API_KEY}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

// ════════════════════════════════════════════════════════════════════
// 1) WEBHOOK — SePay đẩy giao dịch vào. Chỉ LƯU SepayTransaction.
// ════════════════════════════════════════════════════════════════════
router.post('/sepay/webhook', verifySepay, async (req, res) => {
  const data = req.body;
  if (!data || !data.id) {
    return res.status(400).json({ success: false, message: 'No data' });
  }
  if (data.transferType !== 'in') {
    return res.json({ success: true, message: 'Ignored (not incoming)' });
  }

  try {
    await SepayTransaction.create({
      sepayId:         data.id,
      gateway:         data.gateway,
      transactionDate: data.transactionDate ? new Date(data.transactionDate) : null,
      accountNumber:   data.accountNumber,
      subAccount:      data.subAccount,
      code:            data.code,
      content:         data.content,
      transferType:    data.transferType,
      transferAmount:  data.transferAmount,
      accumulated:     data.accumulated,
      referenceCode:   data.referenceCode,
    });
    return res.json({ success: true, message: 'Saved' });
  } catch (err) {
    if (err.code === 11000) {
      return res.json({ success: true, message: 'Already saved' });
    }
    console.error('SePay webhook error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════════════════
// 2) MATCH — FE polling khớp giao dịch theo bookingCode + payCode.
// ════════════════════════════════════════════════════════════════════
router.get('/sepay/match', async (req, res) => {
  try {
    const { bookingCode, payCode } = req.query;
    if (!bookingCode) {
      return res.status(400).json({ success: false, message: 'Thiếu bookingCode' });
    }

    const wantBooking = normalize(bookingCode);

    const candidates = await SepayTransaction.find({
      transferType: 'in',
      matchedInvoice: null,
    })
      .sort({ createdAt: 1 })
      .limit(50);

    const matchedList = candidates.filter(tx => {
      const c = normalize(tx.content);
      return c.includes(wantBooking);
    });

    if (matchedList.length === 0) {
      return res.json({ success: true, data: { paid: false } });
    }

    const booking = await Booking.findOne({
      $expr: {
        $eq: [
          { $toUpper: { $replaceAll: {
            input: { $ifNull: ['$bookingCode', ''] }, find: '_', replacement: '',
          } } },
          wantBooking,
        ],
      },
    });
    if (!booking) {
      return res.json({ success: true, data: { paid: false, reason: 'booking_not_found' } });
    }

    const invoice = await Invoice.findOne({ bookingId: booking._id });
    if (!invoice) {
      return res.json({ success: true, data: { paid: false, reason: 'invoice_not_found' } });
    }

    let addedTotal = 0;
    const addedCount = matchedList.length;
    for (const tx of matchedList) {
      invoice.payments.push({
        amount:  tx.transferAmount,
        method:  'transfer',
        type:    'payment',
        note:    `SePay tự động — ${tx.gateway || ''} ${tx.referenceCode || ''}`.trim(),
        paidAt:  tx.transactionDate || new Date(),
      });
      invoice.paidAmount = (invoice.paidAmount || 0) + tx.transferAmount;
      addedTotal += tx.transferAmount;
      tx.matchedInvoice = invoice._id;
    }
    recomputeInvoice(invoice);
    await invoice.save();
    await Promise.all(matchedList.map(tx => tx.save()));

    try {
      const { syncInvoicePayment } = require('../utils/invoiceTransactionHelper');
      const Transaction = require('../models/Transaction');
      const newPayments = invoice.payments.slice(-addedCount);
      const newPaymentIds = newPayments.map(p => p._id);

      for (const p of newPayments) {
        await syncInvoicePayment(invoice, p, { userId: null });
      }

      await Transaction.updateMany(
        { relatedType: 'invoice_payment', relatedId: { $in: newPaymentIds } },
        {
          $set: {
            isReconciled:     true,
            reconciledAt:     new Date(),
            reconciledByName: 'SePay (tự động)',
          },
        }
      );
    } catch (syncErr) {
      console.error('[sepay/match] syncInvoicePayment failed (non-fatal):', syncErr.message);
    }

    // ⭐ Ghi AUDIT cho thanh toán tự động qua SePay (→ kéo theo gửi Telegram).
    //   Bọc try/catch riêng — lỗi audit KHÔNG ảnh hưởng việc đã ghi tiền.
    try {
      const { logAction } = require('../utils/auditLogger');
      await logAction({
        entityType: 'Invoice',
        entityId:   invoice._id,
        action:     'payment',
        description: `Thanh toán QR tự động (SePay) ${new Intl.NumberFormat('vi-VN').format(addedTotal)}đ`
          + (addedCount > 1 ? ` — ${addedCount} giao dịch` : ''),
        user:       { fullName: 'SePay (tự động)' },
        branchId:   booking.branchId || null,
        metadata: {
          bookingCode:   booking.bookingCode,
          roomNumber:    booking.roomNumber,
          amount:        addedTotal,
          paymentStatus: invoice.paymentStatus,
          source:        'sepay',
        },
      });
    } catch (auditErr) {
      console.error('[sepay/match] audit failed (non-fatal):', auditErr.message);
    }

    return res.json({
      success: true,
      data: {
        paid: true,
        invoiceId:       invoice._id,
        amount:          addedTotal,
        count:           addedCount,
        paidAmount:      invoice.paidAmount,
        remainingAmount: invoice.remainingAmount,
        paymentStatus:   invoice.paymentStatus,
      },
    });
  } catch (err) {
    console.error('SePay match error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════════════════
// 3) [NEW] LIST/TRA CỨU GIAO DỊCH — cho trang quản lý giao dịch ngân hàng (PMS)
//    GET /sepay/transactions
//    Query:
//      - q:        tìm trong content / referenceCode / gateway (không phân biệt hoa thường)
//      - status:   'matched' | 'unmatched' (đã/chưa khớp hóa đơn)
//      - from,to:  lọc theo transactionDate (ISO yyyy-mm-dd)
//      - gateway:  lọc theo ngân hàng
//      - page,limit: phân trang (mặc định 1 / 20, tối đa 100)
// ════════════════════════════════════════════════════════════════════
router.get('/sepay/transactions', authenticate, async (req, res) => {
  try {
    const { q, status, from, to, gateway } = req.query;
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const filter = { transferType: 'in' };

    if (status === 'matched')   filter.matchedInvoice = { $ne: null };
    if (status === 'unmatched') filter.matchedInvoice = null;
    if (gateway) filter.gateway = gateway;

    if (from || to) {
      filter.transactionDate = {};
      if (from) filter.transactionDate.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        // Nếu 'to' chỉ là ngày (không có giờ — vd "2026-05-21") → tính tới hết ngày.
        // Nếu có giờ (ISO chứa 'T' với phần time) → dùng nguyên giờ đó.
        const hasTime = /T\d{2}:\d{2}/.test(String(to));
        if (!hasTime) end.setHours(23, 59, 59, 999);
        filter.transactionDate.$lte = end;
      }
    }

    if (q && q.trim()) {
      const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ content: rx }, { referenceCode: rx }, { gateway: rx }];
    }

    const total = await SepayTransaction.countDocuments(filter);
    const items = await SepayTransaction.find(filter)
      .sort({ transactionDate: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate({ path: 'matchedInvoice', select: 'invoiceNumber bookingId totalAmount paidAmount paymentStatus' })
      .lean();

    // Gắn thêm bookingCode cho giao dịch đã khớp (tiện hiển thị)
    const invoiceBookingIds = items
      .map(t => t.matchedInvoice?.bookingId)
      .filter(Boolean);
    let bookingMap = {};
    if (invoiceBookingIds.length) {
      const bookings = await Booking.find({ _id: { $in: invoiceBookingIds } })
        .select('bookingCode customerName').lean();
      bookingMap = Object.fromEntries(bookings.map(b => [String(b._id), b]));
    }

    const data = items.map(t => ({
      _id:             t._id,
      sepayId:         t.sepayId,
      gateway:         t.gateway,
      transactionDate: t.transactionDate,
      accountNumber:   t.accountNumber,
      content:         t.content,
      transferAmount:  t.transferAmount,
      accumulated:     t.accumulated,
      referenceCode:   t.referenceCode,
      isMatched:       !!t.matchedInvoice,
      matchedInvoice:  t.matchedInvoice ? {
        invoiceNumber:  t.matchedInvoice.invoiceNumber,
        totalAmount:    t.matchedInvoice.totalAmount,
        paidAmount:     t.matchedInvoice.paidAmount,
        paymentStatus:  t.matchedInvoice.paymentStatus,
        bookingCode:    bookingMap[String(t.matchedInvoice.bookingId)]?.bookingCode || null,
        customerName:   bookingMap[String(t.matchedInvoice.bookingId)]?.customerName || null,
      } : null,
      createdAt:       t.createdAt,
    }));

    return res.json({
      success: true,
      data: {
        data,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('SePay transactions list error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════════════════
// 4) [NEW] THỐNG KÊ NHANH — tổng quan giao dịch
//    GET /sepay/transactions/stats?from=&to=&q=&status=&gateway=
// ════════════════════════════════════════════════════════════════════
router.get('/sepay/transactions/stats', authenticate, async (req, res) => {
  try {
    const { from, to, q, gateway } = req.query;
    const match = { transferType: 'in' };

    // Lưu ý: KHÔNG lọc theo 'status' ở stats — để 3 thẻ luôn phản ánh đủ
    //   (tổng / đã khớp / chưa khớp) trong phạm vi tìm kiếm. Lọc status chỉ
    //   áp dụng cho bảng danh sách, không áp cho thống kê.
    if (gateway) match.gateway = gateway;

    if (q && q.trim()) {
      const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      match.$or = [{ content: rx }, { referenceCode: rx }, { gateway: rx }];
    }

    if (from || to) {
      match.transactionDate = {};
      if (from) match.transactionDate.$gte = new Date(from);
      if (to) { const end = new Date(to); if (!/T\d{2}:\d{2}/.test(String(to))) end.setHours(23, 59, 59, 999); match.transactionDate.$lte = end; }
    }

    const rows = await SepayTransaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalCount:     { $sum: 1 },
          totalAmount:    { $sum: '$transferAmount' },
          matchedCount:   { $sum: { $cond: [{ $ne: ['$matchedInvoice', null] }, 1, 0] } },
          matchedAmount:  { $sum: { $cond: [{ $ne: ['$matchedInvoice', null] }, '$transferAmount', 0] } },
          unmatchedCount: { $sum: { $cond: [{ $eq: ['$matchedInvoice', null] }, 1, 0] } },
          unmatchedAmount:{ $sum: { $cond: [{ $eq: ['$matchedInvoice', null] }, '$transferAmount', 0] } },
        },
      },
    ]);

    const s = rows[0] || {
      totalCount: 0, totalAmount: 0, matchedCount: 0, matchedAmount: 0,
      unmatchedCount: 0, unmatchedAmount: 0,
    };
    delete s._id;

    return res.json({ success: true, data: s });
  } catch (err) {
    console.error('SePay stats error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;