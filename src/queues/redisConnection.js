// backend/src/queues/redisConnection.js
// ════════════════════════════════════════════════════════════════════
// ⭐ NEW 30/05/2026: Kết nối Redis dùng chung cho BullMQ.
// ⚠️ CÀI: npm i bullmq ioredis
//
// ENV cần có:
//   REDIS_URL=redis://localhost:6379         (ưu tiên nếu có)
//   hoặc REDIS_HOST / REDIS_PORT / REDIS_PASSWORD
// ════════════════════════════════════════════════════════════════════
const IORedis = require('ioredis');

// BullMQ yêu cầu maxRetriesPerRequest = null cho blocking commands.
const buildConnection = () => {
  const url = process.env.REDIS_URL;
  const opts = { maxRetriesPerRequest: null, enableReadyCheck: false };
  if (url) return new IORedis(url, opts);
  return new IORedis({
    host:     process.env.REDIS_HOST || '127.0.0.1',
    port:     Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    ...opts,
  });
};

// Dùng 1 connection chung (BullMQ khuyến nghị share connection giữa Queue/Worker).
const connection = buildConnection();

connection.on('error', (err) => {
  console.error('[redis] connection error:', err.message);
});
connection.on('connect', () => {
  console.log('[redis] connected');
});

module.exports = { connection, buildConnection };