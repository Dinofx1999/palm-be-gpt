const express = require('express');
const router = express.Router();
const Invoice = require('../models/Invoice');
const Booking = require('../models/Booking'); 
const SepayTransaction = require('../models/SepayTransaction');

// Middleware xác thực API Key
function verifySepay(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Apikey ${process.env.SEPAY_API_KEY}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

router.post('/sepay/webhook', verifySepay, async (req, res) => {
  const data = req.body;
  if (!data || !data.id) {
    return res.status(400).json({ success: false, message: 'No data' });
  }

  // Chỉ xử lý tiền vào
  if (data.transferType !== 'in') {
    return res.json({ success: true, message: 'Ignored (not incoming)' });
  }

  try {
    // 1) Lưu giao dịch trước -> chống trùng bằng unique index trên sepayId.
    //    Nếu webhook bắn lại (retry), bước này ném E11000 và ta dừng ngay,
    //    đảm bảo KHÔNG cộng tiền hóa đơn lần hai.
    const tx = await SepayTransaction.create({
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

    // 2) Khớp hóa đơn theo mã thanh toán
    const paymentCode = data.code;
    if (!paymentCode) {
      return res.json({ success: true, message: 'No payment code, saved only' });
    }

    const invoice = await Invoice.findOne({ paymentCode });
    if (!invoice) {
      return res.json({ success: true, message: 'Invoice not found, saved only' });
    }

    // 3) Cộng dồn tiền & cập nhật trạng thái
    invoice.paidAmount += data.transferAmount;
    if (invoice.paidAmount >= invoice.totalAmount) {
      invoice.status = 'paid';
      invoice.paidAt = new Date();
    } else {
      invoice.status = 'partial';
    }
    await invoice.save();

    // 4) Gắn liên kết giao dịch <-> hóa đơn
    tx.matchedInvoice = invoice._id;
    await tx.save();

    return res.json({
      success: true,
      invoice: invoice.invoiceCode,
      status: invoice.status,
    });
  } catch (err) {
    // Webhook bắn lại do retry -> đã xử lý rồi, trả 200 để SePay dừng
    if (err.code === 11000) {
      return res.json({ success: true, message: 'Already processed' });
    }
    console.error('SePay webhook error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});
// / Chuẩn hoá mã: bỏ ký tự đặc biệt + viết hoa. "BK_YCDMHF" -> "BKYCDMHF"
function normalizeCode(s) {
  return String(s || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}
 
router.get('/sepay/status', async (req, res) => {
  try {
    const { bookingCode, invoiceId } = req.query;
 
    let invoice = null;
 
    // Cách 1: tra thẳng theo invoiceId nếu FE gửi lên
    if (invoiceId) {
      invoice = await Invoice.findById(invoiceId);
    }
 
    // Cách 2: tra theo bookingCode (FE QRPaymentModal đang dùng cách này)
    if (!invoice && bookingCode) {
      const normalized = normalizeCode(bookingCode);
 
      // ── TÌM INVOICE THEO MÃ BOOKING ──
      // ⚠ ĐOẠN NÀY PHẢI KHỚP SCHEMA THẬT CỦA BẠN. Có 3 kiểu phổ biến,
      //   chọn (bỏ comment) đúng 1 kiểu theo model Invoice/Booking của bạn:
 
      // KIỂU A — Invoice có sẵn field paymentCode (đã chuẩn hoá):
      // invoice = await Invoice.findOne({ paymentCode: normalized });
 
      // KIỂU B — Invoice liên kết Booking qua bookingId, Booking có bookingCode:
      const booking = await Booking.findOne({
        // so khớp linh hoạt: BK_YCDMHF hoặc BKYCDMHF đều ra
        $expr: {
          $eq: [
            { $toUpper: { $replaceAll: { input: { $ifNull: ['$bookingCode', ''] }, find: '_', replacement: '' } } },
            normalized,
          ],
        },
      });
      if (booking) {
        invoice = await Invoice.findOne({ bookingId: booking._id });
      }
 
      // KIỂU C — Invoice có field invoiceCode/code trùng mã booking:
      // invoice = await Invoice.findOne({ invoiceCode: bookingCode });
    }
 
    if (!invoice) {
      return res.json({ success: true, data: { found: false, paid: false } });
    }
 
    const totalAmount = Number(invoice.totalAmount ?? 0);
    const paidAmount  = Number(invoice.paidAmount ?? 0);
    const remaining   = Math.max(0, totalAmount - paidAmount);
 
    return res.json({
      success: true,
      data: {
        found: true,
        invoiceId:       invoice._id,
        totalAmount,
        paidAmount,
        remainingAmount: remaining,
        status:          invoice.status,
        paid:            paidAmount > 0,   // có tiền vào là true
      },
    });
  } catch (err) {
    console.error('SePay status error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});
module.exports = router;