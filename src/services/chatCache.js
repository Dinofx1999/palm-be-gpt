// backend/src/services/chatCache.js
// ============================================================
// Quản lý Gemini Context Cache (TTL 24h)
// Tiết kiệm ~75% input token cho phần system prompt + tools
//
// Cache key = hash(role + branchId + fewShotVersion)
// Mỗi (role × branch) có 1 cache riêng vì system prompt khác nhau
// ============================================================

const crypto = require('crypto');

// Cache TTL: 24 giờ (Google charges per token-hour)
const CACHE_TTL_SECONDS = 24 * 60 * 60;

// Cache TTL local memory — nên thấp hơn TTL Google 1 chút
// Để tự re-create trước khi Google cache hết hạn
const LOCAL_TTL_MS = 23.5 * 60 * 60 * 1000; // 23h30

// In-memory map: cacheKey → { cacheRef, createdAt, fewShotVersion }
const cacheRegistry = new Map();

// Version counter — tăng khi few-shots thay đổi, để invalidate tất cả cache
let currentFewShotVersion = Date.now();

// ============================================================
// Helper: tạo cache key
// ============================================================
function makeCacheKey(ctx) {
  const branchKey = ctx.userBranchId || 'all';
  const raw = `${ctx.role}|${branchKey}|v${currentFewShotVersion}`;
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 16);
}

// ============================================================
// Bump version → invalidate tất cả cache
// Gọi khi admin sửa few-shots hoặc system prompt
// ============================================================
function invalidateAllCaches() {
  currentFewShotVersion = Date.now();
  cacheRegistry.clear();
  console.log(`[chatCache] Invalidated all caches. New version: ${currentFewShotVersion}`);
}

// ============================================================
// Lấy hoặc tạo cache
// genAI: instance của GoogleGenerativeAI
// systemInstruction: string
// tools: array
// ctx: { role, userBranchId }
// ============================================================
async function getOrCreateCache(genAI, systemInstruction, tools, ctx, modelName) {
  const key = makeCacheKey(ctx);
  const entry = cacheRegistry.get(key);

  // Cache còn hiệu lực
  if (entry && (Date.now() - entry.createdAt) < LOCAL_TTL_MS) {
    return { cache: entry.cacheRef, cacheKey: key, fromCache: true };
  }

  // Tạo cache mới
  try {
    console.log(`[chatCache] Creating new cache for key=${key}, model=${modelName}`);

    // ⭐ Gemini Caching API
    //   Yêu cầu min ~4096 token cho system instruction để cache có ý nghĩa
    //   Nếu prompt quá ngắn → API sẽ trả lỗi → fallback gracefully
    const cache = await genAI.caches.create({
      model: modelName,
      config: {
        systemInstruction,
        tools,
        ttl: `${CACHE_TTL_SECONDS}s`,
      },
    });

    cacheRegistry.set(key, {
      cacheRef: cache,
      createdAt: Date.now(),
      fewShotVersion: currentFewShotVersion,
    });

    return { cache, cacheKey: key, fromCache: false };
  } catch (err) {
    // Cache fail không phải fatal — fallback dùng model thường
    console.warn(`[chatCache] Failed to create cache:`, err.message);
    return { cache: null, cacheKey: key, fromCache: false, error: err.message };
  }
}

// ============================================================
// Cleanup expired entries (chạy định kỳ)
// ============================================================
function cleanupExpired() {
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of cacheRegistry.entries()) {
    if (now - entry.createdAt >= LOCAL_TTL_MS) {
      cacheRegistry.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[chatCache] Cleaned ${removed} expired cache refs`);
  }
}

// Chạy cleanup mỗi 1 giờ
setInterval(cleanupExpired, 60 * 60 * 1000);

// ============================================================
// Stats
// ============================================================
function getStats() {
  return {
    totalCaches: cacheRegistry.size,
    currentVersion: currentFewShotVersion,
    ttlSeconds: CACHE_TTL_SECONDS,
    entries: [...cacheRegistry.entries()].map(([key, e]) => ({
      key,
      createdAt: new Date(e.createdAt).toISOString(),
      ageMinutes: Math.round((Date.now() - e.createdAt) / 60000),
    })),
  };
}

module.exports = {
  getOrCreateCache,
  invalidateAllCaches,
  getStats,
  CACHE_TTL_SECONDS,
};