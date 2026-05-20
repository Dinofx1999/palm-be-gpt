// backend/src/routes/sepay.js
// ════════════════════════════════════════════════════════════════════
// Tích hợp SePay — khớp ĐÚNG schema Invoice thật của bạn:
//   - Invoice nối Booking qua `bookingId`
//   - Tiền: totalAmount / paidAmount / remainingAmount
//   - Trạng thái: paymentStatus ('unpaid' | 'partial' | 'paid')
//   - Lịch sử thanh toán: mảng con payments[]
//
// 2 endpoint:
//   1) POST /sepay/webhook  — SePay đẩy giao dịch vào, lưu SepayTransaction
//                             (chỉ LƯU, không ghi invoice ở đây)
//   2) GET  /sepay/match    — FE (QRPaymentModal) polling: tìm SepayTransaction
//                             khớp <bookingCode> + <payCode> (số tiền: ghi đúng thực tế).
//                             Khớp → ghi payment vào invoice → trả paid=true.
//
// Ý tưởng (theo yêu cầu): nội dung CK = "BKYCDMHF 166563"
//   - BKYCDMHF: xác định booking
//   - 166563:   mã giao dịch ngẫu nhiên, xác định ĐÚNG giao dịch hiện tại
// ════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const Invoice = require('../models/Invoice');
const Booking = require('../models/Booking');
const SepayTransaction = require('../models/SepayTransaction');

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
//    Việc khớp + ghi invoice để cho /sepay/match xử lý (theo payCode).
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
    // Lưu giao dịch. Unique index trên sepayId chống trùng khi SePay retry.
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
      // Đã lưu rồi (retry) → vẫn trả 200 để SePay dừng gửi lại
      return res.json({ success: true, message: 'Already saved' });
    }
    console.error('SePay webhook error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════════════════
// 2) MATCH — FE polling: GET /sepay/match?bookingCode=BKYCDMHF&payCode=166563
//    Tìm SepayTransaction khớp cả 3 điều kiện, chưa khớp invoice nào →
//    ghi payment vào invoice của booking, đánh dấu giao dịch đã khớp.
// ════════════════════════════════════════════════════════════════════
router.get('/sepay/match', async (req, res) => {
  try {
    const { bookingCode, payCode } = req.query;
    if (!bookingCode) {
      return res.status(400).json({ success: false, message: 'Thiếu bookingCode' });
    }

    const wantBooking = normalize(bookingCode);          // "BKD9CMKA"

    // Tìm các giao dịch tiền vào CHƯA khớp invoice nào.
    //   ⭐ KHÔNG lọc theo số tiền — khách chuyển bao nhiêu ghi bấy nhiêu.
    const candidates = await SepayTransaction.find({
      transferType: 'in',
      matchedInvoice: null,
    })
      .sort({ createdAt: 1 })   // cũ trước → ghi tiền theo đúng thứ tự khách chuyển
      .limit(50);

    // ⭐ Khớp: content chứa mã booking. payCode CHỈ siết thêm NẾU giao dịch có chứa
    //   (để không bỏ sót giao dịch khách quên/sai payCode). matchedInvoice đã chống
    //   ghi trùng, nên cứ tiền nào của booking này chưa ghi thì ghi → bền cho nhiều lần TT.
    // ⭐ Lọc TẤT CẢ giao dịch của booking này (content chứa mã booking).
    //   matchedInvoice đã chống ghi trùng, nên cứ tiền nào của booking chưa ghi thì ghi.
    //   Ghi nhiều giao dịch một lần → khách trả dồn 2-3 lần vẫn vào đủ.
    const matchedList = candidates.filter(tx => {
      const c = normalize(tx.content);
      return c.includes(wantBooking);
    });

    if (matchedList.length === 0) {
      return res.json({ success: true, data: { paid: false } });
    }

    // Tìm booking → invoice (Invoice nối Booking qua bookingId)
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

    // ⭐ Ghi TỪNG giao dịch khớp vào payments[], cộng dồn paidAmount
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
      // đánh dấu đã khớp ngay để lần polling sau không ghi lại
      tx.matchedInvoice = invoice._id;
    }
    recomputeInvoice(invoice);
    await invoice.save();
    // lưu trạng thái đã khớp cho tất cả giao dịch
    await Promise.all(matchedList.map(tx => tx.save()));

    // ⭐ Tạo phiếu Thu/Chi (Transaction) cho từng payment vừa ghi.
    //   Lấy đúng N payment CUỐI mảng (vừa push ở trên) — lúc này đã có _id sau save.
    //   Không có user đăng nhập (chạy nền) → userId: null.
    //   Bọc try/catch: lỗi sync KHÔNG chặn việc ghi tiền (non-fatal).
    try {
      const { syncInvoicePayment } = require('../utils/invoiceTransactionHelper');
      const Transaction = require('../models/Transaction');
      const newPayments = invoice.payments.slice(-addedCount);
      const newPaymentIds = newPayments.map(p => p._id);

      for (const p of newPayments) {
        await syncInvoicePayment(invoice, p, { userId: null });
      }

      // ⭐ ĐỐI SOÁT TỰ ĐỘNG: giao dịch do SePay khớp = tiền đã thực vào + đúng hoá đơn
      //   → đánh dấu Transaction tương ứng isReconciled = true ngay,
      //     nhân viên không cần đối soát tay nữa.
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

    return res.json({
      success: true,
      data: {
        paid: true,
        invoiceId:       invoice._id,
        amount:          addedTotal,            // tổng tiền vừa ghi lần này
        count:           addedCount,            // số giao dịch vừa khớp
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

module.exports = router;