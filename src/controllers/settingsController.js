// backend/src/controllers/settingsController.js
// ════════════════════════════════════════════════════════════════════
// Quản lý cấu hình hệ thống THEO TỪNG CHI NHÁNH (Telegram + Email + Báo cáo).
// + Export getSettings(branchId) có cache cho telegramController / mailer / reportScheduler.
// Độc lập hoàn toàn: không có cấu hình "global". Token/email creds để trống → fallback .env.
// ════════════════════════════════════════════════════════════════════
const mongoose = require('mongoose');
const SystemSetting = require('../models/SystemSetting');
const { logAction } = require('../utils/auditLogger');

// ── Cache theo từng chi nhánh ────────────────────────────────────────
const _cache = new Map();      // branchId -> { at, value }
const CACHE_TTL = 30 * 1000;

// Trả về cấu hình HIỆU LỰC của 1 chi nhánh (KHÔNG che secret — dùng nội bộ).
//   Token/email creds để trống → fallback .env (tuỳ chọn dùng chung).
//   enabled là per-branch (không fallback) → chi nhánh chưa bật thì không gửi.
async function getSettings(branchId) {
  const key = String(branchId || 'none');
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && now - hit.at < CACHE_TTL) return hit.value;

  let doc = null;
  try { if (branchId) doc = await SystemSetting.findOne({ branchId }).lean(); } catch { /* ignore */ }

  const tg = doc?.telegram || {};
  const em = doc?.email || {};
  const rp = doc?.reports || {};

  const value = {
    branchId: branchId || null,
    telegram: {
      enabled:  tg.enabled ?? false,
      botToken: tg.botToken || process.env.TELEGRAM_BOT_TOKEN || '',
      chatId:   tg.chatId   || process.env.TELEGRAM_CHAT_ID   || '',
    },
    email: {
      enabled:   em.enabled ?? false,
      host:      em.host   || process.env.SMTP_HOST || 'smtp.gmail.com',
      port:      em.port   || Number(process.env.SMTP_PORT) || 465,
      secure:    em.secure ?? true,
      user:      em.user   || process.env.SMTP_USER || '',
      pass:      em.pass   || process.env.SMTP_PASS || '',
      fromName:  em.fromName  || 'LuxHotel',
      fromEmail: em.fromEmail || em.user || process.env.SMTP_USER || '',
    },
    reports: {
      recipients: rp.recipients || [],
      daily: {
        enabled:         rp.daily?.enabled ?? false,
        time:            rp.daily?.time || '22:00',
        coversYesterday: rp.daily?.coversYesterday ?? false,
      },
      monthly: {
        enabled:    rp.monthly?.enabled ?? false,
        dayOfMonth: rp.monthly?.dayOfMonth || 1,
        time:       rp.monthly?.time || '08:00',
      },
    },
  };
  _cache.set(key, { at: now, value });
  return value;
}

// Xoá cache (1 chi nhánh hoặc tất cả)
function invalidateCache(branchId) {
  if (branchId) _cache.delete(String(branchId));
  else _cache.clear();
}

// ── Quyền truy cập theo chi nhánh ────────────────────────────────────
//   Admin: mọi chi nhánh (phải truyền branchId). Manager: chỉ chi nhánh của mình.
function resolveBranchId(req) {
  const q = req.query.branchId || req.body?.branchId;
  if (req.user?.role === 'Admin') return q || null;     // Admin chọn chi nhánh
  // Manager / khác: ép về chi nhánh của chính mình
  const own = req.user?.branchId;
  return own ? String(own) : null;
}

// ── Che secret ───────────────────────────────────────────────────────
const maskTail = (s) => {
  if (!s) return '';
  const str = String(s);
  return str.length <= 4 ? '••••' : `••••${str.slice(-4)}`;
};

// GET /api/settings?branchId= — trả cấu hình 1 chi nhánh (secret che)
const getPublicSettings = async (req, res, next) => {
  try {
    const branchId = resolveBranchId(req);
    if (!branchId || !mongoose.isValidObjectId(branchId)) {
      return res.status(400).json({ success: false, message: 'Thiếu hoặc sai branchId' });
    }
    const doc = await SystemSetting.getForBranch(branchId);
    res.json({
      success: true,
      data: {
        branchId,
        telegram: {
          enabled:   doc.telegram?.enabled ?? false,
          hasToken:  !!doc.telegram?.botToken,
          tokenMask: maskTail(doc.telegram?.botToken),
          chatId:    doc.telegram?.chatId || '',
        },
        email: {
          enabled:   doc.email?.enabled ?? false,
          host:      doc.email?.host || 'smtp.gmail.com',
          port:      doc.email?.port || 465,
          secure:    doc.email?.secure ?? true,
          user:      doc.email?.user || '',
          hasPass:   !!doc.email?.pass,
          passMask:  maskTail(doc.email?.pass),
          fromName:  doc.email?.fromName || 'LuxHotel',
          fromEmail: doc.email?.fromEmail || '',
        },
        reports: {
          recipients: doc.reports?.recipients || [],
          daily: {
            enabled:         doc.reports?.daily?.enabled ?? false,
            time:            doc.reports?.daily?.time || '22:00',
            coversYesterday: doc.reports?.daily?.coversYesterday ?? false,
          },
          monthly: {
            enabled:    doc.reports?.monthly?.enabled ?? false,
            dayOfMonth: doc.reports?.monthly?.dayOfMonth || 1,
            time:       doc.reports?.monthly?.time || '08:00',
          },
        },
        updatedAt: doc.updatedAt,
      },
    });
  } catch (err) { next(err); }
};

// PUT /api/settings — cập nhật cấu hình 1 chi nhánh. Secret để trống → giữ cũ.
const updateSettings = async (req, res, next) => {
  try {
    const branchId = resolveBranchId(req);
    if (!branchId || !mongoose.isValidObjectId(branchId)) {
      return res.status(400).json({ success: false, message: 'Thiếu hoặc sai branchId' });
    }
    const doc = await SystemSetting.getForBranch(branchId);
    const { telegram = {}, email = {}, reports } = req.body || {};

    // Telegram
    if (telegram.enabled !== undefined) doc.telegram.enabled = !!telegram.enabled;
    if (telegram.chatId  !== undefined) doc.telegram.chatId  = String(telegram.chatId).trim();
    if (telegram.botToken && telegram.botToken.trim() && !telegram.botToken.includes('••')) {
      doc.telegram.botToken = telegram.botToken.trim();
    }

    // Email
    if (email.enabled   !== undefined) doc.email.enabled   = !!email.enabled;
    if (email.host      !== undefined) doc.email.host      = String(email.host).trim();
    if (email.port      !== undefined) doc.email.port      = Number(email.port) || 465;
    if (email.secure    !== undefined) doc.email.secure    = !!email.secure;
    if (email.user      !== undefined) doc.email.user      = String(email.user).trim();
    if (email.fromName  !== undefined) doc.email.fromName  = String(email.fromName).trim();
    if (email.fromEmail !== undefined) doc.email.fromEmail = String(email.fromEmail).trim();
    if (email.pass && email.pass.trim() && !email.pass.includes('••')) {
      doc.email.pass = email.pass.trim();
    }

    // Reports
    if (reports) {
      if (Array.isArray(reports.recipients)) {
        doc.reports.recipients = reports.recipients.map(s => String(s).trim()).filter(Boolean);
      }
      if (reports.daily) {
        if (reports.daily.enabled         !== undefined) doc.reports.daily.enabled = !!reports.daily.enabled;
        if (reports.daily.time            !== undefined) doc.reports.daily.time = String(reports.daily.time).trim();
        if (reports.daily.coversYesterday !== undefined) doc.reports.daily.coversYesterday = !!reports.daily.coversYesterday;
      }
      if (reports.monthly) {
        if (reports.monthly.enabled    !== undefined) doc.reports.monthly.enabled = !!reports.monthly.enabled;
        if (reports.monthly.time       !== undefined) doc.reports.monthly.time = String(reports.monthly.time).trim();
        if (reports.monthly.dayOfMonth !== undefined) doc.reports.monthly.dayOfMonth = Math.min(28, Math.max(1, Number(reports.monthly.dayOfMonth) || 1));
      }
    }

    doc.updatedBy = req.user?.id || null;
    await doc.save();
    invalidateCache(branchId);

    // Nạp lại lịch cron báo cáo (toàn bộ chi nhánh)
    try {
      const { initReportSchedulers } = require('../utils/reportScheduler');
      await initReportSchedulers();
    } catch (e) {
      console.warn('[settings] reload report schedulers skipped:', e.message);
    }

    await logAction({
      entityType: 'SystemSetting', entityId: doc._id,
      action: 'update_settings',
      description: 'Cập nhật cấu hình hệ thống (Telegram / Email / Báo cáo)',
      user: req.user, branchId,
      metadata: { telegramEnabled: doc.telegram.enabled, emailEnabled: doc.email.enabled },
    });

    res.json({ success: true, message: 'Đã lưu cấu hình' });
  } catch (err) { next(err); }
};

// POST /api/settings/test-telegram — gửi tin thử bằng cấu hình chi nhánh
const testTelegram = async (req, res) => {
  try {
    const branchId = resolveBranchId(req);
    if (!branchId) return res.status(400).json({ success: false, message: 'Thiếu branchId' });
    invalidateCache(branchId);
    const cfg = (await getSettings(branchId)).telegram;
    if (!cfg.botToken || !cfg.chatId) {
      return res.status(400).json({ success: false, message: 'Chưa cấu hình Bot Token hoặc Chat ID' });
    }
    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: `✅ <b>Test Telegram</b>\nKết nối PMS → Telegram hoạt động.\n🕐 ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`,
        parse_mode: 'HTML',
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      return res.status(400).json({ success: false, message: `Telegram lỗi: ${data.description || r.status}` });
    }
    res.json({ success: true, message: 'Đã gửi tin nhắn test tới Telegram' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Lỗi gửi test' });
  }
};

// POST /api/settings/test-email — gửi mail thử (body: { to, branchId })
const testEmail = async (req, res) => {
  try {
    const branchId = resolveBranchId(req);
    if (!branchId) return res.status(400).json({ success: false, message: 'Thiếu branchId' });
    invalidateCache(branchId);
    const to = String(req.body?.to || '').trim();
    if (!to) return res.status(400).json({ success: false, message: 'Nhập email nhận thử' });

    const { sendMail } = require('../utils/mailer');
    await sendMail({
      to, branchId,
      subject: 'Test email từ LuxHotel PMS',
      html: `<p>Đây là email kiểm tra cấu hình SMTP của chi nhánh.</p><p>Thời gian: ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</p>`,
    });
    res.json({ success: true, message: `Đã gửi email test tới ${to}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Gửi email thất bại' });
  }
};

// POST /api/settings/send-report-now — gửi báo cáo ngay (test). Body: { type, branchId }
const sendReportNow = async (req, res) => {
  try {
    const branchId = resolveBranchId(req);
    if (!branchId) return res.status(400).json({ success: false, message: 'Thiếu branchId' });
    invalidateCache(branchId);
    const type = req.body?.type === 'monthly' ? 'monthly' : 'daily';
    const { sendDailyReport, sendMonthlyReport } = require('../utils/reportScheduler');
    if (type === 'monthly') await sendMonthlyReport(branchId);
    else await sendDailyReport(branchId, !!req.body?.coversYesterday);
    res.json({ success: true, message: `Đã gửi báo cáo ${type === 'monthly' ? 'tháng' : 'ngày'}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Gửi báo cáo thất bại' });
  }
};

module.exports = {
  getSettings, invalidateCache,
  getPublicSettings, updateSettings, testTelegram, testEmail, sendReportNow,
};