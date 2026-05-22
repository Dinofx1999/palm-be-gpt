// backend/src/controllers/telegramController.js
// ════════════════════════════════════════════════════════════════════
// Telegram controller — gửi tin nhắn qua Bot API + format audit log.
//
// CẤU HÌNH (.env):
//   TELEGRAM_BOT_TOKEN=123456:ABC...        ← token bot (lấy từ @BotFather)
//   TELEGRAM_CHAT_ID=-1001234567890         ← id group/kênh nhận (hoặc id user)
//   TELEGRAM_AUDIT_ENABLED=true             ← bật/tắt gửi audit (mặc định true nếu có token)
//
// CÁCH LẤY CHAT_ID:
//   1. Tạo bot qua @BotFather → lấy token
//   2. Thêm bot vào group, gửi 1 tin bất kỳ trong group
//   3. Mở https://api.telegram.org/bot<TOKEN>/getUpdates → tìm "chat":{"id":...}
//
// Endpoint (gắn route nếu muốn test từ PMS):
//   POST /api/telegram/test     — gửi tin thử (Admin)
//   GET  /api/telegram/status   — xem cấu hình + kích thước queue
// ════════════════════════════════════════════════════════════════════

const { enqueueTelegram, setSender, queueSize } = require('../utils/telegramQueue');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID || '';
const AUDIT_ENABLED = (process.env.TELEGRAM_AUDIT_ENABLED ?? 'true') !== 'false';

const isConfigured = () => !!(BOT_TOKEN && CHAT_ID);

// ── Sender thực tế (queue gọi hàm này) ────────────────────────────────
async function sendToTelegram(job) {
  if (!isConfigured()) throw new Error('Telegram chưa cấu hình (thiếu BOT_TOKEN/CHAT_ID)');

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: job.chatId || CHAT_ID,
      text: job.text,
      parse_mode: job.parseMode || 'HTML',
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 429 = rate limit → throw để queue retry
    throw new Error(`Telegram API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram trả lỗi: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// Đăng ký sender cho queue (1 lần khi load module)
setSender(sendToTelegram);

// ── Escape HTML cho parse_mode=HTML ───────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Map action → nhãn tiếng Việt + icon ───────────────────────────────
const ACTION_LABELS = {
  // Tạo
  create:            '🟢 Tạo mới',
  create_group:      '🟢 Tạo nhóm đặt phòng',
  create_and_checkin:'🟢 Tạo & nhận phòng',
  // Nhận / trả phòng
  checkin:           '🛎️ Nhận phòng',
  check_in:          '🛎️ Nhận phòng',
  checkin_room:      '🛎️ Nhận phòng',
  checkout:          '🧳 Trả phòng',
  checkout_room:     '🧳 Trả phòng',
  // Sửa
  update:            '✏️ Cập nhật',
  change_dates:      '📅 Đổi ngày',
  change_policy:     '📋 Đổi chính sách giá',
  update_service_qty:'🔢 Đổi số lượng dịch vụ',
  // Phòng
  move_room:         '🔄 Chuyển phòng',
  transfer:          '🔄 Chuyển phòng',
  split_room:        '🔀 Tách phòng',
  merge_group:       '🔗 Gộp nhóm',
  copy_to_branch:    '📑 Sao chép sang chi nhánh',
  // Dịch vụ
  add_service:       '➕ Thêm dịch vụ',
  remove_service:    '➖ Bỏ dịch vụ',
  // Tiền
  payment:           '💰 Thanh toán',
  edit_payment:      '💳 Sửa thanh toán',
  cancel_payment:    '🚫 Huỷ thanh toán',
  refund:            '↩️ Hoàn tiền',
  apply_discount:    '🏷️ Giảm giá',
  // Khác
  cancel:            '❌ Huỷ',
  delete:            '🗑️ Xoá',
  undo:              '⏪ Hoàn tác',
  login:             '🔓 Đăng nhập',
};

// Action → nhãn tiếng Việt khi KHÔNG có trong map (fallback gọn, không icon máy móc)
function actionFallbackLabel(action) {
  const text = String(action || '')
    .replace(/_/g, ' ')                         // create_and_checkin → "create and checkin"
    .replace(/\b\w/g, (c) => c.toUpperCase());  // → "Create And Checkin"
  return `• ${text}`;
}

const ENTITY_LABELS = {
  Booking: 'Đặt phòng', Invoice: 'Hoá đơn', Service: 'Dịch vụ',
  BookingService: 'Dịch vụ booking', Customer: 'Khách hàng', Room: 'Phòng',
  PricePolicy: 'Chính sách giá', Branch: 'Chi nhánh', User: 'Nhân viên',
};

// ── Format 1 audit log thành tin nhắn Telegram (HTML) ─────────────────
function formatAuditMessage(audit) {
  const actionLabel = ACTION_LABELS[audit.action] || actionFallbackLabel(audit.action);
  const entityLabel = ENTITY_LABELS[audit.entityType] || esc(audit.entityType);
  const who  = audit.userName ? esc(audit.userName) : 'Hệ thống';
  const when = new Date().toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric',
  });
  const m = audit.metadata || {};
  const branchName = audit.branchName ? esc(audit.branchName) : null;

  // ════════════════════════════════════════════════════════════════════
  // Format CHI TIẾT riêng cho CHUYỂN PHÒNG (mỗi thông tin 1 dòng, dễ nhìn)
  // ════════════════════════════════════════════════════════════════════
  if (audit.action === 'move_room') {
    const lines = [];
    if (branchName) lines.push(`🏨 <b>Chi nhánh:</b> ${branchName}`);
    lines.push(`🔄 <b>Chuyển phòng</b>`);
    if (m.oldRoomNumber && m.newRoomNumber) {
      lines.push(`🚪 <b>Phòng:</b> ${esc(m.oldRoomNumber)} → ${esc(m.newRoomNumber)}`);
    }
    if (m.bookingCode) lines.push(`📋 <b>Mã đặt phòng:</b> <code>${esc(m.bookingCode)}</code>`);
    if (m.fee && m.fee > 0) lines.push(`💵 <b>Phí:</b> ${new Intl.NumberFormat('vi-VN').format(m.fee)}đ`);
    lines.push(`💲 <b>Đổi giá:</b> ${m.policyChanged ? 'Có' : 'Không'}`);
    if (m.reason) lines.push(`📝 <b>Lý do:</b> ${esc(m.reason)}`);
    lines.push(`👤 <b>Người thực hiện:</b> ${who}`);
    lines.push(`🕐 <b>Thời gian:</b> ${when}`);
    return lines.join('\n');
  }

  // ── Format mặc định (các action khác) ──
  const lines = [];
  if (branchName) lines.push(`🏨 ${branchName}`);
  // Dòng tiêu đề: hành động + đối tượng
  lines.push(`<b>${actionLabel}</b>  ·  ${entityLabel}`);

  // Mô tả (nếu có) — dòng nội dung chính
  if (audit.description) lines.push(esc(audit.description));

  // Metadata hữu ích — gom 1 dòng "chi tiết" cho gọn
  const details = [];
  if (m.bookingCode) details.push(`Mã <code>${esc(m.bookingCode)}</code>`);
  if (m.roomNumber)  details.push(`Phòng ${esc(m.roomNumber)}`);
  if (m.amount)      details.push(`${new Intl.NumberFormat('vi-VN').format(m.amount)}đ`);
  if (details.length) lines.push(details.join('  •  '));

  // Dòng cuối: ai + khi nào (gộp 1 dòng, chữ nhỏ kiểu phụ chú)
  lines.push(`<i>${who} · ${when}</i>`);

  return lines.join('\n');
}

// ── Hàm public: đẩy 1 audit vào queue gửi Telegram (non-blocking) ─────
//   Gọi từ auditLogger sau khi ghi log thành công.
//   Tra tên chi nhánh từ branchId (nếu có) để hiển thị "Chi nhánh: ...".
function notifyAudit(audit) {
  if (!AUDIT_ENABLED || !isConfigured()) return;
  // Tra tên chi nhánh async rồi mới enqueue (không chặn — chạy nền).
  (async () => {
    try {
      let branchName = null;
      if (audit.branchId) {
        try {
          const Branch = require('../models/Branch');
          const br = await Branch.findById(audit.branchId).select('name').lean();
          branchName = br?.name || null;
        } catch { /* bỏ qua nếu tra lỗi */ }
      }
      enqueueTelegram({
        text: formatAuditMessage({ ...audit, branchName }),
        parseMode: 'HTML',
      });
    } catch (err) {
      console.error('[telegram] notifyAudit error (non-fatal):', err.message);
    }
  })();
}

// ── Hàm public: gửi tin nhắn tự do (non-blocking) ─────────────────────
function sendMessage(text, opts = {}) {
  if (!isConfigured()) return false;
  return enqueueTelegram({ text, parseMode: opts.parseMode || 'HTML', chatId: opts.chatId });
}

// ════════════════════════════════════════════════════════════════════
// EXPRESS HANDLERS (tuỳ chọn — gắn route nếu muốn test/giám sát từ PMS)
// ════════════════════════════════════════════════════════════════════

// POST /api/telegram/test
async function testSend(req, res) {
  if (!isConfigured()) {
    return res.status(400).json({ success: false, message: 'Chưa cấu hình TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID' });
  }
  const text = (req.body?.text && String(req.body.text)) ||
    `✅ <b>Test Telegram</b>\nKết nối PMS → Telegram hoạt động.\n🕐 ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`;
  enqueueTelegram({ text, parseMode: 'HTML' });
  return res.json({ success: true, message: 'Đã đưa tin nhắn test vào hàng đợi', data: { queued: queueSize() } });
}

// GET /api/telegram/status
function status(req, res) {
  return res.json({
    success: true,
    data: {
      configured:   isConfigured(),
      auditEnabled: AUDIT_ENABLED,
      hasToken:     !!BOT_TOKEN,
      hasChatId:    !!CHAT_ID,
      queueSize:    queueSize(),
    },
  });
}

module.exports = {
  notifyAudit,
  sendMessage,
  formatAuditMessage,
  isConfigured,
  // express handlers
  testSend,
  status,
};