'use strict'
/**
 * ════════════════════════════════════════════════════════════════════════════
 * pricingAdapter.js — CẦU NỐI giữa booking Mongo (Mongoose doc) và engine thuần.
 *
 * Engine trong /pricing là PURE (không đọc DB). File này (KHÔNG thuần — biết schema
 * của bạn) chuyển booking Mongo → "stay"/"booking" mà engine hiểu, rồi gọi engine.
 *
 * Đây là file DUY NHẤT controller cần require để tính tiền:
 *
 *   const { priceBookingDoc, priceBookingToNow } = require('../pricing/pricingAdapter')
 *
 *   const inv = priceBookingDoc(booking, { branch })       // hoá đơn đến khi trả
 *   const now = priceBookingToNow(booking, { branch })     // hoá đơn đến hiện tại
 *
 *   // inv.totalAmount, inv.roomAmount, inv.remainingAmount, inv.breakdown, inv.perRoom
 *
 * Controller KHÔNG tự cộng roomAmount, KHÔNG tự dựng breakdown nữa.
 * ════════════════════════════════════════════════════════════════════════════
 */

const { priceStay, priceBooking, DEFAULT_CTX } = require('./index')
const { buildInvoice } = require('./invoiceBuilder')

// ════════════════════════════════════════════════════════════════════════════
// ⭐ HỖ TRỢ GIÁ THỦ CÔNG TỪNG ĐÊM (customBreakdown đã lưu ở booking.priceBreakdown
//    hoặc sub-room.priceBreakdown). Engine thuần chỉ nhận 1 giá customRoomPrice
//    chung; giá RIÊNG từng đêm phải đọc thẳng breakdown đã lưu (KHÔNG tính lại).
// ════════════════════════════════════════════════════════════════════════════

// Dòng "tiền phòng" (base) — bỏ phụ thu/dịch vụ/chiết khấu/thuế.
function _isBaseLine(b) {
  return b && b.type !== 'surcharge' && b.type !== 'service' && b.type !== 'discount' && b.type !== 'tax'
}

// Breakdown custom đã lưu của 1 nguồn (booking lẻ / sub-room). null nếu không có custom.
function _savedCustomBreakdown(src) {
  const raw = Array.isArray(src && src.priceBreakdown) ? src.priceBreakdown : []
  // ⭐ FIX 13/06/2026: priceBreakdown là Mongoose DocumentArray → mỗi phần tử là subdoc.
  //   Dữ liệu thật (label/amount/meta) nằm trong ._doc, KHÔNG phải own-enumerable property
  //   (chúng là getter trên prototype). Nếu spread {...subdoc} thẳng thì RỚT amount →
  //   Number(b.amount)||0 = 0 → tính ra 0đ. Phải toObject() về plain object trước khi spread.
  const bd = raw.map(b => (b && typeof b.toObject === 'function') ? b.toObject() : b)
  if (!bd.some(b => b && b.meta && b.meta.customPrice === true)) return null
  return bd.map(b => ({ ...b, type: b.type === 'surcharge' ? 'surcharge' : 'base' }))
}

// "Đến hiện tại" với custom: cắt số dòng base tới số đêm ĐÃ TRÔI QUA (engine to-now
//   cho số đêm — KHÔNG dùng số tiền engine, chỉ dùng để biết cắt mấy đêm). Giữ phụ thu.
function _sliceCustomToNow(customBd, stay, ctx, now) {
  let nightsNow = 1
  try {
    const r = priceStay(stay, { viewMode: 'to-now', now, ctx })
    nightsNow = Math.max(1, Number(r.nights) || 1)
  } catch (_) { nightsNow = 1 }
  const out = []
  let baseCount = 0
  for (const b of customBd) {
    if (_isBaseLine(b)) {
      if (baseCount < nightsNow) { out.push(b); baseCount++ }
    } else {
      out.push(b)
    }
  }
  return out
}

/**
 * Tạo ctx từ branch config (giờ chuẩn, tolerance...). Mọi quy tắc nghiệp vụ ở đây.
 */
function ctxFromBranch(branch) {
  return {
    hotelUtcOffsetMinutes: (branch && branch.hotelUtcOffsetMinutes) != null
      ? branch.hotelUtcOffsetMinutes
      : 7 * 60,                                   // Asia/Ho_Chi_Minh (KHÔNG dùng giờ server)
    toleranceMinutes:      (branch && branch.toleranceMinutes)      ?? 15,
    dayEquivalentHours:    (branch && branch.dayEquivalentHours)    ?? 23,
    earlyCheckinUntilHour: (branch && branch.earlyCheckinUntil)     ?? 5,
  }
}

/** Lấy sức chứa từ policySnapshot. */
function capacityFromPolicy(pol) {
  const cap = pol && pol.capacity != null ? pol.capacity : 2
  return {
    maxAdults:    pol && pol.maxAdults    != null ? pol.maxAdults    : cap,
    maxChildren:  pol && pol.maxChildren  != null ? pol.maxChildren  : 0,
    maxOccupancy: pol && pol.maxOccupancy != null ? pol.maxOccupancy : cap,
  }
}

function asDate(v) {
  if (!v) return null
  return v instanceof Date ? v : new Date(v)
}

/**
 * Chuyển 1 phòng (booking lẻ hoặc 1 sub-room của đoàn) → "stay" cho engine.
 *
 * @param src  booking lẻ HOẶC sub-room object
 * @param base booking cha (để lấy field chung khi src là sub-room)
 * @param opts { resolvePolicy?: (policyId) => policySnapshot }  // để đổi-giá qua nhiều chặng
 */
function _buildResolver(opts) {
  // Ưu tiên hàm resolvePolicy nếu controller truyền; nếu không, build từ policyMap
  //   (Map hoặc object: policyId(string) → policySnapshot). Trả null nếu không có gì.
  if (typeof opts.resolvePolicy === 'function') return opts.resolvePolicy
  const m = opts.policyMap
  if (!m) return null
  const get = (m instanceof Map) ? (k) => m.get(k) : (k) => m[k]
  return (policyId) => {
    if (!policyId) return null
    const key = String(policyId._id || policyId)
    return get(key) || null
  }
}

function toStay(src, base, opts = {}) {
  base = base || src
  const resolve = _buildResolver(opts)
  // ⭐ FIX 14/06/2026 (đổi giá đoàn): sub-room có policyId RIÊNG nhưng KHÔNG có
  //   policySnapshot riêng (chỉ booking cha có). Phải resolve policy hiện tại của
  //   ĐÚNG phòng này theo src.policyId → nếu không, phòng đổi giá bị tính theo giá
  //   gốc của đoàn (vd 270k thay vì 400k). Fallback: snapshot booking cha.
  const ownPolicy = (resolve && src.policyId && resolve(src.policyId)) || null
  const policySnapshot = ownPolicy || src.policySnapshot || base.policySnapshot

  // ⭐ FIX 14/06/2026 (đoàn): transferHistory nằm ở booking CHA, dùng chung cho cả đoàn.
  //   Mỗi sub-room chỉ được nhận các transfer thuộc CHUỖI PHÒNG của chính nó, nếu không
  //   mọi phòng đều bị "settle" về phòng của transfer cuối đoàn (vd cả 3 phòng → 302).
  //   Lần ngược từ phòng hiện tại: toRoom == current → nhận, rồi current = fromRoom, lặp.
  const rawHist = (src.transferHistory || base.transferHistory || [])
    .filter(t => t && t.transferAt && t.fromRoomNumber && t.toRoomNumber)
    .slice()
    .sort((a, b) => asDate(a.transferAt) - asDate(b.transferAt))
  // Chỉ lọc theo chuỗi khi src là 1 phòng của đoàn (base có rooms[] và src≠base).
  //   Booking lẻ: src===base → giữ nguyên toàn bộ (chuỗi là chính nó).
  const isGroupRoom = base && base !== src && Array.isArray(base.rooms) && base.rooms.length > 0
  let myHist = rawHist
  if (isGroupRoom) {
    const chain = []
    let current = src.roomNumber
    for (let i = rawHist.length - 1; i >= 0; i--) {
      const t = rawHist[i]
      if (String(t.toRoomNumber) === String(current)) {
        chain.unshift(t)
        current = t.fromRoomNumber
      }
    }
    myHist = chain
  }

  const transfers = myHist
    .map(t => {
      // policy của phòng đi/đến từng chặng:
      //  - ưu tiên snapshot lưu kèm transfer (nếu bạn đã lưu fromPolicySnapshot/toPolicySnapshot)
      //  - nếu chỉ có policyId → dùng resolvePolicy (nếu controller truyền vào)
      //  - fallback: policySnapshot hiện tại (đúng cho "giữ giá" và khi phòng cũ bị drop)
      const fromPolicy = t.fromPolicySnapshot
        || (resolve && t.oldPolicyId && resolve(t.oldPolicyId))
        || policySnapshot
      const toPolicy = t.toPolicySnapshot
        || (resolve && t.newPolicyId && resolve(t.newPolicyId))
        || policySnapshot
      return {
        fromRoomNumber: t.fromRoomNumber,
        toRoomNumber:   t.toRoomNumber,
        transferAt:     asDate(t.transferAt),
        fromPolicy, toPolicy,
      }
    })

  return {
    roomNumber: src.roomNumber,
    priceType:  src.priceType || base.priceType || 'day',
    policy:     policySnapshot,
    occupancy:  { adults: src.adults ?? base.adults ?? 2, children: src.children ?? base.children ?? 0 },
    capacity:   capacityFromPolicy(policySnapshot),
    isFreeRoom: !!(src.isFreeRoom ?? base.isFreeRoom),
    customRoomPrice: src.customRoomPrice ?? undefined,
    status:     src.status || base.status,
    plannedCheckIn:  asDate(src.checkIn  || base.checkIn),
    actualCheckIn:   asDate(src.actualCheckIn  || base.actualCheckIn),
    plannedCheckOut: asDate(src.checkOut || base.checkOut),
    actualCheckOut:  asDate(src.actualCheckOut || base.actualCheckOut),
    transfers,
  }
}

/** Booking lẻ hay đoàn? → trả mảng stays. */
function staysOf(booking, opts) {
  const subRooms = booking.rooms && booking.rooms.length > 0 ? booking.rooms : null
  if (booking.isGroup && subRooms) {
    return subRooms.map(r => toStay(r, booking, opts))
  }
  return [toStay(booking, booking, opts)]
}

/**
 * Lõi dùng chung cho cả 2 mode. Nếu booking (hoặc bất kỳ sub-room nào) có breakdown
 * giá thủ công TỪNG ĐÊM đã lưu → dùng THẲNG breakdown đó cho phòng custom (engine
 * KHÔNG được tính lại), phòng thường vẫn để engine tính. Không có custom → đường cũ.
 */
function _priceBookingMaybeCustom(booking, opts, viewMode, now) {
  const ctx = ctxFromBranch(opts.branch)
  const subRooms = booking.rooms && booking.rooms.length > 0 ? booking.rooms : null
  const sources = (booking.isGroup && subRooms) ? subRooms : [booking]

  const anyCustom = sources.some(src => _savedCustomBreakdown(src) != null)
  if (!anyCustom) {
    // ── Đường cũ (không đổi) — engine tính toàn bộ ──
    const stays = sources.map(src => toStay(src, booking, opts))
    return priceBooking({
      isGroup: !!booking.isGroup,
      stays,
      servicesAmount:  booking.servicesAmount  || 0,
      discountPercent: booking.discountPercent || 0,
      discountAmount:  booking.discountAmount  || 0,
      transferFee:     booking.transferFee     || 0,
      paidAmount:      booking.paidAmount       || booking.depositAmount || 0,
      isFreeRoom:      !!booking.isFreeRoom,
    }, { viewMode, now, ctx })
  }

  // ── Có giá thủ công từng đêm ──
  const allBreakdown = []
  const perRoom = []
  let nights = 0
  for (const src of sources) {
    const stay = toStay(src, booking, opts)
    const customBd = _savedCustomBreakdown(src)
    let lines
    if (customBd) {
      // to-checkout → đủ mọi đêm custom; to-now → cắt tới số đêm đã trôi qua
      lines = (viewMode === 'to-now') ? _sliceCustomToNow(customBd, stay, ctx, now) : customBd
    } else {
      const r = priceStay(stay, { viewMode, now, ctx, customRoomPrice: stay.customRoomPrice })
      lines = r.breakdown
    }
    const roomAmount = lines.reduce((s, b) => s + (Number(b.amount) || 0), 0)
    allBreakdown.push(...lines)
    perRoom.push({ roomNumber: src.roomNumber, roomAmount, breakdown: lines })
    nights = Math.max(nights, lines.filter(_isBaseLine).length)
  }

  const invoice = buildInvoice({
    breakdown:       allBreakdown,
    servicesAmount:  booking.servicesAmount  || 0,
    discountPercent: booking.discountPercent || 0,
    discountAmount:  booking.discountAmount  || 0,
    transferFee:     booking.transferFee     || 0,
    paidAmount:      booking.paidAmount       || booking.depositAmount || 0,
    isFreeRoom:      !!booking.isFreeRoom,
  })
  return { ...invoice, perRoom, nights }
}

/**
 * HÀM CHÍNH cho controller — hoá đơn "đến khi trả phòng".
 * Trả invoice đầy đủ (đã gồm dịch vụ/chiết khấu/phí/đã trả).
 */
function priceBookingDoc(booking, opts = {}) {
  return _priceBookingMaybeCustom(booking, opts, 'to-checkout', null)
}

/** Hoá đơn "đến hiện tại" (tab tính tạm). now mặc định = thời điểm gọi. */
function priceBookingToNow(booking, opts = {}) {
  return _priceBookingMaybeCustom(booking, opts, 'to-now', opts.now || new Date())
}

/**
 * Tính riêng 1 phòng (lẻ) — trả { roomAmount, breakdown, nights }.
 * Dùng khi chỉ cần số tiền phòng (chưa gồm dịch vụ/chiết khấu).
 */
function priceRoomDoc(booking, opts = {}) {
  const ctx = ctxFromBranch(opts.branch)
  const stay = toStay(booking, booking, opts)
  const viewMode = opts.viewMode || 'to-checkout'
  // ⭐ Giá thủ công từng đêm đã lưu → dùng thẳng (cắt theo now nếu to-now).
  const customBd = _savedCustomBreakdown(booking)
  if (customBd) {
    const lines = (viewMode === 'to-now')
      ? _sliceCustomToNow(customBd, stay, ctx, opts.now || new Date())
      : customBd
    const roomAmount = lines.reduce((s, b) => s + (Number(b.amount) || 0), 0)
    return { roomNumber: booking.roomNumber, roomAmount, breakdown: lines, nights: lines.filter(_isBaseLine).length }
  }
  return priceStay(stay, {
    viewMode,
    now: opts.now, ctx,
    customRoomPrice: booking.customRoomPrice,
  })
}

module.exports = {
  priceBookingDoc,     // hoá đơn đầy đủ, đến khi trả phòng
  priceBookingToNow,   // hoá đơn đầy đủ, đến hiện tại
  priceRoomDoc,        // tiền 1 phòng
  toStay, ctxFromBranch, // export phụ để test/độ phủ
}