// backend/src/utils/telegramQueue.js
// ════════════════════════════════════════════════════════════════════
// Queue gửi tin nhắn Telegram — IN-PROCESS (không cần Redis).
//   - Đẩy job vào hàng đợi (enqueue) → worker xử lý tuần tự, KHÔNG chặn flow chính.
//   - Retry tối đa MAX_RETRIES lần với backoff khi gửi lỗi (mạng/Telegram 429...).
//   - Rate-limit nhẹ giữa các tin để tránh bị Telegram giới hạn (~30 msg/s toàn bot,
//     nhưng để an toàn ta giãn nhẹ).
//
// Phù hợp triển khai 1 tiến trình Node (pm2 1 instance). Nếu chạy nhiều instance
//   (cluster), nên chuyển sang Redis/BullMQ — nhưng với PMS này queue in-process là đủ.
//
// Dùng:
//   const { enqueueTelegram } = require('./telegramQueue');
//   enqueueTelegram({ text: 'Xin chào', parseMode: 'HTML' });
// ════════════════════════════════════════════════════════════════════

const MAX_RETRIES   = 3;
const RETRY_DELAYMS = [1000, 3000, 8000];   // backoff theo lần retry
const GAP_MS        = 350;                  // giãn cách giữa 2 tin (rate-limit nhẹ)
const MAX_QUEUE     = 1000;                 // chặn queue phình vô hạn nếu Telegram chết

const queue = [];
let running = false;

// sender được inject từ telegramController để tránh vòng lặp require.
//   sender(job) => Promise (throw nếu lỗi).
let _sender = null;
function setSender(fn) { _sender = fn; }

function enqueueTelegram(job) {
  if (!job || !job.text) return false;
  if (queue.length >= MAX_QUEUE) {
    console.warn('[telegramQueue] queue đầy, bỏ qua job mới');
    return false;
  }
  queue.push({ ...job, _retries: 0 });
  // Khởi động worker nếu chưa chạy (không await — non-blocking)
  if (!running) { running = true; setImmediate(processQueue); }
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function processQueue() {
  while (queue.length > 0) {
    const job = queue.shift();
    try {
      if (!_sender) throw new Error('Telegram sender chưa được khởi tạo');
      await _sender(job);
    } catch (err) {
      job._retries = (job._retries || 0) + 1;
      if (job._retries <= MAX_RETRIES) {
        const delay = RETRY_DELAYMS[job._retries - 1] || 8000;
        console.warn(`[telegramQueue] gửi lỗi (lần ${job._retries}): ${err.message} — thử lại sau ${delay}ms`);
        await sleep(delay);
        queue.unshift(job);   // đưa lại đầu hàng để thử lại
      } else {
        console.error(`[telegramQueue] bỏ job sau ${MAX_RETRIES} lần lỗi: ${err.message}`);
      }
    }
    await sleep(GAP_MS);
  }
  running = false;
}

function queueSize() { return queue.length; }

module.exports = { enqueueTelegram, setSender, queueSize };