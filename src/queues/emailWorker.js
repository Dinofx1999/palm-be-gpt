// backend/src/queues/emailWorker.js
// ════════════════════════════════════════════════════════════════════
// ⭐ NEW 30/05/2026: Worker xử lý job gửi email từ queue "email".
//
//   CHẠY WORKER — 2 cách:
//   A) Cùng tiến trình API: require('./queues/emailWorker') trong server.js
//      (đơn giản, đủ cho 1 server). File này tự khởi động worker khi require.
//   B) Tiến trình riêng:  node src/queues/emailWorker.js
//      (khuyến nghị khi scale — tách tải gửi mail khỏi API).
//
//   Worker tự retry theo cấu hình job (attempts/backoff trong emailQueue.js).
//   Lỗi cuối cùng (hết lượt retry) → job vào trạng thái 'failed', vẫn lưu lại
//   để tra cứu; không làm sập API.
// ════════════════════════════════════════════════════════════════════
const { Worker } = require('bullmq');
const { connection } = require('./redisConnection');
const { EMAIL_QUEUE_NAME } = require('./emailQueue');
const { sendMail } = require('../utils/mailer');

const CONCURRENCY = Number(process.env.EMAIL_WORKER_CONCURRENCY) || 5;

const emailWorker = new Worker(
  EMAIL_QUEUE_NAME,
  async (job) => {
    // ⭐ Job GỬI BÁO CÁO — gọi lại reportScheduler trong nền (tự gửi mail bên trong).
    if (job.name === 'report' || job.data?.__kind === 'report') {
      const { branchId, type, coversYesterday } = job.data || {};
      if (!branchId) throw new Error('Job report thiếu "branchId"');
      const { sendDailyReport, sendMonthlyReport } = require('../utils/reportScheduler');
      if (type === 'monthly') await sendMonthlyReport(branchId);
      else await sendDailyReport(branchId, !!coversYesterday);
      return { reportedAt: new Date().toISOString(), branchId, type };
    }

    // ⭐ Job GỬI EMAIL thường.
    const { to, subject, html, text, cc, bcc, attachments, branchId } = job.data || {};
    if (!to)       throw new Error('Job thiếu "to"');
    if (!branchId) throw new Error('Job thiếu "branchId"');

    // sendMail throw nếu SMTP lỗi → BullMQ tự retry theo backoff.
    await sendMail({ to, subject, html, text, cc, bcc, attachments, branchId });
    return { sentAt: new Date().toISOString(), to };
  },
  { connection, concurrency: CONCURRENCY }
);

emailWorker.on('completed', (job, result) => {
  if (job.name === 'report') {
    console.log(`[emailWorker] ✓ report job=${job.id} branch=${result?.branchId} type=${result?.type}`);
  } else {
    console.log(`[emailWorker] ✓ sent job=${job.id} to=${result?.to ?? job.data?.to}`);
  }
});

emailWorker.on('failed', (job, err) => {
  const attempts = job?.attemptsMade ?? 0;
  const max = job?.opts?.attempts ?? 0;
  const exhausted = attempts >= max;
  console.error(
    `[emailWorker] ✗ job=${job?.id} to=${job?.data?.to} attempt=${attempts}/${max}` +
    `${exhausted ? ' (HẾT lượt retry)' : ' — sẽ thử lại'}: ${err.message}`
  );
});

emailWorker.on('error', (err) => {
  console.error('[emailWorker] worker error:', err.message);
});

// Đóng worker gọn gàng khi process tắt.
const shutdown = async () => {
  try { await emailWorker.close(); } catch (_) {}
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`[emailWorker] started (concurrency=${CONCURRENCY})`);

module.exports = { emailWorker };