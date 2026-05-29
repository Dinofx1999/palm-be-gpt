// backend/src/utils/mailer.js
// ════════════════════════════════════════════════════════════════════
// Gửi email qua SMTP THEO CHI NHÁNH — đọc cấu hình từ settingsController.
// ⚠️ CÀI: npm i nodemailer
//
// Dùng:
//   const { sendMail } = require('../utils/mailer');
//   await sendMail({ to, subject, html, branchId });   // branchId BẮT BUỘC
// ════════════════════════════════════════════════════════════════════
const nodemailer = require('nodemailer');
const { getSettings } = require('../controllers/settingsController');

// Tạo transporter từ cấu hình email của 1 chi nhánh.
async function buildTransport(branchId) {
  const { email } = await getSettings(branchId);
  if (!email.user || !email.pass) {
    throw new Error('Email chi nhánh chưa được cấu hình (thiếu user/App Password)');
  }
  return {
    transporter: nodemailer.createTransport({
      host: email.host,
      port: email.port,
      secure: email.secure,
      auth: { user: email.user, pass: email.pass },
    }),
    from: `"${email.fromName || 'LuxHotel'}" <${email.fromEmail || email.user}>`,
    enabled: email.enabled,
  };
}

// Gửi 1 email (throw nếu lỗi). branchId bắt buộc để biết dùng tài khoản nào.
async function sendMail({ to, subject, html, text, cc, bcc, attachments, branchId }) {
  if (!to) throw new Error('Thiếu địa chỉ người nhận');
  if (!branchId) throw new Error('Thiếu branchId để chọn cấu hình email chi nhánh');
  const { transporter, from } = await buildTransport(branchId);
  return transporter.sendMail({
    from, to, cc, bcc, subject,
    text: text || undefined,
    html: html || undefined,
    attachments: attachments || undefined,
  });
}

// Gửi non-blocking; tự bỏ qua nếu email chi nhánh đang Tắt. Lỗi chỉ log.
function sendMailSafe(opts) {
  (async () => {
    try {
      if (!opts?.branchId) { console.warn('[mailer] sendMailSafe thiếu branchId → bỏ qua'); return; }
      const { email } = await getSettings(opts.branchId);
      if (!email.enabled) return;     // chi nhánh tắt email → bỏ qua êm
      await sendMail(opts);
    } catch (e) {
      console.error('[mailer] sendMailSafe failed (non-fatal):', e.message);
    }
  })();
  return true;
}

module.exports = { sendMail, sendMailSafe };