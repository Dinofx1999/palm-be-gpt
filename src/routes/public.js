// backend/src/routes/public.js
// ════════════════════════════════════════════════════════════════════
// PUBLIC API — KHÔNG yêu cầu đăng nhập (cho landing page / khách vãng lai)
//
//   POST /api/public/availability  → đếm phòng trống (branch + loại + ngày)
//   POST /api/public/bookings      → tạo booking 'reserved' + tự chọn phòng trống
//
// (branches & room-types: dùng GET /api/branches, /api/room-types sau khi
//  bỏ authenticate ở 2 route đó — xem hướng dẫn deploy)
//
// Gắn vào index.js:  app.use('/api/public', require('./routes/public'));
//
// LƯU Ý:
//   - KHÔNG mount authenticate (API công khai)
//   - Conflict logic + calculatePrice khớp với bookingController thật
//   - Tạo Booking với đủ field bắt buộc: customerName, roomId, roomNumber,
//     roomType, branchId, checkIn, checkOut, nights, roomAmount
//   - status='reserved', source='Website' → lễ tân thấy trong PMS để xác nhận
//   - Rate-limit 5 booking/giờ/IP chống spam
// ════════════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();

const Room          = require('../models/Room');
const Booking       = require('../models/Booking');
const Branch        = require('../models/Branch');
const Customer      = require('../models/Customer');
const PricePolicy   = require('../models/PricePolicy');
const PaymentMethod = require('../models/PaymentMethod');
const Invoice       = require('../models/Invoice');
const User          = require('../models/User');

// Cache user hệ thống (Admin/Manager) để gán issuedBy cho invoice web.
//   Lý do: Transaction.recordedBy là required. SePay ghi tiền với userId=null,
//   nên recorder lấy từ invoice.issuedBy. Booking web không có user đăng nhập →
//   cần gán 1 user hệ thống, nếu không syncInvoicePayment fail (không tạo Transaction).
let _systemUserCache = { id: null, at: 0 };
async function resolveSystemUserId(branchId) {
  // Cache 5 phút
  if (_systemUserCache.id && Date.now() - _systemUserCache.at < 300000) {
    return _systemUserCache.id;
  }
  try {
    // Ưu tiên Admin/Manager cùng chi nhánh, fallback bất kỳ Admin
    let u = await User.findOne({
      role: { $in: ['Admin', 'Manager'] },
      branchId,
    }).select('_id').lean();
    if (!u) u = await User.findOne({ role: 'Admin' }).select('_id').lean();
    if (!u) u = await User.findOne({}).select('_id').lean();   // cùng đường mới có
    const id = u?._id ?? null;
    _systemUserCache = { id, at: Date.now() };
    return id;
  } catch (e) {
    console.warn('[public] resolveSystemUserId failed:', e.message);
    return null;
  }
}

// ─── Thời gian giữ chỗ trước khi tự huỷ (phút) ───
const HOLD_MINUTES = 3;

// ─── Map tên ngân hàng → BIN (cho VietQR) khi paymentMethod thiếu bankBin ───
const BANK_BIN_MAP = {
  vietcombank: '970436', vcb: '970436',
  mbbank: '970422', mb: '970422',
  techcombank: '970407', tcb: '970407',
  acb: '970416', bidv: '970418',
  vpbank: '970432', vpb: '970432',
  tpbank: '970423', vietinbank: '970415', ctg: '970415',
  sacombank: '970403', agribank: '970405',
  ocb: '970448', msb: '970426',
};

// Lấy thông tin tài khoản nhận tiền (cho QR) từ paymentMethods type=transfer.
// Trả { bankBin, accountNo, accountName, bankName } hoặc null nếu chưa cấu hình.
async function resolveBankInfo() {
  try {
    const methods = await PaymentMethod.find({ type: 'transfer', isActive: true }).lean();
    const m = methods.find((p) => p.bankInfo && p.bankInfo.accountNumber);
    if (!m) return null;
    const info = m.bankInfo;
    const bin = info.bankBin
      || BANK_BIN_MAP[String(info.bankName || '').toLowerCase().replace(/\s+/g, '')];
    if (!bin) return null;
    return {
      bankBin: bin,
      accountNo: info.accountNumber,
      accountName: info.accountHolder || '',
      bankName: info.bankName || '',
    };
  } catch (e) {
    console.warn('[public] resolveBankInfo failed:', e.message);
    return null;
  }
}

// Sinh URL ảnh VietQR (tự điền số tiền + nội dung = bookingCode)
function buildQrUrl(bankInfo, amount, addInfo) {
  if (!bankInfo) return '';
  return `https://img.vietqr.io/image/${bankInfo.bankBin}-${bankInfo.accountNo}-compact2.png`
    + `?amount=${Math.round(amount)}`
    + `&addInfo=${encodeURIComponent(addInfo)}`
    + `&accountName=${encodeURIComponent(bankInfo.accountName)}`;
}

// ════════════════════════════════════════════════════════════════════
// AUTO-CANCEL: huỷ booking 'reserved' từ Website quá HOLD_MINUTES chưa thanh toán
//   Quét mỗi 60s. Đổi status='cancelled', nhả phòng (currentBookingId=null).
// ════════════════════════════════════════════════════════════════════
async function sweepExpiredBookings() {
  try {
    const cutoff = new Date(Date.now() - HOLD_MINUTES * 60 * 1000);
    // Booking website 'reserved' tạo quá HOLD_MINUTES trước
    const candidates = await Booking.find({
      status: 'reserved',
      source: 'Website',
      createdAt: { $lt: cutoff },
    }).select('_id roomId rooms').lean();

    for (const bk of candidates) {
      // ⭐ Kiểm tra Invoice: nếu đã có tiền vào (SePay ghi) thì KHÔNG huỷ.
      //   /sepay/match cập nhật invoice.paidAmount, không đụng booking.paymentStatus.
      const inv = await Invoice.findOne({ bookingId: bk._id }).select('paidAmount').lean();
      if (inv && (inv.paidAmount || 0) > 0) continue;   // đã thanh toán (dù 1 phần) → giữ lại

      await Booking.findByIdAndUpdate(bk._id, {
        status: 'cancelled',
        cancelReason: 'Tự huỷ: quá hạn thanh toán (giữ chỗ 10 phút)',
        cancelledAt: new Date(),
      });
      // Nhả phòng đã giữ
      const roomIds = [];
      if (bk.roomId) roomIds.push(bk.roomId);
      if (Array.isArray(bk.rooms)) for (const r of bk.rooms) if (r.roomId) roomIds.push(r.roomId);
      for (const rid of roomIds) {
        await Room.findOneAndUpdate(
          { _id: rid, currentBookingId: bk._id },
          { currentBookingId: null, currentGuestName: '' }
        ).catch(() => {});
      }
      console.log(`[public] Auto-huỷ booking quá hạn: ${bk._id}`);
    }
  } catch (e) {
    console.error('[public] sweepExpiredBookings error:', e.message);
  }
}
// Chạy nền: mỗi 60s
setInterval(sweepExpiredBookings, 60 * 1000);

// Calculator giá thật (giống bookingController). Fallback nếu thiếu.
let calculatePrice = null;
try { ({ calculatePrice } = require('../utils/priceCalculator')); }
catch (e) { console.warn('[public] priceCalculator not found — dùng dayPrice × nights'); }

const fmt = (n) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n || 0);

// ─── Rate limit nhẹ theo IP cho booking ───
const bookingHits = new Map();
const BOOK_PER_HOUR = 5;
function bookingRateOk(ip) {
  const now = Date.now();
  const arr = (bookingHits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (arr.length >= BOOK_PER_HOUR) { bookingHits.set(ip, arr); return false; }
  arr.push(now); bookingHits.set(ip, arr);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of bookingHits.entries()) {
    const keep = arr.filter((t) => now - t < 3600_000);
    if (keep.length) bookingHits.set(ip, keep); else bookingHits.delete(ip);
  }
}, 30 * 60 * 1000);

// ─── Helpers thời gian ───
const isOnlyDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
const setTime = (dateLike, hhmm) => {
  const [h, m] = String(hhmm || '14:00').split(':').map(Number);
  const d = new Date(dateLike);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
};

// ════════════════════════════════════════════════════════════════════
// HELPER: tìm phòng trống — KHỚP logic getAvailable + findOverlapForNewBooking
//   conflict: status ∈ {confirmed,reserved,checked_in} & checkIn < co & checkOut > ci
//   (tính cả group rooms[].roomId)
// ════════════════════════════════════════════════════════════════════
async function findAvailableRooms({ branchId, roomTypeId, ci, co, adults, children }) {
  const roomFilter = { roomStatus: 'active' };
  if (branchId)   roomFilter.branchId = branchId;
  if (roomTypeId) roomFilter.typeId   = roomTypeId;

  const rooms = await Room.find(roomFilter)
    .populate('typeId', 'name maxAdults maxChildren maxOccupancy beds area')
    .sort({ number: 1 });
  if (rooms.length === 0) return [];

  // Lọc theo sức chứa
  const totalGuests = (Number(adults) || 0) + (Number(children) || 0);
  const capable = rooms.filter((r) => {
    const t = r.typeId;
    if (!t) return true; // nếu chưa populate được type, không loại oan
    const cap = (t.maxOccupancy && t.maxOccupancy > 0)
      ? t.maxOccupancy
      : ((t.maxAdults || 0) + (t.maxChildren || 0));
    return totalGuests <= 0 || cap >= totalGuests;
  });

  const roomIds = capable.map((r) => r._id);
  if (roomIds.length === 0) return [];

  // Conflict (giống Booking.find trong getAvailable)
  const conflicts = await Booking.find({
    $or: [
      { roomId: { $in: roomIds } },
      { 'rooms.roomId': { $in: roomIds } },
    ],
    status: { $in: ['confirmed', 'reserved', 'checked_in'] },
    checkIn: { $lt: co },
    checkOut: { $gt: ci },
  }).select('roomId rooms').lean();

  const booked = new Set();
  for (const b of conflicts) {
    if (b.roomId) booked.add(String(b.roomId));
    if (Array.isArray(b.rooms)) {
      for (const sr of b.rooms) {
        if (sr.roomId) booked.add(String(sr.roomId._id ?? sr.roomId));
      }
    }
  }

  return capable.filter((r) => !booked.has(String(r._id)));
}

// ════════════════════════════════════════════════════════════════════
// HELPER: tính giá + breakdown cho 1 phòng (dùng chung cho /quote và /bookings)
//   Trả { roomAmount, priceBreakdown:[{label,amount,type,meta}], finalPriceType, policy }
// ════════════════════════════════════════════════════════════════════
async function computeQuote({ room, branch, ci, co, adults, children }) {
  const roomType = room.typeId;   // đã populate
  const nights = Math.max(1, Math.ceil((co - ci) / 86400000));

  let policy = null;
  try {
    policy = await PricePolicy.findOne({
      roomTypeId: room.typeId?._id ?? room.typeId,
      branchId: branch._id,
      isActive: true,
    }).sort({ displayOrder: 1 });
  } catch (_) { /* ignore */ }

  let roomAmount = 0;
  let priceBreakdown = [];
  let finalPriceType = 'day';
  try {
    if (calculatePrice && policy) {
      const maxAdults    = roomType?.maxAdults   ?? 2;
      const maxChildren  = roomType?.maxChildren ?? 0;
      const maxOccupancy = roomType?.maxOccupancy ?? (maxAdults + maxChildren);
      const r = calculatePrice({
        checkIn: ci, checkOut: co, priceType: 'day',
        policy, branch,
        adults: Number(adults) || 0, children: Number(children) || 0,
        maxAdults, maxChildren, maxOccupancy,
      });
      if (!r.error) {
        roomAmount = r.roomAmount || 0;
        priceBreakdown = (r.breakdown || []).map((b) => ({
          label: b.label, amount: b.amount,
          type: b.type === 'surcharge' ? 'surcharge' : 'base',
          meta: b.meta || {},
        }));
        finalPriceType = r.finalPriceType || 'day';
      }
    }
    if (roomAmount === 0) {
      roomAmount = (policy?.dayPrice || 0) * nights;
      if (priceBreakdown.length === 0 && roomAmount > 0) {
        priceBreakdown = [{ label: `Giá ngày × ${nights} đêm`, amount: roomAmount, type: 'base', meta: {} }];
      }
    }
  } catch (e) {
    console.warn('[public] computeQuote fail:', e.message);
    roomAmount = (policy?.dayPrice || 0) * nights;
  }
  return { roomAmount, priceBreakdown, finalPriceType, policy, nights };
}

// ════════════════════════════════════════════════════════════════════
// POST /api/public/availability
//   body: { branchId, checkIn, checkOut, adults, children, roomTypeId? }
// ════════════════════════════════════════════════════════════════════
router.post('/availability', async (req, res, next) => {
  try {
    const { branchId, checkIn, checkOut, adults = 2, children = 0, roomTypeId } = req.body || {};
    if (!checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Thiếu ngày nhận/trả phòng' });

    const branch = branchId
      ? await Branch.findById(branchId).lean()
      : await Branch.findOne({ status: 'active' }).lean();

    const ciStr = branch?.checkInTime || '14:00';
    const coStr = branch?.checkOutTime || '12:00';
    const ci = isOnlyDate(checkIn) ? setTime(checkIn + 'T00:00:00', ciStr) : new Date(checkIn);
    const co = isOnlyDate(checkOut) ? setTime(checkOut + 'T00:00:00', coStr) : new Date(checkOut);
    if (isNaN(ci) || isNaN(co))
      return res.status(400).json({ success: false, message: 'Ngày không hợp lệ' });
    if (co <= ci)
      return res.status(400).json({ success: false, message: 'Ngày trả phải sau ngày nhận' });

    const available = await findAvailableRooms({ branchId, roomTypeId, ci, co, adults, children });

    res.json({
      success: true,
      totalAvailable: available.length,
      checkIn, checkOut, adults, children,
    });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════
// POST /api/public/bookings
//   body: { branchId, customerName, customerPhone, checkIn, checkOut,
//           adults, children, roomTypeId? }
//   → tạo booking 'reserved' + tự chọn phòng trống đầu tiên
// ════════════════════════════════════════════════════════════════════
router.post('/bookings', async (req, res, next) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || 'unknown').toString().split(',')[0].trim();
    if (!bookingRateOk(ip))
      return res.status(429).json({ success: false, message: 'Bạn gửi quá nhiều yêu cầu. Vui lòng thử lại sau ít phút.' });

    const {
      branchId, customerName, customerPhone,
      checkIn, checkOut, adults = 2, children = 0, roomTypeId,
    } = req.body || {};

    if (!customerName || !String(customerName).trim())
      return res.status(400).json({ success: false, message: 'Vui lòng nhập họ tên' });
    if (!customerPhone || !String(customerPhone).trim())
      return res.status(400).json({ success: false, message: 'Vui lòng nhập số điện thoại' });
    if (!checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Thiếu ngày nhận/trả phòng' });

    const branch = branchId
      ? await Branch.findById(branchId).lean()
      : await Branch.findOne({ status: 'active' }).lean();
    if (!branch)
      return res.status(400).json({ success: false, message: 'Không xác định được chi nhánh' });

    const ciStr = branch.checkInTime || '14:00';
    const coStr = branch.checkOutTime || '12:00';
    const ci = isOnlyDate(checkIn) ? setTime(checkIn + 'T00:00:00', ciStr) : new Date(checkIn);
    const co = isOnlyDate(checkOut) ? setTime(checkOut + 'T00:00:00', coStr) : new Date(checkOut);
    if (isNaN(ci) || isNaN(co))
      return res.status(400).json({ success: false, message: 'Ngày không hợp lệ' });
    if (co <= ci)
      return res.status(400).json({ success: false, message: 'Ngày trả phải sau ngày nhận' });
    // Chỉ chặn nếu NGÀY nhận đã là quá khứ (hôm qua trở về trước).
    //   Không chặn theo giờ: khách đặt cho hôm nay là hợp lệ kể cả khi giờ chuẩn (14:00) đã trôi qua.
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    if (ci.getTime() < startOfToday.getTime())
      return res.status(400).json({ success: false, message: 'Ngày nhận phòng đã qua' });

    // Tự tìm phòng trống
    const available = await findAvailableRooms({
      branchId: String(branch._id), roomTypeId, ci, co, adults, children,
    });
    if (available.length === 0)
      return res.status(409).json({
        success: false,
        message: 'Rất tiếc, đã hết phòng trống cho khoảng thời gian này. Vui lòng chọn ngày khác hoặc liên hệ lễ tân.',
      });

    const room = available[0];
    const { roomAmount, priceBreakdown, finalPriceType, policy, nights } =
      await computeQuote({ room, branch, ci, co, adults, children });

    // Tạo / tìm customer theo phone
    const phoneClean = String(customerPhone).trim();
    let customer = await Customer.findOne({ phone: phoneClean });
    if (!customer) {
      customer = await Customer.create({ name: String(customerName).trim(), phone: phoneClean });
    }

    // Tạo booking reserved
    let booking;
    try {
      booking = await Booking.create({
        customerId: customer._id,
        customerName: String(customerName).trim(),
        customerPhone: phoneClean,
        roomId: room._id,
        roomNumber: room.number,
        roomType: room.typeName,                    // string sẵn trên Room
        branchId: branch._id,
        checkIn: ci,
        checkOut: co,
        nights,
        priceType: finalPriceType,
        adults: Number(adults) || 2,
        children: Number(children) || 0,
        roomAmount,
        totalAmount: roomAmount,
        servicesAmount: 0,
        discount: 0,
        discountPercent: 0,
        discountAmount: 0,
        isFreeRoom: false,
        priceBreakdown,
        policyId: policy?._id ?? null,
        policyName: policy?.name ?? '',
        status: 'reserved',
        paymentStatus: 'unpaid',
        source: 'Website',
        notes: '[Website] Khách tự đặt qua landing page — chờ lễ tân xác nhận',
        actualCheckIn: null,
      });
    } catch (e) {
      console.error('[public/bookings] create error:', e);
      return res.status(500).json({ success: false, message: 'Không tạo được đặt phòng: ' + e.message });
    }

    // Gán phòng cho booking (non-fatal)
    try {
      await Room.findByIdAndUpdate(room._id, {
        currentBookingId: booking._id,
        currentGuestName: String(customerName).trim(),
      });
    } catch (_) { /* ignore */ }

    // ⭐ Tạo Invoice ngay (để SePay /sepay/match có chỗ ghi tiền khi khách CK).
    //   Booking website không qua flow drawer nên cần tạo invoice chủ động ở đây.
    //   ⚠ PHẢI set issuedBy = 1 user hệ thống: vì Transaction.recordedBy là required,
    //     mà SePay ghi tiền với userId=null → recorder lấy từ invoice.issuedBy.
    //     Thiếu issuedBy → syncInvoicePayment fail → KHÔNG tạo giao dịch Thu/Chi.
    try {
      const systemUserId = await resolveSystemUserId(branch._id);
      await Invoice.create({
        bookingId: booking._id,
        customerId: customer._id,
        customerName: String(customerName).trim(),
        roomNumber: room.number,
        roomAmount,
        servicesAmount: 0,
        discount: 0,
        totalAmount: roomAmount,
        paidAmount: 0,
        remainingAmount: roomAmount,
        paymentStatus: 'unpaid',
        branchId: branch._id,
        issuedBy: systemUserId,           // ⭐ để Transaction.recordedBy có giá trị
        items: [{
          description: `Tiền phòng ${room.number} (${room.typeName})`,
          quantity: 1,
          unitPrice: roomAmount,
          amount: roomAmount,
        }],
      });
    } catch (e) {
      console.error('[public/bookings] tạo invoice lỗi (non-fatal):', e.message);
    }

    const bookingCode = booking.bookingCode || `BK_${String(booking._id).slice(-6).toUpperCase()}`;

    // Mã giao dịch ngẫu nhiên (6 số) — phân biệt từng đợt thanh toán.
    //   Nội dung CK = "<bookingCode chuẩn hoá> <payCode>", vd "BKD9CMKA 130761"
    //   Khớp đúng cơ chế /sepay/match của hệ thống.
    const payCode = String(Math.floor(100000 + Math.random() * 900000));
    const bookingPart = bookingCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const transferContent = `${bookingPart} ${payCode}`;

    // Thông tin QR thanh toán (VietQR — tự điền số tiền + nội dung)
    const bankInfo = await resolveBankInfo();
    const qrUrl = buildQrUrl(bankInfo, roomAmount, transferContent);
    const expiresAt = new Date(booking.createdAt.getTime() + HOLD_MINUTES * 60 * 1000);

    res.status(201).json({
      success: true,
      bookingCode,
      bookingId: String(booking._id),
      roomNumber: room.number,
      roomType: room.typeName,
      branch: branch.name,
      checkIn: ci, checkOut: co, nights,
      totalAmount: roomAmount,
      totalAmountFormatted: fmt(roomAmount),
      status: 'reserved',
      paymentStatus: 'unpaid',
      // ─── Thanh toán QR (khớp cơ chế SePay) ───
      holdMinutes: HOLD_MINUTES,
      expiresAt,                          // ISO — FE đếm ngược 10 phút
      bankInfo,                           // { bankBin, accountNo, accountName, bankName } | null
      qrUrl,                              // ảnh VietQR (rỗng nếu chưa cấu hình bank)
      payCode,                            // mã giao dịch — FE dùng poll /sepay/match
      bookingPart,                        // mã booking đã chuẩn hoá (dùng poll)
      transferContent,                    // nội dung CK đầy đủ "<bookingPart> <payCode>"
      message: `Đặt phòng thành công! Vui lòng thanh toán trong ${HOLD_MINUTES} phút để giữ phòng.`,
    });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════
// POST /api/public/quote
//   body: { branchId, checkIn, checkOut, adults, children, roomTypeId? }
//   → trả giá + chi tiết phụ thu cho loại phòng (tự chọn phòng trống đầu tiên)
// ════════════════════════════════════════════════════════════════════
router.post('/quote', async (req, res, next) => {
  try {
    const { branchId, checkIn, checkOut, adults = 2, children = 0, roomTypeId } = req.body || {};
    if (!checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Thiếu ngày nhận/trả phòng' });

    const branch = branchId
      ? await Branch.findById(branchId).lean()
      : await Branch.findOne({ status: 'active' }).lean();
    if (!branch)
      return res.status(400).json({ success: false, message: 'Không xác định được chi nhánh' });

    const ciStr = branch.checkInTime || '14:00';
    const coStr = branch.checkOutTime || '12:00';
    const ci = isOnlyDate(checkIn) ? setTime(checkIn + 'T00:00:00', ciStr) : new Date(checkIn);
    const co = isOnlyDate(checkOut) ? setTime(checkOut + 'T00:00:00', coStr) : new Date(checkOut);
    if (isNaN(ci) || isNaN(co) || co <= ci)
      return res.status(400).json({ success: false, message: 'Ngày/giờ không hợp lệ' });

    const available = await findAvailableRooms({
      branchId: String(branch._id), roomTypeId, ci, co, adults, children,
    });
    if (available.length === 0)
      return res.status(409).json({ success: false, message: 'Đã hết phòng cho khoảng thời gian này', soldOut: true });

    const room = available[0];
    const { roomAmount, priceBreakdown, finalPriceType, nights } =
      await computeQuote({ room, branch, ci, co, adults, children });

    // Tách base vs phụ thu để FE hiển thị rõ
    const surcharges = priceBreakdown.filter((b) => b.type === 'surcharge' && (b.amount || 0) !== 0);
    const baseItems  = priceBreakdown.filter((b) => b.type !== 'surcharge');

    res.json({
      success: true,
      roomType: room.typeName,
      roomNumber: room.number,
      nights,
      priceType: finalPriceType,
      roomAmount,
      roomAmountFormatted: fmt(roomAmount),
      breakdown: priceBreakdown,    // đầy đủ [{label, amount, type}]
      baseItems,                    // các dòng giá nền
      surcharges,                   // chỉ phụ thu (có thể rỗng)
      totalAvailable: available.length,
    });
  } catch (err) { next(err); }
});

module.exports = router;