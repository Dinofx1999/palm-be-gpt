const express = require('express');
const router = express.Router();
const Invoice = require('../models/Invoice');
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

module.exports = router;