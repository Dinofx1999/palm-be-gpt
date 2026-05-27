// backend/src/controllers/feedbackController.js
const Feedback        = require('../models/Feedback');
const FeedbackBlock   = require('../models/FeedbackBlock');
const FeedbackCategory = require('../models/FeedbackCategory');
const Booking         = require('../models/Booking');

// ── Helpers ─────────────────────────────────────────────
const sanitize = (s, max = 1000) => {
  if (typeof s !== 'string') return '';
  return s.replace(/<[^>]*>/g, '').trim().slice(0, max);
};
const isValidPhone = (p) => p && /^\d{9,15}$/.test(String(p).replace(/[\s+\-()]/g, ''));
const isValidEmail = (e) => !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const normalizePhone = (p) => String(p || '').replace(/[\s+\-()]/g, '').trim();
const getClientIp = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim()
  || req.socket?.remoteAddress || req.ip || 'unknown';

// ── In-memory rate limit (theo IP) ──────────────────────
const rateLimitMap = new Map();
const checkRateLimit = (key, max, windowMs) => {
  const now = Date.now();
  const e = rateLimitMap.get(key);
  if (!e || now > e.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }
  if (e.count >= max) return { allowed: false, retryAfter: Math.ceil((e.resetAt - now) / 1000) };
  e.count++;
  return { allowed: true };
};
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap.entries()) if (now > v.resetAt) rateLimitMap.delete(k);
}, 10 * 60 * 1000);

// ═══════════════════════════════════════════════════════
// PUBLIC: GET /api/public/feedback/categories?branchId=
// ═══════════════════════════════════════════════════════
exports.getPublicCategories = async (req, res, next) => {
  try {
    const cats = await FeedbackCategory.find({ active: true })
      .sort({ order: 1, createdAt: 1 })
      .select('key label order')
      .lean();
    res.json({ success: true, data: cats });
  } catch (e) { next(e); }
};

// ═══════════════════════════════════════════════════════
// PUBLIC: POST /api/public/feedback/submit
// ═══════════════════════════════════════════════════════
exports.submitFeedback = async (req, res, next) => {
  try {
    const ip = getClientIp(req);

    // Rate limit: 3 góp ý / giờ / IP
    const rl = checkRateLimit(`feedback:${ip}`, 3, 60 * 60 * 1000);
    if (!rl.allowed) {
      return res.status(429).json({
        success: false,
        message: `Bạn gửi góp ý quá nhiều lần. Thử lại sau ${Math.ceil(rl.retryAfter / 60)} phút.`,
        code: 'RATE_LIMIT_EXCEEDED',
      });
    }

    const {
      branchId, customerName, phone, roomNumber, email,
      bookingCode, stayDate,
      ratings, overallRating, wouldRecommend, content,
      _hp,   // honeypot
    } = req.body || {};

    // Honeypot — bot điền field ẩn → giả vờ thành công
    if (_hp && String(_hp).trim().length > 0) {
      console.warn('[feedback] Honeypot triggered, IP:', ip);
      return res.json({ success: true, message: 'Đã nhận góp ý. Cảm ơn quý khách!' });
    }

    // Validate bắt buộc
    if (!branchId)   return res.status(400).json({ success: false, message: 'Thiếu chi nhánh',   code: 'MISSING_BRANCH' });
    if (!phone || !isValidPhone(phone))
      return res.status(400).json({ success: false, message: 'Số điện thoại không hợp lệ', code: 'INVALID_PHONE' });
    if (!roomNumber) return res.status(400).json({ success: false, message: 'Vui lòng nhập số phòng', code: 'MISSING_ROOM' });
    if (email && !isValidEmail(email))
      return res.status(400).json({ success: false, message: 'Email không hợp lệ', code: 'INVALID_EMAIL' });

    const phoneNorm = normalizePhone(phone);

    // ⭐ Check blocked phone — trả 200 thành công giả để spammer không biết
    const blocked = await FeedbackBlock.findOne({ phone: phoneNorm }).lean();
    if (blocked) {
      console.warn('[feedback] Blocked phone tried to submit:', phoneNorm);
      return res.json({ success: true, message: 'Đã nhận góp ý. Cảm ơn quý khách!' });
    }

    // ⭐ Chống trùng: cùng SĐT + cùng phòng + 7 ngày → 1 góp ý
    const recent = await Feedback.findOne({
      phone: phoneNorm,
      roomNumber: String(roomNumber).trim(),
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    }).select('_id').lean();
    if (recent) {
      return res.status(400).json({
        success: false,
        message: 'Bạn đã gửi góp ý cho phòng này gần đây. Cảm ơn quý khách.',
        code: 'DUPLICATE_FEEDBACK',
      });
    }

    // Validate ratings
    const safeRatings = [];
    if (Array.isArray(ratings)) {
      const activeCats = await FeedbackCategory.find({ active: true }).select('key').lean();
      const validKeys = new Set(activeCats.map(c => c.key));
      for (const r of ratings) {
        const key = String(r?.categoryKey || '').toLowerCase().trim();
        const score = Number(r?.score);
        if (validKeys.has(key) && score >= 1 && score <= 5) {
          safeRatings.push({ categoryKey: key, score });
        }
      }
    }
    const safeOverall = (overallRating && Number(overallRating) >= 1 && Number(overallRating) <= 5)
      ? Number(overallRating) : null;

    // ⭐ Tự link booking: SĐT + roomNumber + trong 30 ngày
    let bookingId = null, linkedStayDate = stayDate ? new Date(stayDate) : null;
    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const bk = await Booking.findOne({
        branchId,
        phone: { $in: [phoneNorm, phone] },
        roomNumber: String(roomNumber).trim(),
        createdAt: { $gte: since },
      }).sort({ createdAt: -1 }).select('_id checkIn checkOut').lean();
      if (bk) {
        bookingId = bk._id;
        if (!linkedStayDate) linkedStayDate = bk.checkIn || bk.checkOut || null;
      }
    } catch { /* không lỗi nếu schema Booking khác */ }

    const doc = await Feedback.create({
      branchId,
      customerName:  sanitize(customerName, 100),
      phone:         phoneNorm,
      roomNumber:    sanitize(String(roomNumber), 20),
      email:         email ? String(email).trim().toLowerCase() : '',
      bookingCode:   sanitize(bookingCode, 50),
      bookingId,
      stayDate:      linkedStayDate,
      ratings:       safeRatings,
      overallRating: safeOverall,
      wouldRecommend: typeof wouldRecommend === 'boolean' ? wouldRecommend : null,
      content:       sanitize(content, 3000),
      status:        'new',
      sourceIp:      ip,
      userAgent:     (req.headers['user-agent'] || '').slice(0, 500),
    });

    // ⭐ Telegram (non-blocking) — rating thấp (≤2) prefix cảnh báo
    try {
      const tg = require('./telegramController');
      const avg = doc.avgScore;
      const lowRating = avg !== null && avg <= 2;
      tg.notifyAudit({
        action:     'new_feedback',
        entityType: 'Feedback',
        entityId:   doc._id,
        branchId,
        userName:   doc.customerName || 'Khách',
        metadata: {
          customerName:  doc.customerName,
          phone:         doc.phone,
          roomNumber:    doc.roomNumber,
          email:         doc.email,
          bookingCode:   doc.bookingCode,
          overallRating: avg !== null ? `${avg}/5 ⭐` : '',
          wouldRecommend: doc.wouldRecommend,
          ratingsText:   doc.ratings.map(r => `${r.categoryKey}: ${r.score}⭐`).join(' · '),
          content:       doc.content,
          alert:         lowRating ? '⚠️ RATING THẤP — cần xử lý' : '',
        },
      });
    } catch (e) {
      console.error('[feedback] Telegram notify failed (non-fatal):', e.message);
    }

    res.status(201).json({
      success: true,
      message: 'Cảm ơn quý khách đã góp ý. Chúng tôi rất trân trọng phản hồi của bạn.',
      data: { id: doc._id },
    });
  } catch (e) {
    console.error('[feedback/submit] Error:', e);
    next(e);
  }
};

// ═══════════════════════════════════════════════════════
// ADMIN: GET /api/feedback?branchId=&status=&minRating=&page=&limit=
// ═══════════════════════════════════════════════════════
exports.listFeedback = async (req, res, next) => {
  try {
    const { branchId, status, minRating, q } = req.query;
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const filter = {};
    if (branchId)  filter.branchId = branchId;
    if (status)    filter.status = status;
    if (q) {
      const safe = String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { customerName: new RegExp(safe, 'i') },
        { phone:        new RegExp(safe, 'i') },
        { roomNumber:   new RegExp(safe, 'i') },
        { content:      new RegExp(safe, 'i') },
      ];
    }
    if (minRating)  filter.overallRating = { $lte: Number(minRating) };   // lọc rating THẤP

    const [items, total] = await Promise.all([
      Feedback.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit).limit(limit)
        .populate('repliedBy', 'fullName username')
        .populate('bookingId', 'bookingCode checkIn checkOut')
        .lean({ virtuals: true }),
      Feedback.countDocuments(filter),
    ]);

    res.json({ success: true, data: { items, total, page, limit } });
  } catch (e) { next(e); }
};

// GET /api/feedback/:id
exports.getFeedback = async (req, res, next) => {
  try {
    const doc = await Feedback.findById(req.params.id)
      .populate('repliedBy', 'fullName username')
      .populate('bookingId', 'bookingCode checkIn checkOut customerName')
      .lean({ virtuals: true });
    if (!doc) return res.status(404).json({ success: false, message: 'Không tìm thấy góp ý' });
    res.json({ success: true, data: doc });
  } catch (e) { next(e); }
};

// PATCH /api/feedback/:id  — đổi status, ghi staffReply
exports.updateFeedback = async (req, res, next) => {
  try {
    const { status, staffReply } = req.body || {};
    const update = {};
    if (status && ['new', 'read', 'resolved', 'spam'].includes(status)) update.status = status;
    if (typeof staffReply === 'string') {
      update.staffReply = sanitize(staffReply, 3000);
      update.repliedBy  = req.user?.id || null;
      update.repliedAt  = new Date();
    }
    const doc = await Feedback.findByIdAndUpdate(req.params.id, { $set: update }, { new: true })
      .populate('repliedBy', 'fullName username').lean({ virtuals: true });
    if (!doc) return res.status(404).json({ success: false, message: 'Không tìm thấy góp ý' });
    res.json({ success: true, data: doc, message: 'Đã cập nhật' });
  } catch (e) { next(e); }
};

// DELETE /api/feedback/:id
exports.deleteFeedback = async (req, res, next) => {
  try {
    const r = await Feedback.findByIdAndDelete(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: 'Không tìm thấy góp ý' });
    res.json({ success: true, message: 'Đã xoá' });
  } catch (e) { next(e); }
};

// ═══════════════════════════════════════════════════════
// ADMIN: CATEGORIES
// ═══════════════════════════════════════════════════════
exports.listCategories = async (_req, res, next) => {
  try {
    const cats = await FeedbackCategory.find().sort({ order: 1, createdAt: 1 }).lean();
    res.json({ success: true, data: cats });
  } catch (e) { next(e); }
};

exports.createCategory = async (req, res, next) => {
  try {
    const { key, label, order, active } = req.body || {};
    if (!key || !label) return res.status(400).json({ success: false, message: 'Thiếu key hoặc label' });
    const doc = await FeedbackCategory.create({
      key: String(key).toLowerCase().trim(),
      label: sanitize(label, 100),
      order: Number(order) || 0,
      active: active !== false,
    });
    res.status(201).json({ success: true, data: doc });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'Key đã tồn tại' });
    next(e);
  }
};

exports.updateCategory = async (req, res, next) => {
  try {
    const { label, order, active } = req.body || {};
    const update = {};
    if (label !== undefined)  update.label = sanitize(label, 100);
    if (order !== undefined)  update.order = Number(order) || 0;
    if (active !== undefined) update.active = !!active;
    const doc = await FeedbackCategory.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!doc) return res.status(404).json({ success: false, message: 'Không tìm thấy hạng mục' });
    res.json({ success: true, data: doc });
  } catch (e) { next(e); }
};

exports.deleteCategory = async (req, res, next) => {
  try {
    const r = await FeedbackCategory.findByIdAndDelete(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: 'Không tìm thấy hạng mục' });
    res.json({ success: true, message: 'Đã xoá' });
  } catch (e) { next(e); }
};

// ═══════════════════════════════════════════════════════
// ADMIN: BLOCKED PHONES
// ═══════════════════════════════════════════════════════
exports.listBlocks = async (_req, res, next) => {
  try {
    const items = await FeedbackBlock.find().sort({ createdAt: -1 })
      .populate('blockedBy', 'fullName username').lean();
    res.json({ success: true, data: items });
  } catch (e) { next(e); }
};

exports.createBlock = async (req, res, next) => {
  try {
    const { phone, reason } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, message: 'Thiếu số điện thoại' });
    const phoneNorm = normalizePhone(phone);
    const doc = await FeedbackBlock.create({
      phone:     phoneNorm,
      reason:    sanitize(reason, 500),
      blockedBy: req.user?.id || null,
    });
    res.status(201).json({ success: true, data: doc, message: 'Đã chặn SĐT' });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: 'SĐT đã bị chặn trước đó' });
    next(e);
  }
};

exports.deleteBlock = async (req, res, next) => {
  try {
    const r = await FeedbackBlock.findByIdAndDelete(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: 'Không tìm thấy bản ghi' });
    res.json({ success: true, message: 'Đã gỡ chặn' });
  } catch (e) { next(e); }
};