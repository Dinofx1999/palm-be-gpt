// backend/src/queues/emailQueue.js
// ════════════════════════════════════════════════════════════════════
// ⭐ NEW 30/05/2026: Queue gửi email (BullMQ).
//   - Producer: controller gọi enqueueEmail(...) → trả ngay, không chờ SMTP.
//   - Consumer: emailWorker.js xử lý, tự retry khi lỗi (backoff).
//
//   Job mặc định: retry 5 lần, backoff exponential (bắt đầu 5s).
//   Giữ lại 1000 job thành công + 5000 job lỗi gần nhất để tra cứu.
// ════════════════════════════════════════════════════════════════════
const { Queue } = require('bullmq');
const { connection } = require('./redisConnection');

const EMAIL_QUEUE_NAME = 'email';

const emailQueue = new Queue(EMAIL_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 5,                                   // tổng 5 lần thử
    backoff: { type: 'exponential', delay: 5000 }, // 5s, 10s, 20s, 40s...
    removeOnComplete: { count: 1000 },
    removeOnFail:     { count: 5000 },
  },
});

emailQueue.on('error', (err) => {
  console.error('[emailQueue] error:', err.message);
});

/**
 * Đẩy 1 email vào queue.
 * @param {object} payload
 * @param {string} payload.to        - người nhận (bắt buộc)
 * @param {string} payload.subject
 * @param {string} payload.html
 * @param {string} payload.branchId  - bắt buộc (mailer chọn SMTP theo branch)
 * @param {object} [payload.meta]    - dữ liệu phụ để log/audit (bookingId, type...)
 * @param {string} [jobName='send']  - tên job (phân loại)
 * @returns {Promise<import('bullmq').Job>}
 */
async function enqueueEmail(payload, jobName = 'send') {
  if (!payload?.to)       throw new Error('enqueueEmail: thiếu "to"');
  if (!payload?.branchId) throw new Error('enqueueEmail: thiếu "branchId"');
  // jobId không đặt cố định → cho phép gửi lại cùng booking nhiều lần.
  return emailQueue.add(jobName, payload);
}

/**
 * Đẩy 1 job GỬI BÁO CÁO vào queue. Worker sẽ gọi lại reportScheduler trong nền.
 * @param {object} payload
 * @param {string} payload.branchId        - bắt buộc
 * @param {'daily'|'monthly'} payload.type - loại báo cáo
 * @param {boolean} [payload.coversYesterday]
 * @returns {Promise<import('bullmq').Job>}
 */
async function enqueueReport(payload) {
  if (!payload?.branchId) throw new Error('enqueueReport: thiếu "branchId"');
  const type = payload.type === 'monthly' ? 'monthly' : 'daily';
  return emailQueue.add('report', { ...payload, type, __kind: 'report' });
}

module.exports = { emailQueue, enqueueEmail, enqueueReport, EMAIL_QUEUE_NAME };