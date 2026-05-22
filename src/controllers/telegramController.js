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
  create:            'Tạo mới',
  create_group:      'Tạo nhóm đặt phòng',
  create_and_checkin:'Tạo & nhận phòng',
  // Nhận / trả phòng
  checkin:           'Nhận phòng',
  check_in:          'Nhận phòng',
  checkin_room:      'Nhận phòng',
  checkout:          'Trả phòng',
  checkout_room:     'Trả phòng',
  // Sửa
  update:            'Cập nhật',
  change_dates:      'Đổi ngày',
  change_policy:     'Đổi chính sách giá',
  update_service_qty:'Đổi số lượng dịch vụ',
  // Phòng
  move_room:         'Chuyển phòng',
  transfer:          'Chuyển phòng',
  split_room:        'Tách phòng',
  merge_group:       'Gộp nhóm',
  copy_to_branch:    'Sao chép sang chi nhánh',
  // Dịch vụ
  add_service:       'Thêm dịch vụ',
  remove_service:    'Bỏ dịch vụ',
  // Tiền
  payment:           'Thanh toán',
  edit_payment:      'Sửa thanh toán',
  cancel_payment:    'Huỷ thanh toán',
  refund:            'Hoàn tiền',
  apply_discount:    'Giảm giá',
  // Khác
  cancel:            'Huỷ',
  delete:            'Xoá',
  undo:              'Hoàn tác',
  login:             'Đăng nhập',
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
// ── Nhãn tiếng Việt cho từng field metadata (hiển thị mỗi dòng 1 nhãn) ──
//   Thứ tự khai báo = thứ tự ưu tiên hiển thị. Field không có trong map sẽ bị bỏ
//   (tránh hiển thị field kỹ thuật khó hiểu như subRoomId, customBreakdownLen...).
const FIELD_LABELS = {
  bookingCode:        'Mã đặt phòng',
  customerName:       'Khách hàng',
  roomNumber:         'Phòng',
  roomNumbers:        'Các phòng',
  roomCount:          'Số phòng',
  totalRooms:         'Số phòng',
  groupName:          'Tên nhóm',
  // chuyển phòng
  oldRoomNumber:      'Từ phòng',
  newRoomNumber:      'Sang phòng',
  fee:                'Phí',
  policyChanged:      'Đổi giá',
  reason:             'Lý do',
  // ngày giờ
  oldCheckIn:         'Nhận phòng (cũ)',
  oldCheckOut:        'Trả phòng (cũ)',
  checkIn:            'Nhận phòng',
  checkOut:           'Trả phòng',
  newCheckIn:         'Nhận phòng mới',
  newCheckOut:        'Trả phòng mới',
  actualCheckOut:     'Giờ trả thực tế',
  nights:             'Số đêm',
  // chính sách / giá
  policyName:         'Chính sách giá',
  // tiền
  amount:             'Số tiền',
  method:             'Hình thức',
  totalAmount:        'Tổng tiền',
  roomAmount:         'Tiền phòng',
  newRoomAmount:      'Tiền phòng mới',
  newTotal:           'Tổng mới',
  paymentStatus:      'Trạng thái TT',
  // giảm giá
  discountPercent:    'Giảm (%)',
  discountAmount:     'Giảm (số tiền)',
  totalDiscount:      'Tổng giảm',
  discountReason:     'Lý do giảm',
  discountChargedToName: 'Trừ vào',
  isFreeRoom:         'Miễn phí phòng',
  // huỷ / hoàn tác
  prevStatus:         'Trạng thái trước',
  status:             'Trạng thái',
  note:               'Ghi chú',
};

// Field là TIỀN (định dạng x.xxx đ)
const MONEY_FIELDS = new Set([
  'fee', 'amount', 'totalAmount', 'roomAmount', 'newRoomAmount', 'newTotal',
  'totalDiscount', 'discountAmount',
]);
// Field là NGÀY GIỜ
const DATE_FIELDS = new Set([
  'checkIn', 'checkOut', 'newCheckIn', 'newCheckOut', 'actualCheckOut',
  'oldCheckIn', 'oldCheckOut',
]);
// Field BOOLEAN → Có/Không
const BOOL_FIELDS = new Set(['policyChanged', 'isFreeRoom']);
// Map trạng thái → tiếng Việt
const STATUS_LABELS = {
  unpaid: 'Chưa thanh toán', partial: 'Một phần', paid: 'Đã thanh toán',
  pending: 'Chờ', confirmed: 'Đã xác nhận', checked_in: 'Đã nhận phòng',
  checked_out: 'Đã trả phòng', cancelled: 'Đã huỷ', no_show: 'Không đến',
};

const fmtMoney = (v) => `${new Intl.NumberFormat('vi-VN').format(Number(v) || 0)}đ`;
const fmtDate = (v) => {
  const d = new Date(v);
  if (isNaN(d.getTime())) return esc(String(v));
  return d.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric',
  });
};

// Format 1 giá trị metadata theo loại field
function fmtFieldValue(key, val) {
  if (val === null || val === undefined || val === '') return null;
  if (MONEY_FIELDS.has(key)) {
    if (!Number(val)) return null;   // bỏ tiền = 0
    return fmtMoney(val);
  }
  if (DATE_FIELDS.has(key)) return fmtDate(val);
  if (BOOL_FIELDS.has(key)) return val ? 'Có' : 'Không';
  if (key === 'paymentStatus' || key === 'status' || key === 'prevStatus') {
    return STATUS_LABELS[val] || esc(String(val));
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return null;
    return esc(val.join(', '));
  }
  if (key === 'discountPercent') return Number(val) ? `${val}%` : null;
  return esc(String(val));
}

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

  const lines = [];

  // Dòng 1: Chi nhánh (nếu có)
  if (branchName) lines.push(`<b>Chi nhánh:</b> ${branchName}`);

  // Dòng 2: Tiêu đề hành động (in hoa, đậm) + đường kẻ ngăn cách
  lines.push(`<b>${actionLabel.toUpperCase()}</b>`);
  lines.push(`=======================`);

  // (Bỏ dòng mô tả description — trùng lặp với các field chi tiết bên dưới)

  // ⭐ Gộp đổi phòng thành 1 dòng "Thay Đổi: cũ → mới" (thay vì 2 dòng riêng).
  const skipKeys = new Set();
  if (m.oldRoomNumber && m.newRoomNumber) {
    if (m.bookingCode) {
      lines.push(`<b>Mã đặt phòng:</b> <code>${esc(m.bookingCode)}</code>`);
    }
    lines.push(`<b>Thay Đổi:</b> ${esc(m.oldRoomNumber)} → ${esc(m.newRoomNumber)}`);
    skipKeys.add('oldRoomNumber');
    skipKeys.add('newRoomNumber');
    skipKeys.add('bookingCode');   // đã in ở trên
  }

  // ── Các dòng metadata: mỗi field 1 dòng có nhãn, theo thứ tự FIELD_LABELS ──
  for (const key of Object.keys(FIELD_LABELS)) {
    if (!(key in m)) continue;
    if (skipKeys.has(key)) continue;
    const valStr = fmtFieldValue(key, m[key]);
    if (valStr === null) continue;
    // bookingCode dùng <code> cho dễ copy
    if (key === 'bookingCode') {
      lines.push(`<b>${FIELD_LABELS[key]}:</b> <code>${valStr}</code>`);
    } else {
      lines.push(`<b>${FIELD_LABELS[key]}:</b> ${valStr}`);
    }
  }

  // Dòng cuối: người thực hiện + thời gian
  lines.push(`<b>Người thực hiện:</b> ${who}`);
  lines.push(`<b>Thời gian:</b> ${when}`);

  return lines.join('\n');
}

// ── Hàm public: đẩy 1 audit vào queue gửi Telegram (non-blocking) ─────
//   Gọi từ auditLogger sau khi ghi log thành công.
//   Tra tên chi nhánh từ branchId (nếu có) để hiển thị "Chi nhánh: ...".
function notifyAudit(audit) {
  if (!AUDIT_ENABLED || !isConfigured()) return;
  // Tra tên chi nhánh + tên thật người dùng (async, chạy nền — không chặn).
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

      // ⭐ Ưu tiên tên ĐẦY ĐỦ. Nếu userName trống/giống username → tra User lấy fullName.
      let userName = audit.userName || '';
      if (audit.userId) {
        try {
          const User = require('../models/User');
          const u = await User.findById(audit.userId).select('fullName username').lean();
          if (u?.fullName) userName = u.fullName;   // luôn ưu tiên fullName thật
        } catch { /* bỏ qua nếu tra lỗi */ }
      }

      // ⭐ Tự động bổ sung bookingCode + customerName nếu là Booking mà metadata chưa có
      //   (nhiều logAction cũ không truyền bookingCode → tra từ entityId).
      //   Hỗ trợ cả action trên Invoice (payment...) qua metadata.bookingId.
      let metadata = audit.metadata || {};
      const bookingRef = (audit.entityType === 'Booking' && audit.entityId)
        ? audit.entityId
        : (metadata.bookingId || null);
      if (bookingRef && (!metadata.bookingCode || !metadata.customerName)) {
        try {
          const Booking = require('../models/Booking');
          const bk = await Booking.findById(bookingRef).select('bookingCode customerName roomNumber').lean();
          if (bk) {
            metadata = {
              ...metadata,
              bookingCode: metadata.bookingCode || bk.bookingCode,
              customerName: metadata.customerName || bk.customerName,
              roomNumber: metadata.roomNumber || bk.roomNumber,
            };
          }
        } catch { /* bỏ qua nếu tra lỗi */ }
      }

      enqueueTelegram({
        text: formatAuditMessage({ ...audit, branchName, userName, metadata }),
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