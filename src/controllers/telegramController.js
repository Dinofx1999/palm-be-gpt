// backend/src/controllers/telegramController.js
// ════════════════════════════════════════════════════════════════════
// Telegram controller — gửi tin nhắn / ảnh qua Bot API + format audit log.
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
//
// ⚠️ CÀI: npm i form-data    (cần cho gửi ảnh từ disk)
// ════════════════════════════════════════════════════════════════════

const fs = require('fs');
const { enqueueTelegram, setSender, queueSize } = require('../utils/telegramQueue');

const BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID       = process.env.TELEGRAM_CHAT_ID || '';
const AUDIT_ENABLED = (process.env.TELEGRAM_AUDIT_ENABLED ?? 'true') !== 'false';

const isConfigured = () => !!(BOT_TOKEN && CHAT_ID);

// ── Sender TEXT (sendMessage) ─────────────────────────────────────────
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

// ── Sender PHOTO (sendPhoto + caption) ────────────────────────────────
//   Ưu tiên photoPath (file trên disk — luôn chạy được, không cần URL public).
//   Fallback photoUrl (URL công khai) nếu file không tồn tại.
async function sendToTelegramPhoto(job) {
  if (!isConfigured()) throw new Error('Telegram chưa cấu hình');
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;

  // Caption tối đa 1024 ký tự — cắt nếu dài
  const caption = (job.text || '').slice(0, 1024);

  let res;
  if (job.photoPath && fs.existsSync(job.photoPath)) {
    // ⭐ FIX 27/05/2026: dùng FormData + Blob NATIVE của Node 18+ (không dùng lib form-data
    //   vì stream của nó không tương thích với fetch global → Telegram trả 400 body rỗng).
    const buf = fs.readFileSync(job.photoPath);
    const filename = job.photoPath.split('/').pop() || 'photo.jpg';
    const ext = (filename.split('.').pop() || 'jpg').toLowerCase();
    const mime = ext === 'png' ? 'image/png'
              : ext === 'webp' ? 'image/webp'
              : 'image/jpeg';
    const form = new FormData();   // native (globalThis.FormData)
    form.append('chat_id',    String(job.chatId || CHAT_ID));
    form.append('caption',    caption);
    form.append('parse_mode', job.parseMode || 'HTML');
    form.append('photo',      new Blob([buf], { type: mime }), filename);
    res = await fetch(url, { method: 'POST', body: form });
  } else if (job.photoUrl) {
    // Gửi qua URL công khai (Telegram tự tải)
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    job.chatId || CHAT_ID,
        caption,
        parse_mode: job.parseMode || 'HTML',
        photo:      job.photoUrl,
      }),
    });
  } else {
    throw new Error('sendPhoto: thiếu photoPath hoặc photoUrl');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // ⭐ Log đầy đủ để debug khi 400 (Telegram thường trả "description" giải thích lý do)
    throw new Error(`Telegram sendPhoto ${res.status} ${res.statusText || ''}: ${body.slice(0, 400) || '(empty body)'}`);
  }
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram trả lỗi: ${JSON.stringify(data).slice(0, 400)}`);
  return data;
}

// ⭐ Đăng ký sender cho queue — phân biệt loại job ('photo' vs text mặc định)
setSender(async (job) => {
  if (job && job.kind === 'photo') return sendToTelegramPhoto(job);
  return sendToTelegram(job);
});

// ── Escape HTML cho parse_mode=HTML ───────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Map action → nhãn tiếng Việt ──────────────────────────────────────
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
  apply_career:      'Ứng tuyển',
  new_feedback: 'Góp ý mới',
};

// Action → nhãn tiếng Việt khi KHÔNG có trong map
function actionFallbackLabel(action) {
  const text = String(action || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return `• ${text}`;
}

const ENTITY_LABELS = {
  Booking: 'Đặt phòng', Invoice: 'Hoá đơn', Service: 'Dịch vụ',
  BookingService: 'Dịch vụ booking', Customer: 'Khách hàng', Room: 'Phòng',
  PricePolicy: 'Chính sách giá', Branch: 'Chi nhánh', User: 'Nhân viên',
  JobApplication: 'Ứng tuyển', Feedback: 'Góp ý',
};

// ── Nhãn tiếng Việt cho từng field metadata ───────────────────────────
//   Thứ tự khai báo = thứ tự ưu tiên hiển thị. Field không có trong map sẽ bị bỏ.
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
  // Ứng tuyển
  jobTitle:           'Vị trí ứng tuyển',
  fullName:           'Họ và tên',
  phone:              'Số điện thoại',
  email:              'Email',
  currentAddress:     'Địa chỉ hiện tại',
  birthDate:          'Ngày sinh',
  notes:              'Ghi chú',
   // Feedback
    overallRating:  'Đánh giá tổng',
    wouldRecommend: 'Sẽ giới thiệu',
    ratingsText:    'Chi tiết đánh giá',
    alert:          '⚠️ Cảnh báo',
};

// Field là TIỀN (định dạng x.xxx đ)
const MONEY_FIELDS = new Set([
  'fee', 'amount', 'totalAmount', 'roomAmount', 'newRoomAmount', 'newTotal',
  'totalDiscount', 'discountAmount',
]);
// Field là NGÀY GIỜ
const DATE_FIELDS = new Set([
  'checkIn', 'checkOut', 'newCheckIn', 'newCheckOut', 'actualCheckOut',
  'oldCheckIn', 'oldCheckOut', 'birthDate',
]);
// Field BOOLEAN → Có/Không
const BOOL_FIELDS = new Set(['policyChanged', 'isFreeRoom','wouldRecommend']);
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
    if (!Number(val)) return null;
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

  // Dòng 2: Tiêu đề hành động + đường kẻ ngăn cách
  lines.push(`<b>${actionLabel.toUpperCase()}</b>`);
  lines.push(`=======================`);

  // ⭐ Gộp đổi phòng thành 1 dòng "Thay Đổi: cũ → mới"
  const skipKeys = new Set();
  if (m.oldRoomNumber && m.newRoomNumber) {
    if (m.bookingCode) {
      lines.push(`<b>Mã đặt phòng:</b> <code>${esc(m.bookingCode)}</code>`);
    }
    lines.push(`<b>Thay Đổi:</b> ${esc(m.oldRoomNumber)} → ${esc(m.newRoomNumber)}`);
    skipKeys.add('oldRoomNumber');
    skipKeys.add('newRoomNumber');
    skipKeys.add('bookingCode');
  }

  // Các dòng metadata theo thứ tự FIELD_LABELS
  for (const key of Object.keys(FIELD_LABELS)) {
    if (!(key in m)) continue;
    if (skipKeys.has(key)) continue;
    const valStr = fmtFieldValue(key, m[key]);
    if (valStr === null) continue;
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

// ── Helper: chuẩn bị payload audit đầy đủ (tra branch/user/booking) ────
//   Trả về object đã enrich (branchName, userName, metadata) sẵn sàng format.
async function enrichAudit(audit) {
  let branchName = null;
  if (audit.branchId) {
    try {
      const Branch = require('../models/Branch');
      const br = await Branch.findById(audit.branchId).select('name').lean();
      branchName = br?.name || null;
    } catch { /* bỏ qua */ }
  }

  // Ưu tiên fullName thật từ User
  let userName = audit.userName || '';
  if (audit.userId) {
    try {
      const User = require('../models/User');
      const u = await User.findById(audit.userId).select('fullName username').lean();
      if (u?.fullName) userName = u.fullName;
    } catch { /* bỏ qua */ }
  }

  // Tự bổ sung bookingCode + customerName + roomNumber cho action Booking/Invoice
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
          bookingCode:  metadata.bookingCode  || bk.bookingCode,
          customerName: metadata.customerName || bk.customerName,
          roomNumber:   metadata.roomNumber   || bk.roomNumber,
        };
      }
    } catch { /* bỏ qua */ }
  }

  return { ...audit, branchName, userName, metadata };
}

// ── Public: gửi audit dạng TEXT (không ảnh) ───────────────────────────
function notifyAudit(audit) {
  if (!AUDIT_ENABLED || !isConfigured()) return;
  (async () => {
    try {
      const enriched = await enrichAudit(audit);
      enqueueTelegram({
        text: formatAuditMessage(enriched),
        parseMode: 'HTML',
      });
    } catch (err) {
      console.error('[telegram] notifyAudit error (non-fatal):', err.message);
    }
  })();
}

// ── Public: gửi audit KÈM ẢNH ─────────────────────────────────────────
//   photoPath: đường dẫn file trên disk (ưu tiên).
//   photoUrl:  URL công khai (fallback nếu không có photoPath).
//   Nếu cả 2 đều thiếu → tự fallback gửi text thường (không lỗi).
function notifyAuditWithPhoto(audit, photoPath, photoUrl) {
  if (!AUDIT_ENABLED || !isConfigured()) return;
  (async () => {
    try {
      const enriched = await enrichAudit(audit);
      const text = formatAuditMessage(enriched);

      const hasFile = photoPath && fs.existsSync(photoPath);
      if (hasFile || photoUrl) {
        enqueueTelegram({
          kind: 'photo',
          photoPath: hasFile ? photoPath : undefined,
          photoUrl:  hasFile ? undefined : photoUrl,
          text,
          parseMode: 'HTML',
        });
      } else {
        // Không có ảnh → gửi text thường
        enqueueTelegram({ text, parseMode: 'HTML' });
      }
    } catch (err) {
      console.error('[telegram] notifyAuditWithPhoto error (non-fatal):', err.message);
    }
  })();
}

// ── Public: gửi tin nhắn tự do (non-blocking) ─────────────────────────
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
  notifyAuditWithPhoto,
  sendMessage,
  formatAuditMessage,
  isConfigured,
  // express handlers
  testSend,
  status,
};