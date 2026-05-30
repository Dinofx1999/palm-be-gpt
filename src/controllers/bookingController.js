const Booking      = require('../models/Booking');
const Room         = require('../models/Room');
const Customer     = require('../models/Customer');
const Invoice      = require('../models/Invoice');
const Branch       = require('../models/Branch');
const PricePolicy  = require('../models/PricePolicy');
const AuditLog     = require('../models/AuditLog');
const { calculatePrice } = require('../utils/priceCalculator');
const { logAction }      = require('../utils/auditLogger');
const { buildPolicySnapshot } = require('../utils/policySnapshot');
const { computeMoveRoomBreakdown } = require('../utils/moveRoomBreakdown');
const { rebuildBreakdownFromHistory, buildSegmentsFromHistory } = require('../utils/rebuildBreakdownFromHistory');
const { sendMail } = require('../utils/mailer');

// ⭐ FIX 21/05/2026: Làm tròn giờ checkout khi tính "đến hiện tại" (mode 'now')
//   theo mốc dayEquivalentHours của branch (vd 20:00).
//   Quy tắc: khi đang xem live và giờ hiện tại đã VƯỢT mốc (vd 23:29 > 20:00),
//   thì tính tròn thêm 1 đêm → checkout nhảy tới giờ checkout chuẩn của NGÀY HÔM SAU.
//   Dùng cho nhánh chuyển phòng (computeMoveRoomBreakdown không tự xử lý dayEquiv).
//   - Chỉ áp dụng mode 'now'. Mode 'checkout' giữ nguyên booking.checkOut.
//   - Không vượt quá booking.checkOut (overstay đã có block "trả phòng muộn" lo).
function roundUpCheckoutForNow(effectiveCheckOut, branch, mode, bookingCheckOut) {
  if (mode !== 'now') return effectiveCheckOut;
  const dayEquivHours = branch?.dayEquivalentHours ?? 23;
  const co = new Date(effectiveCheckOut);
  const hourMin = co.getHours() * 60 + co.getMinutes();
  if (hourMin < dayEquivHours * 60) return effectiveCheckOut;   // chưa vượt mốc → giữ nguyên

  // Vượt mốc → nhảy tới giờ checkout chuẩn của ngày HÔM SAU
  const [coH, coM] = String(branch?.checkOutTime || '12:00').split(':').map(Number);
  const rounded = new Date(co);
  rounded.setDate(rounded.getDate() + 1);
  rounded.setHours(coH || 12, coM || 0, 0, 0);

  // Không vượt quá checkout dự kiến của booking
  const planned = new Date(bookingCheckOut);
  return rounded > planned ? planned : rounded;
}


// ⭐ NEW 20/05/2026: Tìm policy hourEnabled=true của roomType để lấy bảng giá GIỜ chuẩn.
//   Dùng khi tính giá giờ cho đoạn chuyển phòng — phải lấy "Giá Nghỉ Giờ" (hourEnabled)
//   chứ KHÔNG phải policy giá ngày booking đang dùng (vd "Giá Ngày 1" có hourSlots khác).
//   Mỗi roomType chỉ có 1 policy hourEnabled → lấy displayOrder nhỏ nhất nếu nhiều.
const resolveHourlyPolicy = async (roomTypeId, branchId) => {
  if (!roomTypeId || !branchId) return null;
  try {
    return await PricePolicy.findOne({
      roomTypeId,
      branchId,
      hourEnabled: true,
      isActive: true,
    }).sort({ displayOrder: 1 }).lean();
  } catch (_) {
    return null;
  }
};

// ════════════════════════════════════════════════════════════════════════════
// ⭐ FIX 24/05/2026: REBUILD priceBreakdown từ transferHistory (hỗ trợ N lần đổi)
//   computeMoveRoomBreakdown chỉ xử lý đúng 1 transfer → đổi ≥2 lần nuốt chặng cũ.
//   Các helper dưới resolve policy/sức chứa cho TỪNG phòng trong lịch sử rồi
//   dựng lại toàn bộ breakdown. Dùng chung cho moveRoom + changeDates.
// ════════════════════════════════════════════════════════════════════════════

// Chuẩn hóa PricePolicy doc/snapshot → object mà calculatePrice cần.
const normalizePolicyForCalc = (pol) => {
  if (!pol) return null
  const p = (typeof pol.toObject === 'function') ? pol.toObject() : pol
  return {
    name:            p.name,
    dayEnabled:      p.dayEnabled,
    hourEnabled:     p.hourEnabled,
    nightEnabled:    p.nightEnabled,
    weekEnabled:     p.weekEnabled,
    monthEnabled:    p.monthEnabled,
    dayPrice:        p.dayPrice,
    hourPrice:       p.hourPrice,
    nightPrice:      p.nightPrice,
    weekPrice:       p.weekPrice,
    monthPrice:      p.monthPrice,
    hourSlots:       p.hourSlots || [],
    dayCheckInTime:  p.dayCheckInTime,
    dayCheckOutTime: p.dayCheckOutTime,
    dayEarlyCheckIn: p.dayEarlyCheckIn || [],
    dayLateCheckOut: p.dayLateCheckOut || [],
    dayAdultSurcharge: p.dayAdultSurcharge,
    dayChildSurcharge: p.dayChildSurcharge,
  }
}

// Resolve policy cho 1 phòng theo số phòng + branch (policy giá NGÀY hiện hành).
const resolvePolicyForRoomNumber = async (roomNumber, branchId, fallbackSnapshot = null) => {
  try {
    const roomDoc = await Room.findOne({ number: roomNumber, branchId }).populate('typeId')
    const roomTypeId = roomDoc?.typeId?._id ?? roomDoc?.typeId
    if (roomTypeId) {
      const pol = await PricePolicy.findOne({
        roomTypeId, branchId, dayEnabled: true, isActive: true,
      }).sort({ displayOrder: 1 }).lean()
      if (pol) return normalizePolicyForCalc(pol)
    }
  } catch (e) {
    console.warn('[resolvePolicyForRoomNumber]', roomNumber, e.message)
  }
  return normalizePolicyForCalc(fallbackSnapshot)
}

// Resolve sức chứa roomType cho 1 phòng (phụ thu vượt sức chứa).
const resolveCapacityForRoomNumber = async (roomNumber, branchId) => {
  try {
    const roomDoc = await Room.findOne({ number: roomNumber, branchId }).populate('typeId')
    const t = roomDoc?.typeId
    if (t) {
      const maxAdults    = t.maxAdults   ?? t.capacity ?? 2
      const maxChildren  = t.maxChildren ?? 0
      const maxOccupancy = t.maxOccupancy ?? (maxAdults + maxChildren)
      return { maxAdults, maxChildren, maxOccupancy }
    }
  } catch (_) {}
  return { maxAdults: 2, maxChildren: 0, maxOccupancy: 2 }
}

// Dựng lại priceBreakdown đầy đủ cho booking từ transferHistory.
//   Trả null nếu booking KHÔNG có transfer (caller dùng calculatePrice thường).
//   Ưu tiên policy lưu trong transferHistory (oldPolicyId/newPolicyId) — đúng theo
//   thời điểm đổi; fallback policy hiện hành của phòng, rồi policySnapshot booking.
async function rebuildBookingBreakdown(booking, branch, { plannedCheckOut } = {}) {
  const hist = (booking.transferHistory || [])
    .filter(t => t?.transferAt && t?.fromRoomNumber && t?.toRoomNumber)
    .sort((a, b) => new Date(a.transferAt) - new Date(b.transferAt))
  if (hist.length === 0) return null

  // Cache policy theo policyId + theo số phòng.
  const polByIdCache = new Map()
  const polByRoomCache = new Map()
  const resolvePolById = async (policyId) => {
    if (!policyId) return null
    const key = String(policyId)
    if (polByIdCache.has(key)) return polByIdCache.get(key)
    let pol = null
    try { pol = await PricePolicy.findById(policyId).lean() } catch (_) {}
    const norm = normalizePolicyForCalc(pol)
    polByIdCache.set(key, norm)
    return norm
  }
  const resolvePolByRoom = async (rn) => {
    if (polByRoomCache.has(rn)) return polByRoomCache.get(rn)
    const norm = await resolvePolicyForRoomNumber(rn, booking.branchId, booking.policySnapshot)
    polByRoomCache.set(rn, norm)
    return norm
  }

  // Pre-resolve mọi policy + capacity cần (resolver của util là sync).
  const polMap = new Map()   // key: `${roomNumber}|${from|to}|${policyId||''}` → policy
  const capCache = new Map()
  const getCap = async (rn) => {
    if (capCache.has(rn)) return capCache.get(rn)
    const c = await resolveCapacityForRoomNumber(rn, booking.branchId)
    capCache.set(rn, c)
    return c
  }

  for (const t of hist) {
    // from-room: ưu tiên oldPolicyId của transfer
    const fromKey = makePolKey(t, 'from')
    if (!polMap.has(fromKey)) {
      const byId = await resolvePolById(t.oldPolicyId)
      polMap.set(fromKey, byId || await resolvePolByRoom(t.fromRoomNumber))
    }
    // to-room: ưu tiên newPolicyId của transfer
    const toKey = makePolKey(t, 'to')
    if (!polMap.has(toKey)) {
      const byId = await resolvePolById(t.newPolicyId)
      polMap.set(toKey, byId || await resolvePolByRoom(t.toRoomNumber))
    }
    await getCap(t.fromRoomNumber)
    await getCap(t.toRoomNumber)
  }

  const segments = buildSegmentsFromHistory({
    actualCheckIn:   booking.actualCheckIn ?? booking.checkIn,
    plannedCheckOut: plannedCheckOut ?? booking.checkOut,
    transferHistory: hist,
    policyResolver:  (t, which) => polMap.get(makePolKey(t, which)),
    capacityResolver:(rn) => capCache.get(rn) || { maxAdults: 2, maxChildren: 0, maxOccupancy: 2 },
    occupancy:       { adults: booking.adults, children: booking.children },
    priceType:       booking.priceType || 'day',
  })

  return rebuildBreakdownFromHistory({
    segments, branch, isFreeRoom: !!booking.isFreeRoom, mergeRows: true,
  })
}
function makePolKey(t, which) {
  const rn = which === 'from' ? t.fromRoomNumber : t.toRoomNumber
  const pid = which === 'from' ? (t.oldPolicyId || '') : (t.newPolicyId || '')
  return `${rn}|${which}|${String(pid)}`
}

// ⭐ Role guard cho undo check-in/check-out — chỉ Admin/Manager
const ALLOWED_UNDO_ROLES = ['Admin', 'Manager']

// ⭐ Roles được phép set giờ checkout quá khứ với BẤT KỲ phòng nào
//    Roles khác chỉ được phép nếu phòng ĐÃ TỪNG checkout (qua audit log)
const PRIVILEGED_PAST_ROLES = ['Admin', 'Manager']

const checkUndoPermission = (user) => {
  if (!user) {
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHENTICATED',
      message: 'Cần đăng nhập để hoàn tác',
    }
  }
  if (!ALLOWED_UNDO_ROLES.includes(user.role)) {
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN_ROLE',
      message: `Chỉ Admin/Manager mới được quyền hoàn tác (vai trò hiện tại: ${user.role || 'unknown'})`,
    }
  }
  return { ok: true }
}

// ⭐ Lấy log checkout gần nhất của 1 booking
//   Note: KHÔNG filter `undone` — sau khi undo, user thường muốn recheckout với
//   giờ cũ làm gợi ý. Audit trail (ai làm gì) là việc của AuditLog, không phải
//   của hàm này.
const getLastCheckoutLog = async (bookingId, roomNumber = null) => {
  try {
    const filter = {
      entityType: 'Booking',
      entityId:   bookingId,
      action:     { $in: ['checkout', 'checkout_room'] },
    }
    if (roomNumber) {
      filter['metadata.roomNumber'] = String(roomNumber)
    }
    const log = await AuditLog.findOne(filter)
      .sort({ createdAt: -1 })
      .select('_id createdAt action metadata')
      .lean()
    return log ?? null
  } catch (err) {
    console.error('[getLastCheckoutLog] error:', err.message)
    return null
  }
}

const hasBookingBeenCheckedOut = async (bookingId, roomNumber = null) => {
  const log = await getLastCheckoutLog(bookingId, roomNumber)
  return !!log
}

// ⭐ Phân quyền "set giờ quá khứ"
const canSetPastTime = async (user, bookingId, roomNumber = null) => {
  if (!user) {
    return { canSetPast: false, reason: 'Cần đăng nhập', lastCheckoutAt: null }
  }
  if (PRIVILEGED_PAST_ROLES.includes(user.role)) {
    const log = await getLastCheckoutLog(bookingId, roomNumber)
    return {
      canSetPast: true,
      lastCheckoutAt: log?.metadata?.actualCheckOut ?? null,
    }
  }
  const log = await getLastCheckoutLog(bookingId, roomNumber)
  if (log) {
    return {
      canSetPast: true,
      lastCheckoutAt: log.metadata?.actualCheckOut ?? null,
    }
  }
  return {
    canSetPast: false,
    reason: 'Chỉ Admin/Manager được phép set giờ trả phòng quá khứ. Nhân viên chỉ được sửa nếu phòng đã từng trả phòng (đã từng checkout).',
    lastCheckoutAt: null,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ⭐ FIX 07/05/2026 v2: Phân biệt CHECK-IN vs ĐẶT PHÒNG khi khách cũ chưa trả
//
// LOGIC ĐÚNG BUSINESS:
//   - actionType='checkin' (đang muốn nhận phòng / chiếm phòng VẬT LÝ ngay):
//     + Candidate `checked_in` chưa trả → end = +∞ → BLOCK
//     + Candidate `reserved`/`confirmed` → end = checkOut dự kiến (cho phép đặt
//       chồng nếu không overlap khoảng đặt)
//
//   - actionType='reserve' (chỉ đặt trước, chưa nhận phòng ngay):
//     + DÙNG checkOut DỰ KIẾN → cho phép đặt phòng tương lai dù A chưa trả
//     + Khi B đến giờ check-in mà A vẫn chưa trả → ở bước check-in mới block
//
// VÍ DỤ:
//   - 301 (A) checked_in 21:29-21:29 chưa trả thực tế
//   - B đặt 22:00 → 08/05 12:00 (status=reserved) → CHO PHÉP ✅
//   - B đến 22:00 muốn check-in mà A vẫn chưa trả → BLOCK ✅
//   - A bấm trả 21:55 → B check-in 22:00 OK ✅
// ════════════════════════════════════════════════════════════════════════════

const FAR_FUTURE = new Date('9999-12-31T23:59:59.999Z')

// Helper: end thực tế của candidate (booking đang giữ phòng)
//   - Đã trả: dùng actualCheckOut
//   - Đang checked_in chưa trả + actionType='checkin': dùng FAR_FUTURE → block
//   - Còn lại: dùng checkOut dự kiến
const resolveCandidateEnd = (candStatus, actualCheckOut, scheduledCheckOut, actionType = 'checkin') => {
  if (actualCheckOut) return new Date(actualCheckOut)
  if (candStatus === 'checked_in' && actionType === 'checkin') return FAR_FUTURE
  return scheduledCheckOut ? new Date(scheduledCheckOut) : null
}

const findActiveConflictForRoom = async ({
  bookingId, roomId, intervalStart, intervalEnd,
  actionType = 'checkin',  // ⭐ 'checkin' | 'reserve'
}) => {
  const candidates = await Booking.find({
    _id:    { $ne: bookingId },
    $or: [
      { roomId },
      { 'rooms.roomId': roomId },
    ],
    status:   { $in: ['confirmed', 'reserved', 'checked_in'] },
  }).sort({ checkIn: 1 })

  for (const cand of candidates) {
    let candRoom    = null
    let candStatus  = cand.status
    let candStart   = null
    let candEnd     = null
    let isStillCheckedIn = false

    if (Array.isArray(cand.rooms) && cand.rooms.length > 0) {
      candRoom = cand.rooms.find(r =>
        String(r.roomId?._id ?? r.roomId) === String(roomId)
      )
      if (!candRoom) continue
      if (['checked_out', 'cancelled'].includes(candRoom.status)) continue
      candStatus = candRoom.status
      candStart  = candRoom.actualCheckIn  ?? candRoom.checkIn  ?? cand.checkIn
      candEnd    = resolveCandidateEnd(
        candStatus,
        candRoom.actualCheckOut,
        candRoom.checkOut ?? cand.checkOut,
        actionType,
      )
      isStillCheckedIn = candStatus === 'checked_in' && !candRoom.actualCheckOut
    } else {
      if (String(cand.roomId) !== String(roomId)) continue
      candStart = cand.actualCheckIn  ?? cand.checkIn
      candEnd   = resolveCandidateEnd(candStatus, cand.actualCheckOut, cand.checkOut, actionType)
      isStillCheckedIn = candStatus === 'checked_in' && !cand.actualCheckOut
    }

    if (!candStart || !candEnd) continue

    const overlap = new Date(intervalStart) < new Date(candEnd) &&
                    new Date(candStart)     < new Date(intervalEnd)
    if (!overlap) continue

    return {
      conflict:        cand,
      conflictRoom:    candRoom,
      conflictStart:   candStart,
      // Trả về scheduledCheckOut cho UI (không show "9999")
      conflictEnd:     candEnd === FAR_FUTURE
        ? (candRoom?.checkOut ?? cand.checkOut)
        : candEnd,
      conflictStatus:  candStatus,
      isStillCheckedIn,  // ⭐ NEW: cho FE biết khách đang ở chưa trả
    }
  }

  return null
}

const findOverlapForNewBooking = async ({
  roomId, intervalStart, intervalEnd,
  excludeBookingIds = [],
  actionType = 'checkin',  // ⭐ 'checkin' | 'reserve'
}) => {
  const filter = {
    $or: [
      { roomId },
      { 'rooms.roomId': roomId },
    ],
    status: { $in: ['confirmed', 'reserved', 'checked_in'] },
  }
  if (excludeBookingIds.length > 0) {
    filter._id = { $nin: excludeBookingIds }
  }

  const candidates = await Booking.find(filter).sort({ checkIn: 1 })

  for (const cand of candidates) {
    let candRoom    = null
    let candStart   = null
    let candEnd     = null
    let candStatus  = cand.status
    let isStillCheckedIn = false

    if (Array.isArray(cand.rooms) && cand.rooms.length > 0) {
      candRoom = cand.rooms.find(r =>
        String(r.roomId?._id ?? r.roomId) === String(roomId)
      )
      if (!candRoom) continue
      if (['checked_out', 'cancelled'].includes(candRoom.status)) continue
      candStatus = candRoom.status
      candStart  = candRoom.actualCheckIn  ?? candRoom.checkIn  ?? cand.checkIn
      candEnd    = resolveCandidateEnd(
        candStatus,
        candRoom.actualCheckOut,
        candRoom.checkOut ?? cand.checkOut,
        actionType,
      )
      isStillCheckedIn = candStatus === 'checked_in' && !candRoom.actualCheckOut
    } else {
      if (String(cand.roomId) !== String(roomId)) continue
      candStart = cand.actualCheckIn  ?? cand.checkIn
      candEnd   = resolveCandidateEnd(candStatus, cand.actualCheckOut, cand.checkOut, actionType)
      isStillCheckedIn = candStatus === 'checked_in' && !cand.actualCheckOut
    }

    if (!candStart || !candEnd) continue

    const overlap = new Date(intervalStart) < new Date(candEnd) &&
                    new Date(candStart)     < new Date(intervalEnd)
    if (!overlap) continue

    return {
      conflict:       cand,
      conflictRoom:   candRoom,
      conflictStart:  candStart,
      conflictEnd:    candEnd === FAR_FUTURE
        ? (candRoom?.checkOut ?? cand.checkOut)
        : candEnd,
      conflictStatus: candStatus,
      isStillCheckedIn,
    }
  }

  return null
}

// ── GET ALL ───────────────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    const { status, paymentStatus, customerId, roomId, branchId, page = 1, limit = 20 } = req.query
    const filter = {}
    if (status)        filter.status        = status
    if (paymentStatus) filter.paymentStatus = paymentStatus
    if (customerId)    filter.customerId    = customerId
    if (roomId)        filter.roomId        = roomId
    if (branchId)      filter.branchId      = branchId

    const total = await Booking.countDocuments(filter)
    const data  = await Booking.find(filter)
      .sort({ createdAt: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit)

    res.json({ success: true, data: { data, total, page: +page, limit: +limit } })
  } catch (err) { next(err) }
}

// ⭐ Helper build invoice items từ priceBreakdown thực tế
const buildInvoiceItemsFromBooking = (booking) => {
  const items = []
  const isGroup = Array.isArray(booking.rooms) && booking.rooms.length > 0

  if (isGroup) {
    for (const sub of booking.rooms) {
      if (sub.status === 'cancelled') continue
      const subBd = Array.isArray(sub.priceBreakdown) ? sub.priceBreakdown : []
      for (const b of subBd) {
        const seg = (b && typeof b.toObject === 'function') ? b.toObject() : b
        const rawLabel = String(seg.label ?? '').trim()
        const cleanLabel = rawLabel.replace(/^\[[^\]]+\]\s*/, '')
        items.push({
          description: `Phòng ${sub.roomNumber} – ${cleanLabel}`,
          quantity:    1,
          unitPrice:   Number(seg.amount ?? 0),
          amount:      Number(seg.amount ?? 0),
        })
      }
      if ((sub.servicesAmount ?? 0) > 0) {
        items.push({
          description: `Phòng ${sub.roomNumber} – Dịch vụ`,
          quantity:    1,
          unitPrice:   Number(sub.servicesAmount ?? 0),
          amount:      Number(sub.servicesAmount ?? 0),
        })
      }
    }
  } else {
    const bd = Array.isArray(booking.priceBreakdown) ? booking.priceBreakdown : []
    for (const b of bd) {
      const seg = (b && typeof b.toObject === 'function') ? b.toObject() : b
      items.push({
        description: `Phòng ${booking.roomNumber} – ${String(seg.label ?? '').trim()}`,
        quantity:    1,
        unitPrice:   Number(seg.amount ?? 0),
        amount:      Number(seg.amount ?? 0),
      })
    }
    if ((booking.servicesAmount ?? 0) > 0) {
      items.push({
        description: `Dịch vụ`,
        quantity:    1,
        unitPrice:   Number(booking.servicesAmount ?? 0),
        amount:      Number(booking.servicesAmount ?? 0),
      })
    }
  }

  if (items.length === 0) {
    items.push({
      description: `Phòng ${booking.roomNumber} – ${booking.roomType ?? ''} × ${booking.nights ?? 1} đêm`,
      quantity:    booking.nights ?? 1,
      unitPrice:   Math.round((booking.roomAmount ?? 0) / Math.max(1, booking.nights ?? 1)),
      amount:      booking.roomAmount ?? 0,
    })
  }

  return items
}

const getOne = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    res.json({ success: true, data: { booking } })
  } catch (err) { next(err) }
}

// ⭐ PREVIEW PRICE
const previewPrice = async (req, res, next) => {
  try {
    const {
      roomId, checkIn, checkOut, priceType = 'day',
      adults = 2, children = 0, policyId, confirmConvert = false,
    } = req.body
    if (!roomId || !checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin' })

    const room = await Room.findById(roomId).populate('typeId')
    if (!room) return res.status(404).json({ success: false, message: 'Không tìm thấy phòng' })

    const branch = await Branch.findById(room.branchId)

    let policy = policyId ? await PricePolicy.findById(policyId) : null
    if (!policy) policy = await PricePolicy.findOne({ roomTypeId: room.typeId, branchId: room.branchId, isActive: true })

    const maxAdults   = room.typeId?.maxAdults   ?? room.typeId?.capacity ?? 2
    const maxChildren = room.typeId?.maxChildren ?? 0
    const maxOccupancy = room.typeId?.maxOccupancy ?? (maxAdults + maxChildren)

    // ⭐ NEW 18/05/2026: BLOCK nếu tổng người vượt maxOccupancy
    if ((adults + children) > maxOccupancy) {
      return res.status(400).json({
        success: false,
        code:    'OVER_CAPACITY',
        message: `Phòng chỉ hỗ trợ tối đa ${maxOccupancy} người.`,
        data: {
          maxOccupancy,
          requested: adults + children,
          adults, children,
          maxAdults, maxChildren,
        },
      })
    }

    const result = calculatePrice({
      checkIn:  new Date(checkIn),
      checkOut: new Date(checkOut),
      priceType, policy, branch, adults, children, maxAdults, maxChildren, maxOccupancy,
    })

    if (result.error) {
      return res.status(400).json({
        success: false,
        code:    result.error.code,
        message: result.error.message,
        data: {
          finalPriceType:  result.error.finalPriceType,
          availableTypes:  result.error.availableTypes,
          availableLabels: result.error.availableLabels,
          policyName:      policy?.name ?? '',
        },
      })
    }

    res.json({
      success: true,
      data: {
        ...result,
        totalAmount: result.roomAmount,
        policyId:    policy?._id ?? null,
        policyName:  policy?.name ?? '',
      },
    })
  } catch (err) { next(err) }
}
// ── CREATE ────────────────────────────────────────────
const create = async (req, res, next) => {
  try {
    const {
      customerName, roomId,
      checkIn, checkOut,
      priceType = 'day', adults = 2, children = 0,
      notes = '', source = 'Trực tiếp', discount = 0,
      policyId,
      status: requestedStatus,
      confirmConvert = false,
    } = req.body

    let customerPhone = (req.body.customerPhone ?? '').toString().trim()

    if (!customerName || !roomId || !checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc (tên khách / phòng / ngày)' })

    const room = await Room.findById(roomId).populate('typeId')
    if (!room) return res.status(404).json({ success: false, message: 'Không tìm thấy phòng' })
    if (room.roomStatus === 'inactive')    return res.status(400).json({ success: false, message: 'Phòng đã tạm ngưng hoạt động' })
    if (room.roomStatus === 'maintenance') return res.status(400).json({ success: false, message: 'Phòng đang bảo trì' })

    const checkInDate  = new Date(checkIn)
    const checkOutDate = new Date(checkOut)
    if (checkOutDate <= checkInDate)
      return res.status(400).json({ success: false, message: 'Ngày check-out phải sau check-in' })

    // ⭐ Determine effective interval cho conflict check
    const validInitialEarly = ['reserved', 'confirmed', 'checked_in']
    const initialStatusEarly = validInitialEarly.includes(requestedStatus) ? requestedStatus : 'reserved'
    const willCheckInNow = initialStatusEarly === 'checked_in'
    const nowForCreate = new Date()

    // ⭐ FIX 07/05/2026: Chặn đặt phòng / nhận phòng ở quá khứ
    //
    //   Rule 1: status='reserved/confirmed' (đặt trước):
    //     - checkIn và checkOut phải > now
    //     - Cho phép trễ tối đa 60 giây (tránh lỗi clock skew)
    //
    //   Rule 2: status='checked_in' (nhận phòng ngay):
    //     - checkOut PHẢI > now (không thể "nhận phòng" với giờ trả đã qua)
    //     - checkIn cho phép quá khứ (nhập backdate cho khách đã đến trước, vd
    //       nhân viên nhập muộn) — đúng business
    //
    //   Cả 2 rule: nếu Admin/Manager → có thể bypass (cho nhập backdate hợp lệ)
    {
      const nowMs = nowForCreate.getTime()
      const tolerance = 60 * 1000  // 60s tolerance

      if (!willCheckInNow) {
        // Đặt trước: cả checkIn và checkOut phải tương lai
        if (checkInDate.getTime() < nowMs - tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PAST_CHECKIN',
            message: `Không thể đặt phòng với giờ nhận phòng (${checkInDate.toLocaleString('vi-VN')}) đã qua. Vui lòng chọn giờ nhận phòng từ ${nowForCreate.toLocaleString('vi-VN')} trở đi, hoặc chuyển sang "Nhận phòng ngay" nếu khách đã đến.`,
            data: { now: nowForCreate, requestedCheckIn: checkInDate },
          })
        }
        if (checkOutDate.getTime() < nowMs - tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PAST_CHECKOUT',
            message: `Không thể đặt phòng với giờ trả phòng (${checkOutDate.toLocaleString('vi-VN')}) đã qua. Vui lòng chọn giờ trả phòng sau ${nowForCreate.toLocaleString('vi-VN')}.`,
            data: { now: nowForCreate, requestedCheckOut: checkOutDate },
          })
        }
      } else {
        // Nhận phòng ngay: checkOut bắt buộc tương lai
        if (checkOutDate.getTime() < nowMs - tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PAST_CHECKOUT',
            message: `Không thể nhận phòng với giờ trả phòng dự kiến (${checkOutDate.toLocaleString('vi-VN')}) đã qua so với hiện tại (${nowForCreate.toLocaleString('vi-VN')}). Vui lòng chọn giờ trả phòng trong tương lai.`,
            data: { now: nowForCreate, requestedCheckOut: checkOutDate },
          })
        }
        // checkIn quá khứ thì OK cho status='checked_in' (backdate)
      }
    }

    const conflictIntervalStart = willCheckInNow && nowForCreate < checkInDate
      ? nowForCreate
      : checkInDate
    const conflictIntervalEnd = checkOutDate

    const conflictResult = await findOverlapForNewBooking({
      roomId,
      intervalStart: conflictIntervalStart,
      intervalEnd:   conflictIntervalEnd,
      actionType:    willCheckInNow ? 'checkin' : 'reserve',
    })
    if (conflictResult) {
      const { conflict, conflictStart, conflictEnd, conflictStatus, isStillCheckedIn } = conflictResult
      const statusLabel = {
        reserved:   'đã đặt',
        confirmed:  'đã xác nhận',
        checked_in: isStillCheckedIn ? 'đang ở (chưa trả phòng)' : 'đang ở',
      }[conflictStatus] ?? conflictStatus
      const actionLabel = willCheckInNow ? 'nhận phòng ngay' : 'đặt phòng'
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_OVERLAP',
        message: isStillCheckedIn
          ? `Không thể ${actionLabel} — phòng đang có khách ${conflict.customerName} chưa trả phòng (dự kiến trả ${new Date(conflictEnd).toLocaleString('vi-VN')}). Vui lòng xử lý trả phòng cho khách hiện tại trước.`
          : `Không thể ${actionLabel} — phòng đang có khách (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}.${willCheckInNow ? ` Bạn muốn nhận phòng từ ${nowForCreate.toLocaleString('vi-VN')} nhưng phòng đang bị chiếm.` : ' Vui lòng chọn khoảng giờ khác.'}`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          conflictCheckOut:     conflictEnd,
          conflictStatus,
          isStillCheckedIn,
          attemptedCheckInAt:   willCheckInNow ? nowForCreate : null,
          requestedCheckIn:     checkInDate,
          requestedCheckOut:    checkOutDate,
        },
      })
    }

    const branch = await Branch.findById(room.branchId)

    const applyTimeIfMidnight = (date, timeStr) => {
      const d = new Date(date)
      if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
        const [h, m] = String(timeStr ?? '14:00').split(':').map(Number)
        d.setHours(h, m, 0, 0)
      }
      return d
    }
    const checkInFinal  = applyTimeIfMidnight(checkInDate,  branch?.checkInTime  || '14:00')
    const checkOutFinal = applyTimeIfMidnight(checkOutDate, branch?.checkOutTime || '12:00')

    let policy = policyId ? await PricePolicy.findById(policyId) : null
    if (!policy) policy = await PricePolicy.findOne({ roomTypeId: room.typeId, branchId: room.branchId, isActive: true })

    const maxAdults   = room.typeId?.maxAdults   ?? room.typeId?.capacity ?? 2
    const maxChildren = room.typeId?.maxChildren ?? 0
    const maxOccupancy = room.typeId?.maxOccupancy ?? (maxAdults + maxChildren)

    // ⭐ NEW 18/05/2026: BLOCK nếu tổng người vượt maxOccupancy
    if ((adults + children) > maxOccupancy) {
      return res.status(400).json({
        success: false,
        code:    'OVER_CAPACITY',
        message: `Phòng chỉ hỗ trợ tối đa ${maxOccupancy} người.`,
        data: {
          maxOccupancy,
          requested: adults + children,
          adults, children,
          maxAdults, maxChildren,
          roomNumber: room.number,
        },
      })
    }

    const priceResult = calculatePrice({
      checkIn:  checkInFinal,
      checkOut: checkOutFinal,
      priceType, policy, branch, adults, children, maxAdults, maxChildren, maxOccupancy,
    })

    if (priceResult.error) {
      return res.status(400).json({
        success: false,
        code:    priceResult.error.code,
        message: priceResult.error.message,
        data: {
          finalPriceType:  priceResult.error.finalPriceType,
          availableTypes:  priceResult.error.availableTypes,
          availableLabels: priceResult.error.availableLabels,
          policyName:      policy?.name ?? '',
        },
      })
    }

    if (priceResult.converted && !confirmConvert) {
      return res.status(422).json({
        success: false,
        code:    'NEEDS_CONFIRMATION',
        message: priceResult.notice,
        data: {
          ...priceResult,
          totalAmount: priceResult.roomAmount,
        },
      })
    }

    const roomAmount  = priceResult.roomAmount
    const totalAmount = roomAmount - (discount ?? 0)

    let customer
    if (customerPhone) {
      customer = await Customer.findOne({ phone: customerPhone })
      if (!customer) customer = await Customer.create({ name: customerName, phone: customerPhone })
    } else {
      customer = await Customer.create({ name: customerName })
    }

    const validInitial  = ['reserved', 'confirmed', 'checked_in']
    const initialStatus = validInitial.includes(requestedStatus) ? requestedStatus : 'reserved'

    const booking = await Booking.create({
      customerId:   customer._id,
      customerName, customerPhone,
      roomId:       room._id,
      roomNumber:   room.number,
      roomType:     room.typeName,
      branchId:     room.branchId,
      checkIn:      checkInFinal,
      checkOut:     checkOutFinal,
      nights:       priceResult.nights,
      priceType:    priceResult.finalPriceType,
      adults, children,
      notes, source,
      discount,
      discountPercent: 0,
      discountAmount:  discount ?? 0,
      isFreeRoom:      false,
      roomAmount, totalAmount,
      servicesAmount: 0,
      priceBreakdown: priceResult.breakdown,
      policyId:       policy?._id ?? null,
      policyName:     policy?.name ?? '',
      policySnapshot: policy ? buildPolicySnapshot(policy, room.typeId?.capacity ?? null) : null,
      status:         initialStatus,
      actualCheckIn:  initialStatus === 'checked_in' ? new Date() : null,
    })

    await Room.findByIdAndUpdate(roomId, {
      currentBookingId: booking._id,
      currentGuestName: customerName,
    })

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: initialStatus === 'checked_in' ? 'create_and_checkin' : 'create',
      description: initialStatus === 'checked_in'
        ? `Nhận phòng ${room.number} cho ${customerName}`
        : `Tạo đặt phòng ${room.number} cho ${customerName}`,
      user: req.user, branchId: room.branchId,
      metadata: {
        roomNumber: room.number, customerName,
        checkIn: checkInFinal, checkOut: checkOutFinal,
        totalAmount, status: initialStatus,
      },
    })

    res.status(201).json({
      success: true,
      message: initialStatus === 'checked_in' ? 'Nhận phòng thành công' : 'Tạo đặt phòng thành công',
      data: {
        booking,
        priceBreakdown: priceResult.breakdown,
        converted:      priceResult.converted,
        notice:         priceResult.notice,
      },
    })
  } catch (err) { next(err) }
}

// ── UPDATE ────────────────────────────────────────────
const update = async (req, res, next) => {
  try {
    const allowed = [
      'customerName', 'customerPhone', 'checkIn', 'checkOut',
      'adults', 'children', 'notes', 'source', 'discount', 'paymentStatus',
    ]
    const payload = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k] })

    if (payload.checkIn || payload.checkOut) {
      const booking = await Booking.findById(req.params.id)
      if (booking) {
        const checkIn  = new Date(payload.checkIn  ?? booking.checkIn)
        const checkOut = new Date(payload.checkOut ?? booking.checkOut)
        payload.nights      = Math.max(1, Math.ceil((checkOut - checkIn) / 86400000))
        payload.roomAmount  = booking.roomAmount / booking.nights * payload.nights
        payload.totalAmount = payload.roomAmount + (booking.servicesAmount ?? 0) - (payload.discount ?? booking.discount ?? 0)
      }
    }

    const booking = await Booking.findByIdAndUpdate(req.params.id, payload, { new: true })
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

    const changedFields = Object.keys(payload).filter(k => !['nights','roomAmount','totalAmount'].includes(k))
    if (changedFields.length > 0) {
      await logAction({
        entityType: 'Booking', entityId: booking._id,
        action: 'update',
        description: `Cập nhật ${changedFields.join(', ')}`,
        user: req.user, branchId: booking.branchId,
        metadata: { changedFields, payload },
      })
    }

    res.json({ success: true, message: 'Cập nhật thành công', data: { booking } })
  } catch (err) { next(err) }
}

// ── CHANGE DATES ──────────────────────────────────────
const changeDates = async (req, res, next) => {
  try {
    const { checkIn, checkOut, confirmConvert = false } = req.body
    if (!checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Thiếu checkIn/checkOut' })

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (['cancelled', 'checked_out'].includes(booking.status))
      return res.status(400).json({ success: false, message: `Không thể đổi ngày ở trạng thái: ${booking.status}` })

    // ⭐ FIX 23/05/2026: Lưu ngày + tiền CŨ trước khi đổi — cho audit log "cũ → mới".
    const _oldCheckIn   = booking.actualCheckIn ?? booking.checkIn
    const _oldCheckOut  = booking.checkOut
    const _oldRoomAmt   = booking.roomAmount

    const newCheckIn  = new Date(checkIn)
    const newCheckOut = new Date(checkOut)
    if (newCheckOut <= newCheckIn)
      return res.status(400).json({ success: false, message: 'Ngày check-out phải sau check-in' })

    // ⭐ FIX 07/05/2026: Nếu booking đã `checked_in`, newCheckIn KHÔNG được ở tương lai
    //   Lý do: booking đã `checked_in` → `actualCheckIn` phải ≤ hiện tại (khách đã nhận phòng)
    //   Code dưới sẽ set actualCheckIn = newCheckIn nếu status='checked_in',
    //   nên ta phải block trước khi tới đoạn đó.
    //   Ngược lại nếu booking 'reserved/confirmed', newCheckIn ở tương lai OK.
    if (booking.status === 'checked_in') {
      const now = new Date()
      if (newCheckIn.getTime() > now.getTime() + 60 * 1000) {  // 60s tolerance
        return res.status(400).json({
          success: false,
          code: 'INVALID_FUTURE_ACTUAL_CHECKIN',
          message: `Phòng đã nhận — giờ nhận phòng thực tế (${newCheckIn.toLocaleString('vi-VN')}) không được ở tương lai so với hiện tại (${now.toLocaleString('vi-VN')}). Vui lòng chọn giờ trong quá khứ hoặc hiện tại.`,
          data: {
            now,
            requestedCheckIn:    newCheckIn,
            currentStatus:       booking.status,
            currentActualCheckIn: booking.actualCheckIn,
          },
        })
      }
    } else {
      // Booking chưa check-in (reserved/confirmed): newCheckIn không được ở quá khứ
      const now = new Date()
      if (newCheckIn.getTime() < now.getTime() - 60 * 1000) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_PAST_CHECKIN',
          message: `Không thể đổi giờ nhận phòng sang quá khứ (${newCheckIn.toLocaleString('vi-VN')}). Vui lòng chọn giờ từ ${now.toLocaleString('vi-VN')} trở đi.`,
          data: { now, requestedCheckIn: newCheckIn },
        })
      }
    }
    // Cả 2 trường hợp: newCheckOut phải > now (không cho đổi sang quá khứ)
    {
      const now = new Date()
      if (newCheckOut.getTime() < now.getTime() - 60 * 1000) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_PAST_CHECKOUT',
          message: `Không thể đổi giờ trả phòng sang quá khứ (${newCheckOut.toLocaleString('vi-VN')}). Vui lòng chọn giờ sau ${now.toLocaleString('vi-VN')}.`,
          data: { now, requestedCheckOut: newCheckOut },
        })
      }
    }

    const allRoomIds = [booking.roomId]
    if (Array.isArray(booking.rooms)) {
      for (const sr of booking.rooms) {
        if (sr.roomId) allRoomIds.push(sr.roomId)
      }
    }

    for (const rid of allRoomIds) {
      if (!rid) continue
      const conflictResult = await findOverlapForNewBooking({
        roomId:        rid,
        intervalStart: newCheckIn,
        intervalEnd:   newCheckOut,
        excludeBookingIds: [booking._id],
        actionType:    'reserve',
      })
      if (conflictResult) {
        const { conflict, conflictStart, conflictEnd, conflictStatus, isStillCheckedIn } = conflictResult
        const statusLabel = {
          reserved:   'đã đặt',
          confirmed:  'đã xác nhận',
          checked_in: isStillCheckedIn ? 'đang ở (chưa trả phòng)' : 'đang ở',
        }[conflictStatus] ?? conflictStatus
        return res.status(400).json({
          success: false,
          code: 'CONFLICT_OVERLAP',
          message: isStillCheckedIn
            ? `Phòng đang có khách ${conflict.customerName} chưa trả phòng. Vui lòng xử lý trả phòng cho khách hiện tại trước.`
            : `Trùng với đặt phòng khác (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}`,
          data: {
            conflictBookingId:    conflict._id,
            conflictCustomerName: conflict.customerName,
            conflictCheckIn:      conflictStart,
            conflictCheckOut:     conflictEnd,
            conflictStatus,
            isStillCheckedIn,
          },
        })
      }
    }

    const room   = await Room.findById(booking.roomId).populate('typeId')
    const branch = await Branch.findById(booking.branchId)
    const policy = booking.policyId ? await PricePolicy.findById(booking.policyId) : null
    const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
    const maxChildren = room?.typeId?.maxChildren ?? 0

    const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)

    // ⭐ FIX 19/05/2026: Nếu đã có transferHistory, KHÔNG dùng calculatePrice thẳng
    //   vì sẽ tính toàn bộ thời gian theo policy phòng MỚI → mất segment phòng cũ.
    //   Dùng computeMoveRoomBreakdown để phân đoạn đúng [oldRoom → transferAt → newRoom].
    const hasTransfer = Array.isArray(booking.transferHistory) && booking.transferHistory.length > 0
    let priceResult

    if (hasTransfer) {
      // ⭐ FIX 24/05/2026: REBUILD breakdown từ transferHistory — hỗ trợ N lần đổi.
      //   (Trước đây chặn ≥2 transfer; nay rebuild từ đầu nên đổi ngày luôn đúng.)
      const rebuilt = await rebuildBookingBreakdown(booking, branch, {
        plannedCheckOut: newCheckOut,
      })

      if (rebuilt && Array.isArray(rebuilt.breakdown) && rebuilt.breakdown.length > 0) {
        const actualCIForNights = booking.actualCheckIn ?? newCheckIn
        const dayStartOf = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
        const newNights = Math.max(1, Math.round(
          (dayStartOf(newCheckOut) - dayStartOf(actualCIForNights)) / 86400000
        ))
        priceResult = {
          roomAmount:     rebuilt.roomAmount,
          nights:         newNights,
          breakdown:      rebuilt.breakdown,
          finalPriceType: booking.priceType,
          converted:      false,
          notice:         rebuilt.errors && rebuilt.errors.length
            ? `Một số chặng không tính được giá: ${rebuilt.errors.map(e => e.roomNumber).join(', ')}`
            : null,
        }
      } else {
        // Fallback: không rebuild được → tính như booking thường (không transfer)
        priceResult = calculatePrice({
          checkIn: newCheckIn, checkOut: newCheckOut,
          priceType: booking.priceType, policy, branch,
          adults: booking.adults, children: booking.children, maxAdults, maxChildren, maxOccupancy,
        })
      }
    } else {
      priceResult = calculatePrice({
        checkIn: newCheckIn, checkOut: newCheckOut,
        priceType: booking.priceType, policy, branch,
        adults: booking.adults, children: booking.children, maxAdults, maxChildren, maxOccupancy,
      })
    }

    if (priceResult.error) {
      return res.status(400).json({
        success: false,
        code:    priceResult.error.code,
        message: priceResult.error.message,
        data: {
          finalPriceType:  priceResult.error.finalPriceType,
          availableTypes:  priceResult.error.availableTypes,
          availableLabels: priceResult.error.availableLabels,
          policyName:      policy?.name ?? '',
        },
      })
    }

    if (priceResult.converted && !confirmConvert) {
      return res.status(422).json({
        success: false,
        code: 'NEEDS_CONFIRMATION',
        message: priceResult.notice,
        data: { ...priceResult, totalAmount: priceResult.roomAmount },
      })
    }

    booking.checkOut    = newCheckOut
    booking.nights      = priceResult.nights
    booking.priceType   = priceResult.finalPriceType
    booking.roomAmount  = priceResult.roomAmount
    // ⭐ FIX 19/05/2026: Lưu priceBreakdown mới vào DB (trước đây chỉ trả response).
    //   Nếu không lưu, mode='checkout' của calculateBill sẽ đọc DB stale.
    if (Array.isArray(priceResult.breakdown)) {
      booking.priceBreakdown = priceResult.breakdown.map(b => ({
        label:  b.label,
        amount: b.amount,
        type:   b.type,
        meta:   b.meta || {},
      }))
    }
    // ⭐ FIX 19/05/2026: Include transferFee trong totalAmount (trước đây bỏ sót).
    booking.totalAmount = Math.max(0,
      priceResult.roomAmount
        + (booking.servicesAmount ?? 0)
        - (booking.discount ?? 0)
        + (booking.transferFee ?? 0)
    )

    let updatedActualCheckIn = false
    if (booking.status === 'checked_in') {
      booking.actualCheckIn = newCheckIn
      updatedActualCheckIn  = true
    } else {
      booking.checkIn = newCheckIn
    }
    await booking.save()

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'change_dates',
      description: updatedActualCheckIn
        ? `Đổi giờ nhận: ${new Date(_oldCheckIn).toLocaleString('vi-VN')} → ${new Date(newCheckIn).toLocaleString('vi-VN')} | trả: ${new Date(_oldCheckOut).toLocaleString('vi-VN')} → ${new Date(newCheckOut).toLocaleString('vi-VN')}`
        : `Đổi ngày ở: ${new Date(_oldCheckIn).toLocaleString('vi-VN')} → ${new Date(newCheckIn).toLocaleString('vi-VN')} | ${new Date(_oldCheckOut).toLocaleString('vi-VN')} → ${new Date(newCheckOut).toLocaleString('vi-VN')}`,
      user: req.user, branchId: booking.branchId,
      metadata: {
        oldCheckIn: _oldCheckIn, oldCheckOut: _oldCheckOut, oldRoomAmount: _oldRoomAmt,
        newCheckIn, newCheckOut,
        nights: booking.nights,
        roomAmount: booking.roomAmount,
        updatedActualCheckIn,
      },
    })

    res.json({
      success: true,
      message: 'Đổi ngày thành công',
      data: { booking, priceBreakdown: priceResult.breakdown, notice: priceResult.notice },
    })
  } catch (err) { next(err) }
}

// ⭐ PATCH /bookings/:id/change-dates-room
const changeDatesRoom = async (req, res, next) => {
  try {
    const { roomId: subRoomId, checkIn, checkOut, confirmConvert = false } = req.body
    console.log('[changeDatesRoom] bookingId=', req.params.id, 'subRoomId=', subRoomId, 'checkIn=', checkIn, 'checkOut=', checkOut)
    if (!subRoomId || !checkIn || !checkOut) {
      return res.status(400).json({ success: false, message: 'Thiếu roomId/checkIn/checkOut' })
    }

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (['cancelled', 'checked_out'].includes(booking.status)) {
      return res.status(400).json({ success: false, message: `Không thể đổi ngày ở trạng thái: ${booking.status}` })
    }
    if (!Array.isArray(booking.rooms) || booking.rooms.length === 0) {
      return res.status(400).json({ success: false, message: 'Booking không có phòng đoàn' })
    }

    const subRoom = booking.rooms.find(sr => String(sr.roomId?._id ?? sr.roomId) === String(subRoomId))
    if (!subRoom) {
      return res.status(404).json({ success: false, message: 'Phòng không thuộc đoàn này' })
    }
    if (['cancelled', 'checked_out'].includes(subRoom.status)) {
      return res.status(400).json({ success: false, message: `Không thể đổi ngày phòng ở trạng thái: ${subRoom.status}` })
    }

    const newCheckIn  = new Date(checkIn)
    const newCheckOut = new Date(checkOut)
    if (newCheckOut <= newCheckIn) {
      return res.status(400).json({ success: false, message: 'Ngày check-out phải sau check-in' })
    }

    // ⭐ FIX 07/05/2026: Cùng logic như changeDates()
    //   - Sub-room đã `checked_in` → newCheckIn không được tương lai
    //   - Sub-room `reserved/confirmed` → newCheckIn không được quá khứ
    //   - newCheckOut không được quá khứ (cả 2 trường hợp)
    {
      const now = new Date()
      const nowMs = now.getTime()
      const tolerance = 60 * 1000

      if (subRoom.status === 'checked_in') {
        if (newCheckIn.getTime() > nowMs + tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_FUTURE_ACTUAL_CHECKIN',
            message: `Phòng ${subRoom.roomNumber} đã nhận — giờ nhận phòng thực tế (${newCheckIn.toLocaleString('vi-VN')}) không được ở tương lai so với hiện tại (${now.toLocaleString('vi-VN')}).`,
            data: {
              now, requestedCheckIn: newCheckIn,
              roomNumber: subRoom.roomNumber,
              currentStatus: subRoom.status,
              currentActualCheckIn: subRoom.actualCheckIn,
            },
          })
        }
      } else {
        if (newCheckIn.getTime() < nowMs - tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PAST_CHECKIN',
            message: `Không thể đổi giờ nhận phòng ${subRoom.roomNumber} sang quá khứ (${newCheckIn.toLocaleString('vi-VN')}).`,
            data: { now, requestedCheckIn: newCheckIn, roomNumber: subRoom.roomNumber },
          })
        }
      }

      if (newCheckOut.getTime() < nowMs - tolerance) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_PAST_CHECKOUT',
          message: `Không thể đổi giờ trả phòng ${subRoom.roomNumber} sang quá khứ (${newCheckOut.toLocaleString('vi-VN')}).`,
          data: { now, requestedCheckOut: newCheckOut, roomNumber: subRoom.roomNumber },
        })
      }
    }

    const conflictResult = await findOverlapForNewBooking({
      roomId:        subRoomId,
      intervalStart: newCheckIn,
      intervalEnd:   newCheckOut,
      excludeBookingIds: [booking._id],
      actionType:    'reserve',
    })
    if (conflictResult) {
      const { conflict, conflictStart, conflictEnd, conflictStatus, isStillCheckedIn } = conflictResult
      const statusLabel = {
        reserved:   'đã đặt',
        confirmed:  'đã xác nhận',
        checked_in: isStillCheckedIn ? 'đang ở (chưa trả phòng)' : 'đang ở',
      }[conflictStatus] ?? conflictStatus
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_OVERLAP',
        message: isStillCheckedIn
          ? `Phòng ${subRoom.roomNumber} đang có khách ${conflict.customerName} chưa trả phòng. Vui lòng xử lý trả phòng trước.`
          : `Phòng ${subRoom.roomNumber} bị trùng với đặt phòng khác (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          conflictCheckOut:     conflictEnd,
          conflictStatus,
          isStillCheckedIn,
        },
      })
    }

    const room   = await Room.findById(subRoom.roomId).populate('typeId')
    const branch = await Branch.findById(booking.branchId)
    const policy = subRoom.policyId ? await PricePolicy.findById(subRoom.policyId)
                  : booking.policyId ? await PricePolicy.findById(booking.policyId)
                  : null
    const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
    const maxChildren = room?.typeId?.maxChildren ?? 0

    const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
    const priceResult = calculatePrice({
      checkIn:   newCheckIn,
      checkOut:  newCheckOut,
      priceType: subRoom.priceType ?? booking.priceType,
      policy, branch,
      adults:    subRoom.adults    ?? booking.adults,
      children:  subRoom.children  ?? booking.children,
      maxAdults, maxChildren, maxOccupancy,
    })

    if (priceResult.error) {
      return res.status(400).json({
        success: false,
        code:    priceResult.error.code,
        message: priceResult.error.message,
        data: {
          finalPriceType:  priceResult.error.finalPriceType,
          availableTypes:  priceResult.error.availableTypes,
          availableLabels: priceResult.error.availableLabels,
          policyName:      policy?.name ?? '',
          roomNumber:      subRoom.roomNumber,
        },
      })
    }

    if (priceResult.converted && !confirmConvert) {
      return res.status(422).json({
        success: false,
        code: 'NEEDS_CONFIRMATION',
        message: priceResult.notice,
        data: { ...priceResult, totalAmount: priceResult.roomAmount },
      })
    }

    const oldCheckIn  = subRoom.checkIn  ?? booking.checkIn
    const oldCheckOut = subRoom.checkOut ?? booking.checkOut
    const oldActualCheckIn = subRoom.actualCheckIn ?? null

    let updatedActualCheckIn = false
    if (subRoom.status === 'checked_in') {
      subRoom.actualCheckIn = newCheckIn
      updatedActualCheckIn  = true
    } else {
      subRoom.checkIn = newCheckIn
    }
    subRoom.checkOut       = newCheckOut
    subRoom.nights         = priceResult.nights
    subRoom.priceType      = priceResult.finalPriceType
    subRoom.roomAmount     = priceResult.roomAmount
    subRoom.priceBreakdown = (priceResult.breakdown ?? []).map(b => ({
      label:  String(b.label ?? ''),
      amount: Number(b.amount ?? 0),
      type:   b.type === 'surcharge' ? 'surcharge' : 'base',
      meta:   { ...(b.meta || {}), roomNumber: subRoom.roomNumber },
    }))

    for (const other of booking.rooms) {
      if (other === subRoom) continue
      if (!other.checkIn)  other.checkIn  = booking.checkIn
      if (!other.checkOut) other.checkOut = booking.checkOut
      if (!other.nights)   other.nights   = booking.nights
    }

    booking.roomAmount = booking.rooms.reduce((s, sr) => s + (sr.roomAmount ?? 0), 0)
    booking.totalAmount = booking.roomAmount + (booking.servicesAmount ?? 0) - (booking.discount ?? 0) + (booking.transferFee ?? 0)

    const allCheckIns  = booking.rooms.map(sr => sr.checkIn  ?? booking.checkIn)
    const allCheckOuts = booking.rooms.map(sr => sr.checkOut ?? booking.checkOut)
    booking.checkIn  = new Date(Math.min(...allCheckIns.map(d => new Date(d).getTime())))
    booking.checkOut = new Date(Math.max(...allCheckOuts.map(d => new Date(d).getTime())))

    await booking.save()

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'change_dates',
      description: updatedActualCheckIn
        ? `Đổi giờ nhận phòng thực tế (${subRoom.roomNumber}): ${oldActualCheckIn ? new Date(oldActualCheckIn).toLocaleString('vi-VN') : '—'} → ${newCheckIn.toLocaleString('vi-VN')} | trả: ${newCheckOut.toLocaleString('vi-VN')}`
        : `Đổi ngày phòng ${subRoom.roomNumber}: ${new Date(oldCheckIn).toLocaleString('vi-VN')} → ${newCheckIn.toLocaleString('vi-VN')} | ${new Date(oldCheckOut).toLocaleString('vi-VN')} → ${newCheckOut.toLocaleString('vi-VN')}`,
      user: req.user, branchId: booking.branchId,
      metadata: {
        roomId: subRoomId, roomNumber: subRoom.roomNumber,
        oldCheckIn, oldCheckOut,
        oldActualCheckIn,
        newCheckIn, newCheckOut,
        nights: priceResult.nights, roomAmount: priceResult.roomAmount,
        bookingId: booking._id,
        updatedActualCheckIn,
      },
    })

    res.json({
      success: true,
      message: `Đã đổi ngày phòng ${subRoom.roomNumber}`,
      data: { booking, priceBreakdown: priceResult.breakdown, notice: priceResult.notice },
    })
  } catch (err) {
    console.error('[changeDatesRoom] error:', err)
    next(err)
  }
}
// ── MOVE ROOM ─────────────────────────────────────────
const moveRoom = async (req, res, next) => {
  try {
    const {
      roomId: newRoomId,
      subRoomId  = null,
      reason     = '',
      applyNewPrice = false,
      newPolicyId   = null,
      transferFee   = 0,
      transferAt    = null,
    } = req.body

    if (!newRoomId) return res.status(400).json({ success: false, message: 'Thiếu roomId mới' })

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (['cancelled', 'checked_out'].includes(booking.status))
      return res.status(400).json({ success: false, message: `Không thể chuyển phòng ở trạng thái: ${booking.status}` })

    // ⭐ NEW 25/05/2026: Chặn chuyển phòng khi phòng ĐÃ QUÁ HẠN (checkOut < hiện tại).
    //   Phải gia hạn (đổi ngày trả phòng) trước, nếu không mốc chặng phòng mới rơi vào
    //   quá khứ → tính giá sai. So với booking.checkOut (đơn) hoặc sub-room checkOut (đoàn).
    //   FE cũng chặn + hiện modal; đây là lớp BE đảm bảo an toàn khi gọi API trực tiếp.
    {
      const _isGrp = Array.isArray(booking.rooms) && booking.rooms.length > 1
      let _co = booking.checkOut
      if (_isGrp) {
        const _tgt = subRoomId || booking.roomId
        const _sr = booking.rooms.find(sr => String(sr.roomId) === String(_tgt))
        if (_sr?.checkOut) _co = _sr.checkOut
      }
      if (_co && new Date(_co).getTime() < Date.now()) {
        return res.status(400).json({
          success: false,
          code: 'BOOKING_OVERDUE',
          message: 'Phòng đã quá hạn trả. Vui lòng gia hạn (đổi ngày trả phòng lớn hơn thời gian hiện tại) trước khi chuyển phòng.',
        })
      }
    }

    const isGroup = Array.isArray(booking.rooms) && booking.rooms.length > 1
    const targetSubRoomId = isGroup ? (subRoomId || booking.roomId) : null

    let subRoomIdx = -1
    let subRoom    = null
    if (isGroup) {
      subRoomIdx = booking.rooms.findIndex(sr => String(sr.roomId) === String(targetSubRoomId))
      if (subRoomIdx < 0) {
        return res.status(400).json({ success: false, message: 'Không tìm thấy phòng nguồn trong đoàn' })
      }
      subRoom = booking.rooms[subRoomIdx]
      if (['cancelled', 'checked_out'].includes(subRoom.status)) {
        return res.status(400).json({ success: false, message: `Không thể chuyển phòng ở trạng thái: ${subRoom.status}` })
      }
      if (String(subRoom.roomId) === String(newRoomId)) {
        return res.status(400).json({ success: false, message: 'Phòng đích trùng phòng hiện tại' })
      }
    } else {
      if (booking.roomId.toString() === newRoomId)
        return res.status(400).json({ success: false, message: 'Phòng đích trùng phòng hiện tại' })
    }

    const newRoom = await Room.findById(newRoomId).populate('typeId')
    if (!newRoom) return res.status(404).json({ success: false, message: 'Không tìm thấy phòng đích' })
    if (newRoom.roomStatus !== 'active')
      return res.status(400).json({ success: false, message: 'Phòng đích không khả dụng' })

    // ⭐ FIX 25/05/2026: Chặn chuyển vào phòng ĐÃ thuộc đoàn này (sub-room khác đang active).
    //   findOverlapForNewBooking exclude booking._id → KHÔNG phát hiện trùng NỘI BỘ đoàn,
    //   nên 201→202 khi 202 đã nằm trong đoàn vẫn lọt → rooms[] có 2 sub-room cùng roomId
    //   → calculate-bill tính phòng 2 lần (lỗi BK_EEHRKN: 202 hiện 2 dòng giá ngày + 2 phụ thu).
    //   Guard cũ (subRoom.roomId === newRoomId) chỉ chặn chuyển-về-chính-nó, không chặn phòng anh-em.
    if (isGroup) {
      const dupSubIdx = booking.rooms.findIndex((sr, idx) =>
        idx !== subRoomIdx &&
        String(sr.roomId?._id ?? sr.roomId) === String(newRoomId) &&
        !['cancelled', 'checked_out'].includes(sr.status)
      )
      if (dupSubIdx >= 0) {
        return res.status(400).json({
          success: false,
          code: 'ROOM_ALREADY_IN_GROUP',
          message: `Phòng ${newRoom.number} đã nằm trong đoàn này (đang sử dụng). Vui lòng chọn phòng đích khác.`,
        })
      }
    }

    const checkInRange  = (isGroup && subRoom?.checkIn)  ? subRoom.checkIn  : booking.checkIn
    const checkOutRange = (isGroup && subRoom?.checkOut) ? subRoom.checkOut : booking.checkOut

    const moveActionType = booking.status === 'checked_in' ? 'checkin' : 'reserve'
    const moveConflictResult = await findOverlapForNewBooking({
      roomId:        newRoomId,
      intervalStart: checkInRange,
      intervalEnd:   checkOutRange,
      excludeBookingIds: [booking._id],
      actionType:    moveActionType,
    })
    if (moveConflictResult) {
      const { conflict, conflictStart, conflictEnd, conflictStatus, isStillCheckedIn } = moveConflictResult
      const statusLabel = {
        reserved:   'đã đặt',
        confirmed:  'đã xác nhận',
        checked_in: isStillCheckedIn ? 'đang ở (chưa trả phòng)' : 'đang ở',
      }[conflictStatus] ?? conflictStatus
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_OVERLAP',
        message: isStillCheckedIn
          ? `Phòng đích đang có khách ${conflict.customerName} chưa trả phòng. Vui lòng xử lý trả phòng cho khách hiện tại trước.`
          : `Phòng đích đã có khách (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          conflictCheckOut:     conflictEnd,
          conflictStatus,
          isStillCheckedIn,
        },
      })
    }

    const oldRoomId      = isGroup ? subRoom.roomId       : booking.roomId
    const oldRoomNumber  = isGroup ? subRoom.roomNumber   : booking.roomNumber
    const oldPolicyId    = isGroup ? subRoom.policyId     : booking.policyId
    const oldRoom        = await Room.findById(oldRoomId).populate('typeId')

    const recalcMoveBreakdown = async ({
      sourceCheckIn, sourceCheckOut, sourceActualCheckIn,
      sourcePolicySnapshot, sourcePolicyId,
      sourcePriceType, sourceAdults, sourceChildren,
      currentRoomAmount, currentNights,
      sourcePriceBreakdown,   // ⭐ NEW: priceBreakdown gốc của phòng cũ — để preserve surcharge "Nhận phòng sớm"
    }) => {
      const newPolicy = await PricePolicy.findById(newPolicyId)
      if (!newPolicy) throw new Error('Không tìm thấy chính sách giá mới')

      const splitAt = transferAt ? new Date(transferAt) : new Date()
      const newMaxAdults   = newRoom.typeId?.maxAdults   ?? newRoom.typeId?.capacity ?? 2
      const newMaxChildren = newRoom.typeId?.maxChildren ?? 0

      let oldPolicy = null
      const snap = sourcePolicySnapshot
        ? (sourcePolicySnapshot.toObject ? sourcePolicySnapshot.toObject() : sourcePolicySnapshot)
        : null
      if (snap && (snap.dayEnabled || snap.hourEnabled || snap.nightEnabled || (snap.dayPrice && snap.dayPrice > 0) || (snap.nightPrice && snap.nightPrice > 0))) {
        oldPolicy = snap
      } else if (sourcePolicyId) {
        oldPolicy = await PricePolicy.findById(sourcePolicyId)
      }

      // ════════════════════════════════════════════════════════════════════
      // v20.0 (17/05/2026) — Dùng module moveRoomBreakdown thay logic split cũ
      // Logic chuẩn theo spec cuối cùng (9 case).
      // Xem: src/utils/moveRoomBreakdown.js
      // ════════════════════════════════════════════════════════════════════
      const oldRoomType = oldRoom?.typeName || snap?.roomTypeName || ''
      const newRoomType = newRoom.typeName || ''
      const hourSlotsOf = (pol) => {
        if (!pol) return []
        const slots = pol.hourSlots || pol.dayEarlyCheckIn || []
        return slots.map(s => {
          const time = s.time || s.duration || ''
          const m = String(time).match(/(\d+)/)
          const durationHours = m ? parseInt(m[1]) : 2
          return { durationHours, price: s.price || 0 }
        })
      }

      // ⭐ NEW 20/05/2026: Bảng giá GIỜ từ policy hourEnabled của roomType phòng MỚI
      const newRoomTypeIdMV = newRoom.typeId?._id || newRoom.typeId || null
      const newHourlyPolicyMV = await resolveHourlyPolicy(newRoomTypeIdMV, booking.branchId)
      const newRoomHourSlotsMV = newHourlyPolicyMV
        ? hourSlotsOf(newHourlyPolicyMV)
        : hourSlotsOf(newPolicy)

      const breakdownInput = {
        actualCheckIn:   new Date(sourceActualCheckIn || sourceCheckIn),
        plannedCheckOut: new Date(sourceCheckOut),
        transferAt:      splitAt,
        oldRoom: {
          number: oldRoomNumber,
          type:   oldRoomType,
          policy: {
            dayPrice:  oldPolicy?.dayPrice || 0,
            hourSlots: hourSlotsOf(oldPolicy),
          },
        },
        newRoom: {
          number: newRoom.number,
          type:   newRoomType,
          policy: {
            dayPrice:  newPolicy.dayPrice || 0,
            hourSlots: newRoomHourSlotsMV,
            dayCheckInTime: newPolicy.dayCheckInTime, dayCheckOutTime: newPolicy.dayCheckOutTime,
            dayEarlyCheckIn: newPolicy.dayEarlyCheckIn, dayLateCheckOut: newPolicy.dayLateCheckOut,
            dayAdultSurcharge: newPolicy.dayAdultSurcharge, dayChildSurcharge: newPolicy.dayChildSurcharge,
          },
        },
        transferFee: 0,    // fee được handle riêng ở booking.transferFee
        // ⭐ FIX 25/05/2026: changeRate theo Ý ĐỊNH nhân viên (so policyId), KHÔNG suy từ loại
        //   phòng. "Giữ giá cũ" (phòng hỏng) → không đổi policy → changeRate=false → giữ giá gốc.
        changeRate:  String(sourcePolicyId ?? '') !== String(newPolicyId ?? ''),
        isFreeRoom:  !!booking.isFreeRoom,
      }

      let items = []
      try {
        items = computeMoveRoomBreakdown(breakdownInput)
      } catch (e) {
        console.error('[moveRoom v20] compute error:', e.message)
        // Fallback: giữ amount cũ, không inject breakdown sai
        return {
          roomAmount: currentRoomAmount,
          priceBreakdown: [],
          usedSplit: splitAt,
          newPolicy,
          newMaxAdults,
          newMaxChildren,
        }
      }

      // Loại bỏ fee item (BE handle riêng qua booking.transferFee)
      const breakdownItems = items
        .filter(it => !(it.meta && it.meta.transferFee))
        .map(it => ({
          label: it.label,
          amount: it.amount,
          type: it.type === 'surcharge' ? 'surcharge' : 'base',
          meta: it.meta || {},
        }))

      // ⭐ FIX 18/05/2026 (v20.1) — PRESERVE surcharge "Nhận phòng sớm" của phòng cũ
      //   moveRoomBreakdown CHỈ tính tiền phòng base, không có surcharge.
      //   Nhưng "Nhận phòng sớm" của phòng CŨ (201) là sự kiện đã xảy ra lúc CI thật
      //   → PHẢI giữ lại trong priceBreakdown sau move, nếu không sẽ MẤT 100K phụ thu.
      //
      //   Lấy từ sourcePriceBreakdown (caller truyền vào): booking.priceBreakdown (single)
      //   hoặc subRoom.priceBreakdown (group). Filter type='surcharge' + label early CI.
      const sourceBreakdown = Array.isArray(sourcePriceBreakdown) ? sourcePriceBreakdown : []
      const preservedEarlyCI = sourceBreakdown
        .filter(b => {
          if (b?.type !== 'surcharge') return false
          const lbl = String(b?.label || '')
          return lbl.includes('Nhận phòng sớm') || lbl.includes('early_checkin')
        })
        .map(b => {
          const plain = (b && typeof b.toObject === 'function') ? b.toObject() : b
          const lblRaw = String(plain.label || '')
          const hasPrefix = /^\[[^\]]+\]\s/.test(lblRaw)
          return {
            label: hasPrefix ? lblRaw : `[${oldRoomNumber}] ${lblRaw}`,
            amount: plain.amount || 0,
            type: 'surcharge',
            meta: { ...(plain.meta || {}), roomNumber: oldRoomNumber, preserved: true },
          }
        })

      // Đặt early-CI surcharge ngay sau item base đầu tiên của phòng cũ (vị trí tự nhiên)
      const finalBreakdown = [...breakdownItems]
      if (preservedEarlyCI.length > 0) {
        let insertAt = -1
        for (let i = finalBreakdown.length - 1; i >= 0; i--) {
          const it = finalBreakdown[i]
          const itRoomNum = it?.meta?.roomNumber
          if (it?.type === 'base' && String(itRoomNum) === String(oldRoomNumber)) {
            insertAt = i + 1
            break
          }
        }
        if (insertAt < 0) insertAt = finalBreakdown.length
        finalBreakdown.splice(insertAt, 0, ...preservedEarlyCI)
      }

      const totalAmount = finalBreakdown.reduce((s, b) => s + (b.amount || 0), 0)

      return {
        roomAmount:     totalAmount,
        priceBreakdown: finalBreakdown,
        usedSplit:      splitAt,
        newPolicy,
        newMaxAdults,
        newMaxChildren,
      }
    }

    let policyChanged  = false
    let usedTransferAt = null
    const fee = Math.max(0, Number(transferFee) || 0)

    if (isGroup) {
      let newSubRoomAmount     = subRoom.roomAmount ?? 0
      let newSubPriceBreakdown = subRoom.priceBreakdown ?? []
      let newSubPolicyId       = subRoom.policyId
      let newSubPolicyName     = subRoom.policyName

      if (applyNewPrice && newPolicyId) {
        let sourceSnapshot = null
        const oldPolId = subRoom.policyId ?? booking.policyId
        if (oldPolId) {
          try {
            const oldPol = await PricePolicy.findById(oldPolId)
            if (oldPol) {
              const oldCap = oldRoom?.typeId?.capacity ?? booking.policySnapshot?.capacity ?? 2
              sourceSnapshot = buildPolicySnapshot(oldPol, oldCap)
            }
          } catch (e) {
            console.log('[moveRoom group] Error fetching oldPolicy:', e.message)
          }
        }
        if (!sourceSnapshot && booking.policySnapshot) {
          sourceSnapshot = booking.policySnapshot
        }

        const recalc = await recalcMoveBreakdown({
          sourceCheckIn:        subRoom.checkIn  ?? booking.checkIn,
          sourceCheckOut:       subRoom.checkOut ?? booking.checkOut,
          sourceActualCheckIn:  subRoom.actualCheckIn ?? null,
          sourcePolicySnapshot: sourceSnapshot,
          sourcePolicyId:       oldPolId,
          sourcePriceType:      subRoom.priceType ?? booking.priceType,
          sourceAdults:         subRoom.adults    ?? booking.adults,
          sourceChildren:       subRoom.children  ?? booking.children,
          currentRoomAmount:    subRoom.roomAmount ?? 0,
          currentNights:        subRoom.nights ?? booking.nights,
          sourcePriceBreakdown: subRoom.priceBreakdown ?? [],  // ⭐ FIX v20.1: preserve "Nhận phòng sớm"
        })
        newSubRoomAmount     = recalc.roomAmount
        newSubPriceBreakdown = recalc.priceBreakdown
        newSubPolicyId       = recalc.newPolicy._id
        newSubPolicyName     = recalc.newPolicy.name
        usedTransferAt       = recalc.usedSplit
        policyChanged        = true
      }

      booking.rooms[subRoomIdx].roomId         = newRoom._id
      booking.rooms[subRoomIdx].roomNumber     = newRoom.number
      booking.rooms[subRoomIdx].roomType       = newRoom.typeName
      booking.rooms[subRoomIdx].typeId         = newRoom.typeId?._id ?? newRoom.typeId
      if (applyNewPrice && newPolicyId) {
        booking.rooms[subRoomIdx].policyId       = newSubPolicyId
        booking.rooms[subRoomIdx].policyName     = newSubPolicyName
        booking.rooms[subRoomIdx].roomAmount     = newSubRoomAmount
        booking.rooms[subRoomIdx].priceBreakdown = newSubPriceBreakdown
      }
      booking.markModified('rooms')

      if (String(booking.roomId) === String(oldRoomId)) {
        booking.roomId     = newRoom._id
        booking.roomNumber = newRoom.number
        booking.roomType   = newRoom.typeName
      }

      booking.transferFee = (booking.transferFee || 0) + fee
      const totalRoomAmount = booking.rooms.reduce((s, r) => s + (r.roomAmount ?? 0), 0)
      booking.roomAmount = totalRoomAmount

      let recalcDiscount = booking.discount ?? 0
      if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
        const roomPart = booking.isFreeRoom ? 0 : totalRoomAmount
        const sub = roomPart + (booking.servicesAmount ?? 0)
        const pctDisc = Math.round(sub * (booking.discountPercent ?? 0) / 100)
        recalcDiscount = pctDisc + (booking.discountAmount ?? 0)
      }
      booking.discount    = recalcDiscount
      const subtotal = totalRoomAmount + (booking.servicesAmount ?? 0)
      booking.totalAmount = Math.max(0, subtotal - recalcDiscount + booking.transferFee)

      booking.transferHistory = booking.transferHistory || []
      booking.transferHistory.push({
        fromRoomId:     oldRoomId,
        fromRoomNumber: oldRoomNumber,
        toRoomId:       newRoom._id,
        toRoomNumber:   newRoom.number,
        transferAt:     usedTransferAt ?? new Date(),
        fee,
        oldPolicyId:    oldPolicyId,
        newPolicyId:    policyChanged ? newPolicyId : oldPolicyId,
        reason,
        subRoomId:      newRoom._id,
        by:             req.user?.id ?? req.user?._id ?? null,
      })

      booking.notes = `${booking.notes || ''}\n[Chuyển phòng (đoàn) ${oldRoomNumber} → ${newRoom.number}${fee > 0 ? ` • Phí: ${fee.toLocaleString('vi-VN')}đ` : ''}${policyChanged ? ' • Đổi giá' : ''}${reason ? ': ' + reason : ''}]`.trim()
      await booking.save()

      const stillUsedByThisBooking = booking.rooms.some(sr => String(sr.roomId) === String(oldRoomId))
      if (!stillUsedByThisBooking) {
        const oldRoomUpdate = {
          currentBookingId: null,
          currentGuestName: null,
        }
        if (subRoom.status === 'checked_in') {
          oldRoomUpdate.roomStatus = 'inactive'
        }
        await Room.findByIdAndUpdate(oldRoomId, oldRoomUpdate)
      }
      await Room.findByIdAndUpdate(newRoomId, {
        currentBookingId: booking._id,
        currentGuestName: booking.customerName,
      })

      try {
        const invoice = await Invoice.findOne({ bookingId: booking._id })
        if (invoice) {
          invoice.roomAmount      = booking.roomAmount
          invoice.discount        = booking.discount
          invoice.totalAmount     = booking.totalAmount
          invoice.remainingAmount = Math.max(0, invoice.totalAmount - (invoice.paidAmount ?? 0))
          invoice.paymentStatus   = invoice.paidAmount >= invoice.totalAmount ? 'paid' :
                                    invoice.paidAmount > 0 ? 'partial' : 'unpaid'
          await invoice.save()
        }
      } catch (e) {
        console.error('[moveRoom group] sync invoice failed (non-fatal):', e.message)
      }

      const auditDesc = [
        `Chuyển phòng (đoàn) ${oldRoomNumber} → ${newRoom.number}`,
        fee > 0 && `Phí ${fee.toLocaleString('vi-VN')}đ`,
        policyChanged && `Đổi giá`,
        reason,
      ].filter(Boolean).join(' • ')

      await logAction({
        entityType: 'Booking', entityId: booking._id,
        action: 'move_room',
        description: auditDesc,
        user: req.user, branchId: booking.branchId,
        metadata: {
          oldRoomNumber, newRoomNumber: newRoom.number,
          fee, policyChanged, newPolicyId, transferAt: usedTransferAt,
          newSubRoomAmount, newTotalAmount: booking.totalAmount,
          subRoomId: String(newRoom._id), groupMode: true,
          reason,
          bookingCode: booking.bookingCode,
        },
      })

      return res.json({
        success: true,
        message: `Chuyển phòng ${oldRoomNumber} → ${newRoom.number} thành công`,
        data: { booking },
      })
    }

    let newPriceBreakdown = booking.priceBreakdown
    let newRoomAmount     = booking.roomAmount

    if (applyNewPrice && newPolicyId) {
      const recalc = await recalcMoveBreakdown({
        sourceCheckIn:        booking.checkIn,
        sourceCheckOut:       booking.checkOut,
        sourceActualCheckIn:  booking.actualCheckIn,
        sourcePolicySnapshot: booking.policySnapshot,
        sourcePolicyId:       booking.policyId,
        sourcePriceType:      booking.priceType,
        sourceAdults:         booking.adults,
        sourceChildren:       booking.children,
        currentRoomAmount:    booking.roomAmount,
        currentNights:        booking.nights,
        sourcePriceBreakdown: booking.priceBreakdown ?? [],  // ⭐ FIX v20.1: preserve "Nhận phòng sớm"
      })
      newRoomAmount     = recalc.roomAmount
      newPriceBreakdown = recalc.priceBreakdown
      usedTransferAt    = recalc.usedSplit
      booking.policyId       = recalc.newPolicy._id
      booking.policyName     = recalc.newPolicy.name
      booking.policySnapshot = buildPolicySnapshot(recalc.newPolicy, (recalc.newMaxAdults ?? 0) + (recalc.newMaxChildren ?? 0))
      policyChanged          = true
    }

    booking.transferFee = (booking.transferFee || 0) + fee
    booking.roomAmount     = newRoomAmount
    booking.priceBreakdown = newPriceBreakdown
    const subtotal = newRoomAmount + (booking.servicesAmount ?? 0)

    let recalcDiscount = booking.discount ?? 0
    if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
      const roomPart = booking.isFreeRoom ? 0 : newRoomAmount
      const sub = roomPart + (booking.servicesAmount ?? 0)
      const pctDisc = Math.round(sub * (booking.discountPercent ?? 0) / 100)
      recalcDiscount = pctDisc + (booking.discountAmount ?? 0)
    }
    booking.discount    = recalcDiscount
    booking.totalAmount = Math.max(0, subtotal - recalcDiscount + booking.transferFee)

    booking.transferHistory = booking.transferHistory || []
    booking.transferHistory.push({
      fromRoomId:     oldRoomId,
      fromRoomNumber: oldRoomNumber,
      toRoomId:       newRoom._id,
      toRoomNumber:   newRoom.number,
      transferAt:     usedTransferAt ?? new Date(),
      fee,
      oldPolicyId:    oldPolicyId,
      newPolicyId:    policyChanged ? newPolicyId : oldPolicyId,
      reason,
      by:             req.user?.id ?? req.user?._id ?? null,
    })

    booking.roomId     = newRoom._id
    booking.roomNumber = newRoom.number
    booking.roomType   = newRoom.typeName
    booking.notes      = `${booking.notes || ''}\n[Chuyển phòng ${oldRoomNumber} → ${newRoom.number}${fee > 0 ? ` • Phí: ${fee.toLocaleString('vi-VN')}đ` : ''}${policyChanged ? ' • Đổi giá' : ''}${reason ? ': ' + reason : ''}]`.trim()

    // ⭐ FIX 24/05/2026: REBUILD breakdown từ transferHistory ĐẦY ĐỦ (gồm lần đổi vừa push).
    //   Sửa lỗi đổi ≥2 lần nuốt chặng cũ. transferHistory = single source of truth.
    try {
      const _branchForRebuild = await Branch.findById(booking.branchId)
      const _rebuilt = await rebuildBookingBreakdown(booking, _branchForRebuild)
      if (_rebuilt && Array.isArray(_rebuilt.breakdown) && _rebuilt.breakdown.length > 0) {
        booking.priceBreakdown = _rebuilt.breakdown
        booking.roomAmount     = _rebuilt.roomAmount
        let _disc = booking.discount ?? 0
        if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
          const _roomPart = booking.isFreeRoom ? 0 : booking.roomAmount
          const _sub = _roomPart + (booking.servicesAmount ?? 0)
          _disc = Math.round(_sub * (booking.discountPercent ?? 0) / 100) + (booking.discountAmount ?? 0)
        }
        booking.discount    = _disc
        booking.totalAmount = Math.max(0,
          booking.roomAmount + (booking.servicesAmount ?? 0) - _disc + (booking.transferFee ?? 0))
      }
    } catch (_rebuildErr) {
      console.error('[moveRoom] rebuild breakdown failed (giữ breakdown cũ):', _rebuildErr.message)
    }

    await booking.save()

    const oldRoomUpdate = { currentBookingId: null, currentGuestName: null }
    if (booking.status === 'checked_in') {
      oldRoomUpdate.roomStatus = 'inactive'
    }
    await Room.findByIdAndUpdate(oldRoomId, oldRoomUpdate)
    await Room.findByIdAndUpdate(newRoomId, { currentBookingId: booking._id, currentGuestName: booking.customerName })

    try {
      const invoice = await Invoice.findOne({ bookingId: booking._id })
      if (invoice) {
        invoice.roomAmount      = booking.roomAmount
        invoice.discount        = booking.discount
        invoice.totalAmount     = booking.totalAmount
        invoice.remainingAmount = Math.max(0, invoice.totalAmount - (invoice.paidAmount ?? 0))
        invoice.paymentStatus   = invoice.paidAmount >= invoice.totalAmount ? 'paid' :
                                  invoice.paidAmount > 0 ? 'partial' : 'unpaid'
        await invoice.save()
      }
    } catch (e) {
      console.error('[moveRoom] sync invoice failed (non-fatal):', e.message)
    }

    const auditDesc = [
      `Chuyển phòng ${oldRoomNumber} → ${newRoom.number}`,
      fee > 0 && `Phí ${fee.toLocaleString('vi-VN')}đ`,
      policyChanged && `Đổi giá`,
      reason,
    ].filter(Boolean).join(' • ')

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'move_room',
      description: auditDesc,
      user: req.user, branchId: booking.branchId,
      metadata: {
        oldRoomNumber, newRoomNumber: newRoom.number,
        oldRoomType: oldRoom?.typeName ?? '', newRoomType: newRoom.typeName ?? '',
        fee, policyChanged, newPolicyId, transferAt: usedTransferAt,
        newRoomAmount, newTotalAmount: booking.totalAmount,
        reason,
        bookingCode: booking.bookingCode,
      },
    })

    res.json({ success: true, message: 'Chuyển phòng thành công', data: { booking } })
  } catch (err) {
    console.error('[moveRoom] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

// ⭐ PATCH /bookings/:id/change-policy
const changePolicy = async (req, res, next) => {
  try {
    const {
      policyId,
      customRoomAmount = null,
      customBreakdown  = null,
      discountPercent  = null,
      discountAmount   = null,
      isFreeRoom       = null,
    } = req.body

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

    // ⭐ FIX 23/05/2026: Lưu giá/chính sách CŨ TRƯỚC khi đổi — để audit log ghi "cũ → mới".
    const _oldPolicyName  = booking.policyName
    const _oldRoomAmount  = booking.roomAmount
    const _oldPriceType   = booking.priceType

    let newRoomAmount     = booking.roomAmount
    let newPriceBreakdown = booking.priceBreakdown

    if (customRoomAmount !== null && customRoomAmount !== undefined) {
      newRoomAmount = Number(customRoomAmount) || 0
      newPriceBreakdown = [{
        label:  `Giá phòng (tự nhập) × ${booking.nights} đêm`,
        amount: newRoomAmount,
        type:   'base',
        meta:   { custom: true },
      }]
      booking.policyId   = null
      booking.policyName = 'Giá tự nhập'
    } else if (Array.isArray(customBreakdown) && customBreakdown.length > 0) {
      newPriceBreakdown = customBreakdown.map(b => ({
        label:  String(b.label ?? ''),
        amount: Number(b.amount) || 0,
        type:   b.type === 'surcharge' ? 'surcharge' : 'base',
        meta:   { ...(b.meta || {}), customPrice: true },
      }))
      newRoomAmount = newPriceBreakdown.reduce((s, b) => s + (b.amount ?? 0), 0)
      if (policyId) {
        const policy = await PricePolicy.findById(policyId)
        if (policy) {
          const room   = await Room.findById(booking.roomId).populate('typeId')
          const cap    = room?.typeId?.capacity ?? 2
          booking.policyId       = policy._id
          booking.policyName     = policy.name
          booking.policySnapshot = buildPolicySnapshot(policy, cap)
        }
      }
    } else if (policyId) {
      const policy = await PricePolicy.findById(policyId)
      if (!policy) return res.status(404).json({ success: false, message: 'Không tìm thấy chính sách giá' })
      const room    = await Room.findById(booking.roomId).populate('typeId')
      const branch  = await Branch.findById(booking.branchId)
      const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
      const maxChildren = room?.typeId?.maxChildren ?? 0
      const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
      const capacity    = room?.typeId?.capacity ?? (maxAdults + maxChildren)

      // ⭐ FIX 18/05/2026: Auto-fallback priceType nếu policy mới KHÔNG enable loại cũ
      //   Ví dụ: booking đang là 'hour', đổi sang policy chỉ có 'day' → tự đổi sang 'day'
      //   Ưu tiên: day > night > hour > week > month (theo nhu cầu thực tế khách sạn)
      let resolvedPriceType = booking.priceType
      const enableMap = {
        hour:  policy.hourEnabled,
        day:   policy.dayEnabled,
        night: policy.nightEnabled,
        week:  policy.weekEnabled,
        month: policy.monthEnabled,
      }
      if (!enableMap[resolvedPriceType]) {
        // Tìm loại enable đầu tiên theo thứ tự ưu tiên
        const priority = ['day', 'night', 'hour', 'week', 'month']
        const fallback = priority.find(t => enableMap[t] === true)
        if (fallback) {
          console.log(`[changePolicy] Auto-switch priceType: ${booking.priceType} → ${fallback} (policy "${policy.name}" không hỗ trợ ${booking.priceType})`)
          resolvedPriceType = fallback
        }
      }

      const result = calculatePrice({
        checkIn:   booking.checkIn,
        checkOut:  booking.checkOut,
        priceType: resolvedPriceType,
        policy, branch,
        adults:    booking.adults,
        children:  booking.children,
        maxAdults, maxChildren, maxOccupancy,
      })

      if (result.error) {
        return res.status(400).json({
          success: false,
          code:    result.error.code,
          message: result.error.message,
          data: {
            finalPriceType:  result.error.finalPriceType,
            availableTypes:  result.error.availableTypes,
            availableLabels: result.error.availableLabels,
            policyName:      policy?.name ?? '',
          },
        })
      }

      newRoomAmount     = result.roomAmount
      newPriceBreakdown = result.breakdown
      booking.policyId       = policy._id
      booking.policyName     = policy.name
      booking.policySnapshot = buildPolicySnapshot(policy, capacity)
      // ⭐ Cập nhật priceType nếu đã auto-switch
      if (resolvedPriceType !== booking.priceType) {
        booking.priceType = resolvedPriceType
      }
    }

    if (discountPercent !== null) booking.discountPercent = Number(discountPercent) || 0
    if (discountAmount  !== null) booking.discountAmount  = Number(discountAmount)  || 0
    if (isFreeRoom      !== null) booking.isFreeRoom      = !!isFreeRoom

    booking.roomAmount     = newRoomAmount
    booking.priceBreakdown = newPriceBreakdown

    const roomPart = booking.isFreeRoom ? 0 : newRoomAmount
    const subtotal = roomPart + (booking.servicesAmount ?? 0)
    const pctDisc  = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
    booking.discount    = pctDisc + (booking.discountAmount ?? 0)
    booking.totalAmount = Math.max(0, subtotal - booking.discount + (booking.transferFee || 0))

    await booking.save()

    try {
      const invoice = await Invoice.findOne({ bookingId: booking._id })
      if (invoice) {
        invoice.roomAmount      = booking.roomAmount
        invoice.discount        = booking.discount
        invoice.totalAmount     = booking.totalAmount
        invoice.remainingAmount = Math.max(0, invoice.totalAmount - (invoice.paidAmount ?? 0))
        invoice.paymentStatus   = invoice.paidAmount >= invoice.totalAmount ? 'paid' :
                                  invoice.paidAmount > 0 ? 'partial' : 'unpaid'
        await invoice.save()
      }
    } catch (e) {
      console.error('[changePolicy] sync invoice failed (non-fatal):', e.message)
    }

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'change_policy',
      description: customRoomAmount !== null
        ? `Đổi giá phòng (tự nhập): ${_oldRoomAmount.toLocaleString('vi-VN')}đ → ${newRoomAmount.toLocaleString('vi-VN')}đ`
        : Array.isArray(customBreakdown) && customBreakdown.length > 0
          ? `Sửa giá thủ công từng dòng: ${_oldRoomAmount.toLocaleString('vi-VN')}đ → ${newRoomAmount.toLocaleString('vi-VN')}đ (${customBreakdown.length} dòng)`
          : `Đổi giá: "${_oldPolicyName || '—'}" (${_oldRoomAmount.toLocaleString('vi-VN')}đ) → "${booking.policyName}" (${newRoomAmount.toLocaleString('vi-VN')}đ)`,
      user: req.user, branchId: booking.branchId,
      metadata: {
        policyId, policyName: booking.policyName, customRoomAmount,
        customBreakdownLen: customBreakdown?.length ?? 0,
        newRoomAmount, totalAmount: booking.totalAmount,
        // ⭐ NEW 23/05/2026: giá/chính sách cũ để hiển thị "cũ → mới"
        oldPolicyName: _oldPolicyName,
        oldRoomAmount: _oldRoomAmount,
        oldPriceType:  _oldPriceType,
        newPolicyName: booking.policyName,
        newPriceType:  booking.priceType,
      },
    })

    res.json({ success: true, message: 'Đã đổi giá phòng', data: { booking } })
  } catch (err) {
    console.error('[changePolicy] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}
// ── CHECK-IN ──────────────────────────────────────────
const checkin = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (!['confirmed', 'reserved'].includes(booking.status))
      return res.status(400).json({ success: false, message: `Không thể check-in từ trạng thái: ${booking.status}` })

    const now = new Date()

    // ⭐ FIX 07/05/2026: Không cho check-in nếu giờ trả phòng dự kiến đã qua
    //   Vd: booking 07/05 14:00 → 07/05 20:00, hiện tại 22:00 → KHÔNG cho check-in
    //   Lý do: check-in vào giờ này = booking đã hoàn toàn ở quá khứ, vô nghĩa
    //   Cách xử lý: cần đổi giờ trả phòng (changeDates) trước rồi mới check-in được
    if (booking.checkOut && new Date(booking.checkOut) < now) {
      return res.status(400).json({
        success: false,
        code: 'CHECKOUT_IN_PAST',
        message: `Không thể nhận phòng — giờ trả phòng dự kiến (${new Date(booking.checkOut).toLocaleString('vi-VN')}) đã qua so với hiện tại (${now.toLocaleString('vi-VN')}). Vui lòng đổi giờ trả phòng (Đổi ngày ở) sang tương lai trước khi nhận phòng.`,
        data: {
          now,
          scheduledCheckOut: booking.checkOut,
          bookingId: booking._id,
          customerName: booking.customerName,
          roomNumber: booking.roomNumber,
        },
      })
    }

    const intervalStart = now < booking.checkIn ? now : booking.checkIn
    const intervalEnd   = booking.checkOut

    const checkConflictForCheckin = async (roomId, roomLabel) => {
      const conflictResult = await findOverlapForNewBooking({
        roomId,
        intervalStart,
        intervalEnd,
        excludeBookingIds: [booking._id],
        actionType:    'checkin',
      })
      if (conflictResult) {
        const { conflict, conflictStart, conflictEnd, conflictStatus, isStillCheckedIn } = conflictResult
        const statusLabel = {
          reserved:   'đã đặt',
          confirmed:  'đã xác nhận',
          checked_in: isStillCheckedIn ? 'đang ở (chưa trả phòng)' : 'đang ở',
        }[conflictStatus] ?? conflictStatus
        return {
          success: false,
          code: 'CONFLICT_OVERLAP',
          message: isStillCheckedIn
            ? `Không thể check-in${roomLabel ? ` phòng ${roomLabel}` : ''} — phòng đang có khách ${conflict.customerName} chưa trả phòng (dự kiến trả ${new Date(conflictEnd).toLocaleString('vi-VN')}). Vui lòng xử lý trả phòng cho khách hiện tại trước.`
            : `Không thể check-in${roomLabel ? ` phòng ${roomLabel}` : ''} vào lúc ${now.toLocaleString('vi-VN')} — phòng đang có khách (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}. Vui lòng đợi đến sau khi khách trên trả phòng hoặc đổi phòng khác.`,
          data: {
            conflictBookingId:    conflict._id,
            conflictCustomerName: conflict.customerName,
            conflictCheckIn:      conflictStart,
            conflictCheckOut:     conflictEnd,
            conflictStatus,
            isStillCheckedIn,
            attemptedCheckInAt:   now,
            bookingScheduledCheckIn: booking.checkIn,
          },
        }
      }
      return null
    }

    const roomsToCheck = []
    if (Array.isArray(booking.rooms) && booking.rooms.length > 0) {
      for (const sr of booking.rooms) {
        if (['cancelled', 'checked_out'].includes(sr.status)) continue
        if (sr.roomId) roomsToCheck.push({
          id: String(sr.roomId._id ?? sr.roomId),
          number: sr.roomNumber,
        })
      }
    } else if (booking.roomId) {
      roomsToCheck.push({
        id: String(booking.roomId),
        number: booking.roomNumber,
      })
    }

    for (const r of roomsToCheck) {
      const err = await checkConflictForCheckin(r.id, roomsToCheck.length > 1 ? r.number : null)
      if (err) return res.status(400).json(err)
    }

    booking.status        = 'checked_in'
    booking.actualCheckIn = now

    if (Array.isArray(booking.rooms) && booking.rooms.length > 0) {
      for (const sr of booking.rooms) {
        if (sr.status === 'reserved' || sr.status === 'confirmed') {
          sr.status         = 'checked_in'
          sr.actualCheckIn  = now
        }
      }
    }
    await booking.save()

    const roomsToUpdate = []
    if (booking.roomId) roomsToUpdate.push(booking.roomId)
    if (Array.isArray(booking.rooms)) {
      for (const sr of booking.rooms) {
        if (!sr.roomId) continue
        const ridStr = String(sr.roomId._id ?? sr.roomId)
        const rootRid = booking.roomId ? String(booking.roomId._id ?? booking.roomId) : null
        if (ridStr === rootRid) continue
        roomsToUpdate.push(sr.roomId)
      }
    }

    if (roomsToUpdate.length > 0) {
      await Room.updateMany(
        { _id: { $in: roomsToUpdate } },
        {
          currentBookingId: booking._id,
          currentGuestName: booking.customerName,
        }
      )
    }

    const totalRooms = roomsToUpdate.length
    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'checkin',
      description: totalRooms > 1
        ? `Check-in đoàn ${booking.groupName || ''} (${totalRooms} phòng) cho ${booking.customerName}`
        : `Check-in phòng ${booking.roomNumber} cho ${booking.customerName}`,
      user: req.user, branchId: booking.branchId,
      metadata: { roomNumber: booking.roomNumber, customerName: booking.customerName, totalRooms },
    })

    res.json({
      success: true,
      message: totalRooms > 1 ? `Check-in đoàn (${totalRooms} phòng) thành công` : 'Check-in thành công',
      data: { booking },
    })
  } catch (err) { next(err) }
}

const checkinRoom = async (req, res, next) => {
  try {
    const { roomId } = req.body
    if (!roomId) return res.status(400).json({ success: false, message: 'Thiếu roomId' })

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

    if (!Array.isArray(booking.rooms) || booking.rooms.length === 0) {
      return res.status(400).json({ success: false, message: 'Booking này không phải đoàn — dùng /checkin' })
    }

    const sub = booking.rooms.find(r => String(r.roomId._id ?? r.roomId) === String(roomId))
    if (!sub) return res.status(404).json({ success: false, message: 'Không tìm thấy phòng trong đoàn' })

    if (!['reserved', 'confirmed'].includes(sub.status)) {
      return res.status(400).json({ success: false, message: `Phòng này không thể check-in từ trạng thái: ${sub.status}` })
    }

    const now = new Date()

    const subCheckIn  = sub.checkIn  ?? booking.checkIn
    const subCheckOut = sub.checkOut ?? booking.checkOut

    // ⭐ FIX 07/05/2026: Không cho check-in nếu giờ trả phòng dự kiến đã qua
    if (subCheckOut && new Date(subCheckOut) < now) {
      return res.status(400).json({
        success: false,
        code: 'CHECKOUT_IN_PAST',
        message: `Không thể nhận phòng ${sub.roomNumber} — giờ trả phòng dự kiến (${new Date(subCheckOut).toLocaleString('vi-VN')}) đã qua so với hiện tại (${now.toLocaleString('vi-VN')}). Vui lòng đổi giờ trả phòng (Đổi ngày ở) sang tương lai trước khi nhận phòng.`,
        data: {
          now,
          scheduledCheckOut: subCheckOut,
          bookingId: booking._id,
          customerName: booking.customerName,
          roomNumber: sub.roomNumber,
        },
      })
    }

    const intervalStart = now < subCheckIn ? now : subCheckIn
    const intervalEnd   = subCheckOut

    const conflictResult = await findOverlapForNewBooking({
      roomId:        String(sub.roomId._id ?? sub.roomId),
      intervalStart,
      intervalEnd,
      excludeBookingIds: [booking._id],
      actionType:    'checkin',
    })
    if (conflictResult) {
      const { conflict, conflictStart, conflictEnd, conflictStatus, isStillCheckedIn } = conflictResult
      const statusLabel = {
        reserved:   'đã đặt',
        confirmed:  'đã xác nhận',
        checked_in: isStillCheckedIn ? 'đang ở (chưa trả phòng)' : 'đang ở',
      }[conflictStatus] ?? conflictStatus
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_OVERLAP',
        message: isStillCheckedIn
          ? `Không thể check-in phòng ${sub.roomNumber} — phòng đang có khách ${conflict.customerName} chưa trả phòng (dự kiến trả ${new Date(conflictEnd).toLocaleString('vi-VN')}). Vui lòng xử lý trả phòng cho khách hiện tại trước.`
          : `Không thể check-in phòng ${sub.roomNumber} vào lúc ${now.toLocaleString('vi-VN')} — phòng đang có khách (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}.`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          conflictCheckOut:     conflictEnd,
          conflictStatus,
          isStillCheckedIn,
          attemptedCheckInAt:   now,
          bookingScheduledCheckIn: subCheckIn,
        },
      })
    }

    sub.status        = 'checked_in'
    sub.actualCheckIn = now

    const anyCheckedIn = booking.rooms.some(r => r.status === 'checked_in')
    if (anyCheckedIn && booking.status !== 'checked_in') {
      booking.status        = 'checked_in'
      booking.actualCheckIn = booking.actualCheckIn ?? now
    }

    await booking.save()

    await Room.findByIdAndUpdate(roomId, {
      currentBookingId: booking._id,
      currentGuestName: booking.customerName,
    })

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'checkin_room',
      description: `Check-in lẻ phòng ${sub.roomNumber} (đoàn ${booking.groupName || ''}) cho ${booking.customerName}`,
      user: req.user, branchId: booking.branchId,
      metadata: { roomNumber: sub.roomNumber, customerName: booking.customerName },
    })

    res.json({
      success: true,
      message: `Check-in phòng ${sub.roomNumber} thành công`,
      data: { booking, subRoom: sub },
    })
  } catch (err) { next(err) }
}

const checkout = async (req, res, next) => {
  try {
    const { actualCheckOut } = req.body
    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (booking.status !== 'checked_in')
      return res.status(400).json({ success: false, message: `Không thể check-out từ trạng thái: ${booking.status}` })

    const actualCO = actualCheckOut ? new Date(actualCheckOut) : new Date()

    if (actualCheckOut) {
      const now = new Date()
      if (actualCO.getTime() < now.getTime() - 60000) {
        const perm = await canSetPastTime(req.user, booking._id, null)
        if (!perm.canSetPast) {
          return res.status(403).json({
            success: false,
            code:    'FORBIDDEN_PAST_CHECKOUT',
            message: perm.reason,
            data: { userRole: req.user?.role ?? null, actualCheckOut },
          })
        }
      }
    }

    const refCheckIn = booking.actualCheckIn ?? booking.checkIn
    if (refCheckIn && actualCO < new Date(refCheckIn)) {
      return res.status(400).json({
        success: false,
        message: `Giờ trả phòng (${new Date(actualCO).toLocaleString('vi-VN')}) phải sau giờ nhận phòng (${new Date(refCheckIn).toLocaleString('vi-VN')})`,
      })
    }

    const conflictResult = await findActiveConflictForRoom({
      bookingId:      booking._id,
      roomId:         booking.roomId,
      intervalStart:  refCheckIn,
      intervalEnd:    actualCO,
    })

    if (conflictResult) {
      const { conflict, conflictStart } = conflictResult
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_NEW_BOOKING',
        message: `Phòng ${booking.roomNumber} đã có booking khác (${conflict.customerName}) nhận phòng lúc ${new Date(conflictStart).toLocaleString('vi-VN')}. Giờ trả phòng phải trước thời điểm này.`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          requestedCheckOut:    actualCO,
        },
      })
    }

    const hasCustomPriceItems = (booking.priceBreakdown ?? []).some(b => b.meta?.customPrice === true)
    const checkOutDiffMin = Math.abs((actualCO - booking.checkOut) / 60000)

    if (checkOutDiffMin > 1 && hasCustomPriceItems) {
      try {
        const parseRange = (b) => {
          if (b.meta?.startTime && b.meta?.endTime) {
            return { start: new Date(b.meta.startTime), end: new Date(b.meta.endTime) }
          }
          const label = String(b.label ?? '')
          const m = label.match(/\((\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})\)/)
          if (!m) return null
          const [, sd, sm, sh, smi, ed, em, eh, emi] = m
          const refDate = booking.checkIn ?? booking.actualCheckIn ?? new Date()
          const year = new Date(refDate).getFullYear()
          return {
            start: new Date(year, +sm - 1, +sd, +sh, +smi),
            end:   new Date(year, +em - 1, +ed, +eh, +emi),
          }
        }

        let nightsToCharge = 0
        const baseItems = (booking.priceBreakdown ?? []).filter(b => b.type === 'base')
        for (const b of baseItems) {
          const range = parseRange(b)
          if (!range) { nightsToCharge++; continue }
          if (actualCO >= range.end) {
            nightsToCharge++
          } else if (actualCO >= range.start) {
            nightsToCharge++
            break
          } else {
            const effCheckIn = booking.actualCheckIn ?? booking.checkIn
            if (effCheckIn && actualCO >= effCheckIn && nightsToCharge === 0) {
              nightsToCharge++
            }
            break
          }
        }

        const newBreakdown = []
        let baseCount = 0
        for (const b of (booking.priceBreakdown ?? [])) {
          if (b.type === 'base') {
            if (baseCount < nightsToCharge) {
              newBreakdown.push(b)
              baseCount++
            }
          } else {
            newBreakdown.push(b)
          }
        }

        const newRoomAmount = newBreakdown.reduce((s, b) => s + (b.amount ?? 0), 0)

        let recalcDiscount = booking.discount ?? 0
        if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
          const roomPart = booking.isFreeRoom ? 0 : newRoomAmount
          const subtotal = roomPart + (booking.servicesAmount ?? 0)
          const pctDiscount = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
          recalcDiscount = pctDiscount + (booking.discountAmount ?? 0)
        }

        const roomPart = booking.isFreeRoom ? 0 : newRoomAmount
        booking.roomAmount     = newRoomAmount
        booking.nights         = nightsToCharge || booking.nights
        booking.priceBreakdown = newBreakdown
        booking.discount       = recalcDiscount
        booking.totalAmount    = Math.max(0, roomPart + (booking.servicesAmount ?? 0) - recalcDiscount + (booking.transferFee || 0))
      } catch (calcErr) {
        console.error('Recalc custom price on checkout failed:', calcErr)
      }
    } else if (checkOutDiffMin > 1 && !hasCustomPriceItems) {
      try {
        const room   = await Room.findById(booking.roomId).populate('typeId')
        const branch = await Branch.findById(booking.branchId)
        const policy = booking.policyId ? await PricePolicy.findById(booking.policyId) : null
        const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
        const maxChildren = room?.typeId?.maxChildren ?? 0

        const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
        // ⭐ FIX 18/05/2026: Nếu booking có transferHistory → dùng moveRoomBreakdown
        //   để tính tiền phòng theo từng đoạn (giống calculate-bill nhánh hasTransferred).
        //   calculatePrice thẳng sẽ tính toàn bộ thời gian theo policy phòng MỚI →
        //   không bằng "tiền phòng cũ + tiền phòng mới" → lệch số.
        const hasTransfer = Array.isArray(booking.transferHistory) && booking.transferHistory.length > 0

        if (hasTransfer) {
          const transfers = booking.transferHistory
            .filter(t => t?.transferAt && t?.fromRoomNumber && t?.toRoomNumber)
            .sort((a, b) => new Date(a.transferAt) - new Date(b.transferAt))
          const lastTransfer = transfers[transfers.length - 1]

          // Resolve old policy (phòng cũ trước transfer)
          let oldPolicy = null
          if (lastTransfer?.oldPolicyId) {
            try { oldPolicy = await PricePolicy.findById(lastTransfer.oldPolicyId) } catch {}
          }
          if (!oldPolicy && booking.policySnapshot && booking.policySnapshot.dayPrice) {
            oldPolicy = booking.policySnapshot
          }

          // Resolve room types
          let oldRoomType = ''
          try {
            const oldRoomDoc = await Room.findOne({
              number: lastTransfer.fromRoomNumber,
              branchId: booking.branchId,
            }).populate('typeId')
            if (oldRoomDoc) {
              oldRoomType = oldRoomDoc.typeId?.name || oldRoomDoc.typeName || ''
            }
          } catch {}
          const newRoomType = room?.typeId?.name || booking.roomType || ''

          const hourSlotsOf = (pol) => {
            if (!pol) return []
            return (pol.hourSlots || []).map(s => {
              const time = s.time || s.duration || ''
              const m = String(time).match(/(\d+)/)
              return { durationHours: m ? parseInt(m[1]) : 2, price: s.price || 0 }
            })
          }

          // ⭐ NEW 20/05/2026: Bảng giá GIỜ từ policy hourEnabled của roomType phòng MỚI
          const newRoomTypeIdCO = room?.typeId?._id || room?.typeId || null
          const newHourlyPolicyCO = await resolveHourlyPolicy(newRoomTypeIdCO, booking.branchId)
          const newRoomHourSlotsCO = newHourlyPolicyCO
            ? hourSlotsOf(newHourlyPolicyCO)
            : hourSlotsOf(policy)

          const moveItems = computeMoveRoomBreakdown({
            actualCheckIn:   booking.actualCheckIn ?? booking.checkIn,
            // ⭐ FIX 24/05/2026: Khi TRẢ PHÒNG, LUÔN tính theo GIỜ TRẢ THỰC (actualCO =
            //   "hiện tại" lúc bấm trả phòng), KHỚP với tab "Đến hiện tại" mà khách đã
            //   thanh toán. KHÔNG cap về booking.checkOut (giờ trả ĐẶT) — vì cap sẽ làm
            //   chặng giá giờ bị cắt sớm (vd 18:00 thay vì 18:25) → lệch tiền → báo dư sai.
            //   Áp dụng cho cả overstay lẫn trả sớm: mốc tính = giờ khách thực sự rời đi.
            plannedCheckOut: actualCO,
            transferAt:      new Date(lastTransfer.transferAt),
            oldRoom: {
              number: lastTransfer.fromRoomNumber,
              type:   oldRoomType,
              policy: { dayPrice: oldPolicy?.dayPrice || 0, hourSlots: hourSlotsOf(oldPolicy) },
            },
            newRoom: {
              number: lastTransfer.toRoomNumber,
              type:   newRoomType,
              policy: { dayPrice: policy?.dayPrice || 0, hourSlots: newRoomHourSlotsCO,
                dayCheckInTime: policy?.dayCheckInTime, dayCheckOutTime: policy?.dayCheckOutTime,
                dayEarlyCheckIn: policy?.dayEarlyCheckIn, dayLateCheckOut: policy?.dayLateCheckOut,
                dayAdultSurcharge: policy?.dayAdultSurcharge, dayChildSurcharge: policy?.dayChildSurcharge },
            },
            transferFee: Number(lastTransfer.fee) || 0,
            // ⭐ FIX 25/05/2026: changeRate theo ý định nhân viên (policyId), không suy từ loại phòng.
            changeRate:  String(lastTransfer.oldPolicyId ?? '') !== String(lastTransfer.newPolicyId ?? ''),
            isFreeRoom:  !!booking.isFreeRoom,
            branchConfig: branch ? {
            checkInTime: branch.checkInTime,
            checkOutTime: branch.checkOutTime,
            earlyCheckinUntil: branch.earlyCheckinUntil,
            toleranceMinutes: branch.toleranceMinutes,
            dayEquivalentHours: branch.dayEquivalentHours,
          } : null,
          })

          const breakdownItems = moveItems.map(it => ({
            label:  it.label,
            amount: it.amount,
            type:   it.type === 'surcharge' ? 'surcharge' : 'base',
            meta:   it.meta || {},
          }))

          // Bổ sung phụ thu (extra people, late checkout) theo policy phòng mới từ transferAt → actualCO
          try {
            const surchargeResult = calculatePrice({
              checkIn:   new Date(lastTransfer.transferAt),
              checkOut:  actualCO,
              priceType: booking.priceType,
              policy, branch,
              adults:    booking.adults,
              children:  booking.children,
              maxAdults, maxChildren, maxOccupancy,
            })
            if (!surchargeResult.error && Array.isArray(surchargeResult.breakdown)) {
              // ⭐ FIX 23/05/2026: Bỏ "Nhận phòng sớm" + "Trả phòng muộn" vì moveRoomBreakdown
              //   (sau khi truyền đủ dayLateCheckOut/dayEarlyCheckIn) đã TỰ tính 2 khoản này
              //   → giữ lại sẽ double count. Chỉ lấy phụ thu vượt sức chứa (người lớn/trẻ em).
              const surchargeOnly = surchargeResult.breakdown.filter(b => {
                if (b.type !== 'surcharge') return false
                const lbl = String(b.label || '')
                return !lbl.includes('Nhận phòng sớm')
                    && !lbl.includes('early_checkin')
                    && !lbl.includes('Trả phòng muộn')
                    && !lbl.includes('Trả phòng trễ')
                    && !lbl.includes('late_checkout')
              })
              for (const sur of surchargeOnly) {
                breakdownItems.push({
                  label:  `[${lastTransfer.toRoomNumber}] ${sur.label}`,
                  amount: sur.amount,
                  type:   'surcharge',
                  meta:   { ...(sur.meta || {}), roomNumber: lastTransfer.toRoomNumber },
                })
              }
            }
          } catch (surErr) {
            console.warn('[checkout v20] surcharge calc failed:', surErr.message)
          }

          const newRoomAmount = breakdownItems
            .filter(b => !(b.meta && b.meta.transferFee))
            .reduce((s, b) => s + (b.amount || 0), 0)

          let recalcDiscount = booking.discount ?? 0
          if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
            const roomPart = booking.isFreeRoom ? 0 : newRoomAmount
            const subtotal = roomPart + (booking.servicesAmount ?? 0)
            const pctDiscount = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
            recalcDiscount = pctDiscount + (booking.discountAmount ?? 0)
          }

          const roomPart = booking.isFreeRoom ? 0 : newRoomAmount
          booking.roomAmount     = newRoomAmount
          booking.priceBreakdown = breakdownItems
          booking.discount       = recalcDiscount
          // ⭐ KHÔNG cộng booking.transferFee thêm vì đã filter bỏ fee item khỏi roomAmount
          //    (fee được track riêng trong booking.transferFee, nhưng đã có dòng "Phụ thu chuyển phòng"
          //     trong breakdown nếu lastTransfer.fee > 0 — em filter bỏ ra khỏi roomAmount để
          //     totalAmount = roomAmount + transferFee không double count)
          booking.totalAmount    = Math.max(0, roomPart + (booking.servicesAmount ?? 0) - recalcDiscount + (booking.transferFee || 0))
        } else {
          const priceResult = calculatePrice({
            checkIn:   booking.actualCheckIn ?? booking.checkIn,
            checkOut:  actualCO,
            priceType: booking.priceType,
            policy, branch,
            adults:    booking.adults,
            children:  booking.children,
            maxAdults, maxChildren, maxOccupancy,
          })

          if (priceResult.error) {
            console.warn('[checkout] Recalc skipped due to policy mismatch:', priceResult.error.message)
          } else {
            let recalcDiscount = booking.discount ?? 0
            if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
              const roomPart = booking.isFreeRoom ? 0 : priceResult.roomAmount
              const subtotal = roomPart + (booking.servicesAmount ?? 0)
              const pctDiscount = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
              recalcDiscount = pctDiscount + (booking.discountAmount ?? 0)
            }

            const roomPart = booking.isFreeRoom ? 0 : priceResult.roomAmount
            booking.roomAmount     = priceResult.roomAmount
            booking.nights         = priceResult.nights
            booking.priceBreakdown = priceResult.breakdown
            booking.discount       = recalcDiscount
            booking.totalAmount    = Math.max(0, roomPart + (booking.servicesAmount ?? 0) - recalcDiscount + (booking.transferFee || 0))
          }
        }
      } catch (calcErr) {
        console.error('Recalc on checkout failed:', calcErr)
      }
    }

    if (Array.isArray(booking.rooms) && booking.rooms.length > 0) {
      try {
        const branch = await Branch.findById(booking.branchId)
        let groupRoomTotal = 0

        for (const sub of booking.rooms) {
          if (sub.status === 'checked_out' || sub.status === 'cancelled') {
            groupRoomTotal += sub.roomAmount ?? 0
            continue
          }

          const room   = await Room.findById(sub.roomId).populate('typeId')
          const policy = sub.policyId ? await PricePolicy.findById(sub.policyId) : null
          const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
          const maxChildren = room?.typeId?.maxChildren ?? 0

          const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
          const existingItems = Array.isArray(sub.priceBreakdown) ? sub.priceBreakdown : []
          // ⭐ FIX 25/05/2026: đồng bộ với calculate-bill — phòng đoàn ĐÃ CHUYỂN phải tính bằng
          //   computeMoveRoomBreakdown (giống phòng lẻ), KHÔNG dùng seg1/seg2 + calculatePrice cũ
          //   (vốn dính OVER_CAPACITY khi chuyển sang phòng nhỏ → mất chặng mới → tổng lệch →
          //   tưởng khách trả dư → chặn trả phòng đòi hoàn tiền oan).
          const isOldSeg = (meta, srRoomNumber) =>
            meta?.segment === 1 ||
            meta?.policy === 'old' ||
            meta?.segment === 'oldNights' ||
            (meta?.roomNumber && String(meta.roomNumber) !== String(srRoomNumber))
          const hasMoveSegments = existingItems.some(b => isOldSeg(b?.meta, sub.roomNumber))

          let subPriceResult
          if (hasMoveSegments) {
            const hist = (booking.transferHistory || [])
              .filter(t => t?.transferAt && t?.toRoomNumber)
              .filter(t => String(t.toRoomNumber) === String(sub.roomNumber) ||
                           String(t?.toRoomId?._id ?? t?.toRoomId) === String(sub.roomId?._id ?? sub.roomId))
              .sort((a, b) => new Date(a.transferAt) - new Date(b.transferAt))
            const lastT = hist[hist.length - 1]

            if (!lastT) {
              subPriceResult = {
                roomAmount: sub.roomAmount ?? 0,
                nights:     sub.nights,
                breakdown:  existingItems.map(b => (b && typeof b.toObject === 'function') ? b.toObject() : b),
              }
            } else {
              const oldRoomNum = lastT.fromRoomNumber
              const newRoomNum = sub.roomNumber
              let oldPolicy = null
              if (lastT.oldPolicyId) { try { oldPolicy = await PricePolicy.findById(lastT.oldPolicyId) } catch {} }
              if (!oldPolicy && booking.policySnapshot?.dayPrice) oldPolicy = booking.policySnapshot
              const newPolicy = policy

              let oldRoomType = ''
              let newRoomType = sub.roomType || room?.typeName || ''
              const newRoomTypeId = room?.typeId?._id ?? room?.typeId ?? null
              try {
                const d = await Room.findOne({ number: oldRoomNum, branchId: booking.branchId }).populate('typeId')
                if (d) oldRoomType = d.typeId?.name || d.typeName || ''
              } catch {}

              const hourSlotsOf = (pol) => {
                if (!pol) return []
                return (pol.hourSlots || []).map(s => {
                  const time = s.time || s.duration || ''
                  const m = String(time).match(/(\d+)/)
                  return { durationHours: m ? parseInt(m[1]) : 2, price: s.price || 0 }
                })
              }
              const newHourlyPolicy = await resolveHourlyPolicy(newRoomTypeId, booking.branchId)
              const newRoomHourSlots = newHourlyPolicy ? hourSlotsOf(newHourlyPolicy) : hourSlotsOf(newPolicy)

              const items = computeMoveRoomBreakdown({
                actualCheckIn:   new Date(sub.actualCheckIn ?? sub.checkIn ?? booking.checkIn),
                plannedCheckOut: new Date(actualCO),
                transferAt:      new Date(lastT.transferAt),
                oldRoom: {
                  number: oldRoomNum, type: oldRoomType,
                  policy: { dayPrice: oldPolicy?.dayPrice || 0, hourSlots: hourSlotsOf(oldPolicy) },
                },
                newRoom: {
                  number: newRoomNum, type: newRoomType,
                  policy: {
                    dayPrice: newPolicy?.dayPrice || 0, hourSlots: newRoomHourSlots,
                    dayCheckInTime: newPolicy?.dayCheckInTime, dayCheckOutTime: newPolicy?.dayCheckOutTime,
                    dayEarlyCheckIn: newPolicy?.dayEarlyCheckIn, dayLateCheckOut: newPolicy?.dayLateCheckOut,
                    dayAdultSurcharge: newPolicy?.dayAdultSurcharge, dayChildSurcharge: newPolicy?.dayChildSurcharge,
                  },
                },
                transferFee: 0,   // fee tách riêng (booking.transferFee)
                changeRate:  String(lastT.oldPolicyId ?? '') !== String(lastT.newPolicyId ?? ''),
                isFreeRoom:  !!booking.isFreeRoom,
                branchConfig: branch ? {
                  checkInTime: branch.checkInTime, checkOutTime: branch.checkOutTime,
                  earlyCheckinUntil: branch.earlyCheckinUntil, toleranceMinutes: branch.toleranceMinutes,
                  dayEquivalentHours: branch.dayEquivalentHours,
                } : null,
              })

              const moveItems = items
                .filter(it => !(it.meta && it.meta.transferFee))
                .map(it => ({
                  label: it.label, amount: it.amount,
                  type: it.type === 'surcharge' ? 'surcharge' : 'base',
                  meta: it.meta || {},
                }))
              subPriceResult = {
                roomAmount: moveItems.reduce((s, b) => s + (b.amount || 0), 0),
                nights:     sub.nights,
                breakdown:  moveItems,
              }
            }
          } else {
            subPriceResult = calculatePrice({
              checkIn:   sub.actualCheckIn ?? sub.checkIn ?? booking.checkIn,
              checkOut:  actualCO,
              priceType: sub.priceType ?? booking.priceType,
              policy, branch,
              adults:    sub.adults   ?? booking.adults,
              children:  sub.children ?? booking.children,
              maxAdults, maxChildren, maxOccupancy,
            })

            if (subPriceResult.error) {
              console.warn(`[checkout][group] Recalc skipped for room ${sub.roomNumber}:`, subPriceResult.error.message)
              groupRoomTotal += sub.roomAmount ?? 0
              continue
            }
          }

          sub.roomAmount     = subPriceResult.roomAmount
          sub.nights         = subPriceResult.nights
          // ⭐ FIX 25/05/2026: GIỮ prefix [room] gốc (vd [203] của chặng cũ) — KHÔNG ép tất cả
          //   thành [sub.roomNumber], nếu không dòng phòng cũ [203] bị đổi nhầm thành [604].
          sub.priceBreakdown = (subPriceResult.breakdown ?? []).map(b => {
            const itemRoomNum = b?.meta?.roomNumber ?? sub.roomNumber
            const labelStr = String(b.label ?? '')
            const hasPrefix = /^\[[^\]]+\]\s/.test(labelStr)
            return {
              label:  hasPrefix ? labelStr : `[${itemRoomNum}] ${labelStr}`,
              amount: Number(b.amount ?? 0),
              type:   b.type === 'surcharge' ? 'surcharge' : 'base',
              meta:   { ...(b.meta || {}), roomNumber: itemRoomNum },
            }
          })

          groupRoomTotal += sub.roomAmount
        }

        booking.roomAmount = groupRoomTotal
        const subtotal = groupRoomTotal + (booking.servicesAmount ?? 0)
        const pctDisc  = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
        booking.discount    = pctDisc + (booking.discountAmount ?? 0)
        // ⭐ FIX 25/05/2026: CỘNG transferFee vào tổng (trước đây thiếu → tổng thấp hơn
        //   calculate-bill đúng bằng phí chuyển → tưởng khách trả dư khi trả phòng).
        booking.totalAmount = Math.max(0, subtotal - booking.discount + (booking.transferFee || 0))
      } catch (groupErr) {
        console.error('[checkout][group] Recalc failed:', groupErr)
      }
    }

    const existingInvoice = await Invoice.findOne({ bookingId: booking._id })
    const newTotal = booking.totalAmount ?? 0
    const invPaid  = existingInvoice?.paidAmount ?? 0
    const owed = newTotal - invPaid
    if (owed > 0) {
      return res.status(400).json({
        success: false,
        message: `Không thể trả phòng — khách còn nợ ${owed.toLocaleString('vi-VN')} VND. Vui lòng thu đủ tiền trước.`,
        code: 'PAYMENT_REQUIRED',
        data: { remaining: owed, totalAmount: newTotal, paidAmount: invPaid },
      })
    }
    // ⭐ FIX 11/05/2026: Chặn nếu khách trả DƯ (paid > total)
    //   Trước đây code chỉ check owed > 0. Khi paid > total (vd nợ 300 khách
    //   đưa 500 dư 200), owed = -200 (âm) → cho qua bug.
    //   Đúng business: bắt buộc hoàn trả phần dư cho khách trước khi trả phòng.
    if (owed < 0) {
      const overpaid = Math.abs(owed)
      return res.status(400).json({
        success: false,
        message: `Không thể trả phòng — khách đã trả DƯ ${overpaid.toLocaleString('vi-VN')} VND. Vui lòng hoàn trả ${overpaid.toLocaleString('vi-VN')} VND cho khách trước khi trả phòng.`,
        code: 'OVERPAID',
        data: {
          overpaid,
          totalAmount: newTotal,
          paidAmount:  invPaid,
        },
      })
    }

    booking.status         = 'checked_out'
    booking.actualCheckOut = actualCO

    if (Array.isArray(booking.rooms) && booking.rooms.length > 0) {
      for (const sr of booking.rooms) {
        if (sr.status === 'checked_in' || sr.status === 'reserved') {
          sr.status         = 'checked_out'
          sr.actualCheckOut = actualCO
        }
      }
    }

    {
      const invForStatus = await Invoice.findOne({ bookingId: booking._id })
      const paid = invForStatus?.paidAmount ?? 0
      booking.paymentStatus = paid >= booking.totalAmount ? 'paid' :
                              paid > 0 ? 'partial' : 'unpaid'
    }

    await booking.save()

    const roomIdsToCleaning = []
    if (booking.roomId) roomIdsToCleaning.push(booking.roomId)
    if (Array.isArray(booking.rooms)) {
      for (const sr of booking.rooms) {
        if (!sr.roomId) continue
        const ridStr = String(sr.roomId._id ?? sr.roomId)
        const rootRid = booking.roomId ? String(booking.roomId._id ?? booking.roomId) : null
        if (ridStr === rootRid) continue
        roomIdsToCleaning.push(sr.roomId)
      }
    }

    if (roomIdsToCleaning.length > 0) {
      await Room.updateMany(
        { _id: { $in: roomIdsToCleaning } },
        {
          currentBookingId: null,
          currentGuestName: null,
          roomStatus:       'inactive',
        }
      )
    }

    let invoice = await Invoice.findOne({ bookingId: booking._id })
    const newItems = buildInvoiceItemsFromBooking(booking)

    if (!invoice) {
      invoice = await Invoice.create({
        bookingId:       booking._id,
        customerId:      booking.customerId,
        customerName:    booking.customerName,
        roomNumber:      booking.roomNumber,
        roomAmount:      booking.roomAmount,
        servicesAmount:  booking.servicesAmount ?? 0,
        discount:        booking.discount ?? 0,
        totalAmount:     booking.totalAmount,
        remainingAmount: booking.totalAmount,
        issuedBy:        req.user?.id,
        items:           newItems,
        branchId:        booking.branchId,
      })
    } else {
      invoice.roomAmount      = booking.roomAmount
      invoice.servicesAmount  = booking.servicesAmount ?? 0
      invoice.discount        = booking.discount ?? 0
      invoice.totalAmount     = booking.totalAmount
      invoice.remainingAmount = Math.max(0, booking.totalAmount - (invoice.paidAmount ?? 0))
      invoice.paymentStatus   = invoice.paidAmount >= booking.totalAmount ? 'paid' :
                                invoice.paidAmount > 0 ? 'partial' : 'unpaid'
      invoice.items   = newItems
      if (!invoice.branchId && booking.branchId) invoice.branchId = booking.branchId
      await invoice.save()
    }

    await Customer.findByIdAndUpdate(booking.customerId, {
      $inc: { totalVisits: 1, totalSpent: booking.totalAmount },
    })

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'checkout',
      description: `Trả phòng ${booking.roomNumber} — ${booking.customerName} (${booking.totalAmount.toLocaleString('vi-VN')}đ)`,
      user: req.user, branchId: booking.branchId,
      metadata: {
        roomNumber: booking.roomNumber, customerName: booking.customerName,
        actualCheckOut: actualCO, totalAmount: booking.totalAmount, nights: booking.nights,
      },
    })

    res.json({ success: true, message: 'Check-out thành công', data: { booking, invoice } })
  } catch (err) { next(err) }
}
const checkoutRoom = async (req, res, next) => {
  try {
    const { roomId, actualCheckOut, skipPayment = false } = req.body
    if (!roomId) return res.status(400).json({ success: false, message: 'Thiếu roomId' })

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

    if (!Array.isArray(booking.rooms) || booking.rooms.length === 0) {
      return res.status(400).json({ success: false, message: 'Booking này không phải đoàn — dùng /checkout' })
    }

    const sub = booking.rooms.find(r => String(r.roomId._id ?? r.roomId) === String(roomId))
    if (!sub) return res.status(404).json({ success: false, message: 'Không tìm thấy phòng trong đoàn' })

    if (sub.status !== 'checked_in') {
      return res.status(400).json({ success: false, message: `Phòng này không thể check-out từ trạng thái: ${sub.status}` })
    }

    const actualCO = actualCheckOut ? new Date(actualCheckOut) : new Date()

    if (actualCheckOut) {
      const now = new Date()
      if (actualCO.getTime() < now.getTime() - 60000) {
        const perm = await canSetPastTime(req.user, booking._id, sub.roomNumber)
        if (!perm.canSetPast) {
          return res.status(403).json({
            success: false,
            code:    'FORBIDDEN_PAST_CHECKOUT',
            message: perm.reason,
            data: {
              userRole: req.user?.role ?? null,
              actualCheckOut,
              roomNumber: sub.roomNumber,
            },
          })
        }
      }
    }

    const refCheckIn = sub.actualCheckIn ?? sub.checkIn ?? booking.actualCheckIn ?? booking.checkIn
    if (refCheckIn && actualCO < new Date(refCheckIn)) {
      return res.status(400).json({
        success: false,
        message: `Giờ trả phòng (${new Date(actualCO).toLocaleString('vi-VN')}) phải sau giờ nhận phòng (${new Date(refCheckIn).toLocaleString('vi-VN')})`,
      })
    }

    const subRoomId = String(sub.roomId?._id ?? sub.roomId)
    const conflictResult = await findActiveConflictForRoom({
      bookingId:      booking._id,
      roomId:         subRoomId,
      intervalStart:  refCheckIn,
      intervalEnd:    actualCO,
    })

    if (conflictResult) {
      const { conflict, conflictStart } = conflictResult
      return res.status(400).json({
        success: false,
        code: 'CONFLICT_NEW_BOOKING',
        message: `Phòng ${sub.roomNumber} đã có booking khác (${conflict.customerName}) nhận phòng lúc ${new Date(conflictStart).toLocaleString('vi-VN')}. Giờ trả phòng phải trước thời điểm này.`,
        data: {
          conflictBookingId:    conflict._id,
          conflictCustomerName: conflict.customerName,
          conflictCheckIn:      conflictStart,
          requestedCheckOut:    actualCO,
        },
      })
    }

    const checkOutDiffMin = Math.abs((actualCO - booking.checkOut) / 60000)
    if (checkOutDiffMin > 1) {
      try {
        const room   = await Room.findById(sub.roomId).populate('typeId')
        const branch = await Branch.findById(booking.branchId)
        const policy = sub.policyId ? await PricePolicy.findById(sub.policyId) : null
        const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
        const maxChildren = room?.typeId?.maxChildren ?? 0

        const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)

        // ⭐ FIX 25/05/2026: phòng ĐÃ CHUYỂN → computeMoveRoomBreakdown (đồng bộ checkout/calculate-bill).
        //   Trước đây gọi calculatePrice thẳng → OVER_CAPACITY → bỏ qua recompute → giữ giá lưu cũ (lệch).
        const existingItems = Array.isArray(sub.priceBreakdown) ? sub.priceBreakdown : []
        const isOldSeg = (meta, srRoomNumber) =>
          meta?.segment === 1 || meta?.policy === 'old' || meta?.segment === 'oldNights' ||
          (meta?.roomNumber && String(meta.roomNumber) !== String(srRoomNumber))
        const hasMoveSegments = existingItems.some(b => isOldSeg(b?.meta, sub.roomNumber))

        if (hasMoveSegments) {
          const hist = (booking.transferHistory || [])
            .filter(t => t?.transferAt && t?.toRoomNumber)
            .filter(t => String(t.toRoomNumber) === String(sub.roomNumber) ||
                         String(t?.toRoomId?._id ?? t?.toRoomId) === String(sub.roomId?._id ?? sub.roomId))
            .sort((a, b) => new Date(a.transferAt) - new Date(b.transferAt))
          const lastT = hist[hist.length - 1]
          if (lastT) {
            const oldRoomNum = lastT.fromRoomNumber
            const newRoomNum = sub.roomNumber
            let oldPolicy = null
            if (lastT.oldPolicyId) { try { oldPolicy = await PricePolicy.findById(lastT.oldPolicyId) } catch {} }
            if (!oldPolicy && booking.policySnapshot?.dayPrice) oldPolicy = booking.policySnapshot
            const newPolicy = policy

            let oldRoomType = ''
            let newRoomType = sub.roomType || room?.typeName || ''
            const newRoomTypeId = room?.typeId?._id ?? room?.typeId ?? null
            try {
              const d = await Room.findOne({ number: oldRoomNum, branchId: booking.branchId }).populate('typeId')
              if (d) oldRoomType = d.typeId?.name || d.typeName || ''
            } catch {}

            const hourSlotsOf = (pol) => {
              if (!pol) return []
              return (pol.hourSlots || []).map(s => {
                const time = s.time || s.duration || ''
                const m = String(time).match(/(\d+)/)
                return { durationHours: m ? parseInt(m[1]) : 2, price: s.price || 0 }
              })
            }
            const newHourlyPolicy = await resolveHourlyPolicy(newRoomTypeId, booking.branchId)
            const newRoomHourSlots = newHourlyPolicy ? hourSlotsOf(newHourlyPolicy) : hourSlotsOf(newPolicy)

            const items = computeMoveRoomBreakdown({
              actualCheckIn:   new Date(sub.actualCheckIn ?? sub.checkIn ?? booking.checkIn),
              plannedCheckOut: new Date(actualCO),
              transferAt:      new Date(lastT.transferAt),
              oldRoom: {
                number: oldRoomNum, type: oldRoomType,
                policy: { dayPrice: oldPolicy?.dayPrice || 0, hourSlots: hourSlotsOf(oldPolicy) },
              },
              newRoom: {
                number: newRoomNum, type: newRoomType,
                policy: {
                  dayPrice: newPolicy?.dayPrice || 0, hourSlots: newRoomHourSlots,
                  dayCheckInTime: newPolicy?.dayCheckInTime, dayCheckOutTime: newPolicy?.dayCheckOutTime,
                  dayEarlyCheckIn: newPolicy?.dayEarlyCheckIn, dayLateCheckOut: newPolicy?.dayLateCheckOut,
                  dayAdultSurcharge: newPolicy?.dayAdultSurcharge, dayChildSurcharge: newPolicy?.dayChildSurcharge,
                },
              },
              transferFee: 0,
              changeRate:  String(lastT.oldPolicyId ?? '') !== String(lastT.newPolicyId ?? ''),
              isFreeRoom:  !!booking.isFreeRoom,
              branchConfig: branch ? {
                checkInTime: branch.checkInTime, checkOutTime: branch.checkOutTime,
                earlyCheckinUntil: branch.earlyCheckinUntil, toleranceMinutes: branch.toleranceMinutes,
                dayEquivalentHours: branch.dayEquivalentHours,
              } : null,
            })

            const moveItems = items
              .filter(it => !(it.meta && it.meta.transferFee))
              .map(it => {
                const labelStr = String(it.label ?? '')
                const hasPrefix = /^\[[^\]]+\]\s/.test(labelStr)
                const rn = it.meta?.roomNumber ?? sub.roomNumber
                return {
                  label:  hasPrefix ? labelStr : `[${rn}] ${labelStr}`,
                  amount: Number(it.amount ?? 0),
                  type:   it.type === 'surcharge' ? 'surcharge' : 'base',
                  meta:   { ...(it.meta || {}), roomNumber: rn },
                }
              })
            sub.roomAmount     = moveItems.reduce((s, b) => s + (b.amount || 0), 0)
            sub.priceBreakdown = moveItems
          }
          // lastT không có → giữ nguyên giá lưu (an toàn)
        } else {
          const priceResult = calculatePrice({
            checkIn:   sub.actualCheckIn ?? sub.checkIn ?? booking.checkIn,
            checkOut:  actualCO,
            priceType: sub.priceType ?? booking.priceType,
            policy, branch,
            adults:    sub.adults   ?? booking.adults,
            children:  sub.children ?? booking.children,
            maxAdults, maxChildren, maxOccupancy,
          })

          if (priceResult.error) {
            console.warn('[checkoutRoom] Recalc skipped due to policy mismatch:', priceResult.error.message)
          } else {
            sub.roomAmount      = priceResult.roomAmount
            sub.priceBreakdown  = (priceResult.breakdown ?? []).map(b => ({
              label:  String(b.label ?? ''),
              amount: Number(b.amount ?? 0),
              type:   b.type === 'surcharge' ? 'surcharge' : 'base',
              meta:   { ...(b.meta || {}), roomNumber: sub.roomNumber },
            }))
          }
        }
      } catch (calcErr) {
        console.error('Recalc on checkoutRoom failed:', calcErr)
      }
    }

    sub.actualCheckOut = actualCO

    const totalRoomsAmountPre = booking.rooms.reduce((sum, r) => sum + (r.roomAmount ?? 0), 0)
    const subtotalPre = totalRoomsAmountPre + (booking.servicesAmount ?? 0)
    const pctDiscPre = Math.round(subtotalPre * (booking.discountPercent ?? 0) / 100)
    const totalDiscPre = pctDiscPre + (booking.discountAmount ?? 0)
    const newTotalAmount = Math.max(0, subtotalPre - totalDiscPre)

    const otherCheckedIn = booking.rooms.filter(r =>
      r !== sub && r.status === 'checked_in'
    )
    const isLastRoom = otherCheckedIn.length === 0

    const invoicePre   = await Invoice.findOne({ bookingId: booking._id })
    const invoicePaid  = invoicePre?.paidAmount ?? 0
    const invoiceRemaining = Math.max(0, newTotalAmount - invoicePaid)

    if (isLastRoom) {
      if (invoiceRemaining > 0) {
        return res.status(400).json({
          success: false,
          message: `Đây là phòng cuối của đoàn — đoàn còn nợ ${invoiceRemaining.toLocaleString('vi-VN')} VND. Vui lòng thu đủ trước khi trả phòng cuối.`,
          code: 'PAYMENT_REQUIRED',
          data: { remaining: invoiceRemaining, totalAmount: newTotalAmount, paidAmount: invoicePaid },
        })
      }
      // ⭐ FIX 11/05/2026: Chặn nếu đoàn trả DƯ (paid > total)
      const overpaidGroup = invoicePaid - newTotalAmount
      if (overpaidGroup > 0) {
        return res.status(400).json({
          success: false,
          message: `Đây là phòng cuối — đoàn đã trả DƯ ${overpaidGroup.toLocaleString('vi-VN')} VND. Vui lòng hoàn trả phần dư cho khách trước khi trả phòng.`,
          code: 'OVERPAID',
          data: {
            overpaid:    overpaidGroup,
            totalAmount: newTotalAmount,
            paidAmount:  invoicePaid,
          },
        })
      }
    } else {
      const subTotalAmount     = (sub.roomAmount ?? 0) + (sub.servicesAmount ?? 0) - (sub.discountAmount ?? 0)
      // ⭐ FIX 23/05/2026: Tiền thanh toán đi qua POST /invoices/:id/payment → ghi vào
      //   invoice.paidAmount (TỔNG đoàn), KHÔNG ghi vào sub.paidAmount. Nếu chỉ đọc
      //   sub.paidAmount thì luôn = 0 → báo "còn nợ" oan dù khách đã trả đủ tiền phòng này.
      //   → Tính phần invoice tổng đã trả mà CHƯA bị các phòng khác "chiếm" → phân bổ cho phòng này.
      //   (Cùng logic với calculateBill single-room mode.)
      let subPaidAmount = sub.paidAmount ?? 0
      const invoicePaidTotal = invoicePaid   // đã load ở trên: invoicePre?.paidAmount ?? 0
      const otherSubPaidSum = booking.rooms
        .filter(r => r !== sub)
        .reduce((s, r) => {
          const rTotal = (r.roomAmount ?? 0) + (r.servicesAmount ?? 0) - (r.discountAmount ?? 0)
          return s + Math.min(r.paidAmount ?? 0, rTotal)
        }, 0)
      const excessInvoicePaid = Math.max(0, invoicePaidTotal - otherSubPaidSum)
      subPaidAmount = Math.max(subPaidAmount, excessInvoicePaid)
      subPaidAmount = Math.min(subPaidAmount, subTotalAmount)
      const subRemainingAmount = Math.max(0, subTotalAmount - subPaidAmount)

      if (subRemainingAmount > 0 && !skipPayment) {
        return res.status(400).json({
          success: false,
          message: `Phòng ${sub.roomNumber} còn nợ ${subRemainingAmount.toLocaleString('vi-VN')} VND. Vui lòng thanh toán đủ tiền phòng này trước khi trả.`,
          code: 'PAYMENT_REQUIRED_FOR_ROOM',
          data: {
            roomId:           String(sub.roomId?._id ?? sub.roomId),
            roomNumber:       sub.roomNumber,
            subTotalAmount,
            subPaidAmount,
            subRemainingAmount,
          },
        })
      }
      // ⭐ FIX 11/05/2026: Chặn nếu phòng đã trả DƯ
      const overpaidSub = subPaidAmount - subTotalAmount
      if (overpaidSub > 0 && !skipPayment) {
        return res.status(400).json({
          success: false,
          message: `Phòng ${sub.roomNumber} đã trả DƯ ${overpaidSub.toLocaleString('vi-VN')} VND. Vui lòng hoàn trả phần dư cho khách trước khi trả phòng.`,
          code: 'OVERPAID_FOR_ROOM',
          data: {
            roomId:        String(sub.roomId?._id ?? sub.roomId),
            roomNumber:    sub.roomNumber,
            overpaid:      overpaidSub,
            subTotalAmount,
            subPaidAmount,
          },
        })
      }
    }

    sub.status = 'checked_out'

    const totalRoomsAmount = booking.rooms.reduce((sum, r) => sum + (r.roomAmount ?? 0), 0)
    booking.roomAmount  = totalRoomsAmount
    const subtotal = totalRoomsAmount + (booking.servicesAmount ?? 0)
    const pctDisc  = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
    const totalDiscount = pctDisc + (booking.discountAmount ?? 0)
    booking.discount    = totalDiscount
    // ⭐ FIX 25/05/2026: cộng transferFee (đồng bộ checkout/calculate-bill — tránh tưởng trả dư).
    booking.totalAmount = Math.max(0, subtotal - totalDiscount + (booking.transferFee || 0))

    const allCheckedOut = booking.rooms.every(r => r.status === 'checked_out' || r.status === 'cancelled')

    let invoice = await Invoice.findOne({ bookingId: booking._id })
    const paidAmount = invoice?.paidAmount ?? 0
    const remaining  = Math.max(0, booking.totalAmount - paidAmount)

    if (allCheckedOut && remaining > 0) {
      return res.status(400).json({
        success: false,
        message: `Đoàn còn nợ ${remaining.toLocaleString('vi-VN')} VND. Vui lòng thu đủ trước khi finalize.`,
        code: 'PAYMENT_REQUIRED',
        data: { remaining, totalAmount: booking.totalAmount, paidAmount },
      })
    }

    if (allCheckedOut) {
      booking.status         = 'checked_out'
      booking.actualCheckOut = actualCO
    }

    booking.paymentStatus = paidAmount >= booking.totalAmount ? 'paid' :
                            paidAmount > 0 ? 'partial' : 'unpaid'

    await booking.save()

    if (invoice) {
      invoice.roomAmount      = booking.roomAmount
      invoice.servicesAmount  = booking.servicesAmount ?? 0
      invoice.discount        = booking.discount ?? 0
      invoice.totalAmount     = booking.totalAmount
      invoice.remainingAmount = Math.max(0, booking.totalAmount - paidAmount)
      invoice.paymentStatus   = paidAmount >= booking.totalAmount ? 'paid' :
                                paidAmount > 0 ? 'partial' : 'unpaid'
      invoice.items   = buildInvoiceItemsFromBooking(booking)
      if (!invoice.branchId && booking.branchId) invoice.branchId = booking.branchId
      await invoice.save()
    } else if (allCheckedOut) {
      invoice = await Invoice.create({
        bookingId:       booking._id,
        customerId:      booking.customerId,
        customerName:    booking.customerName,
        roomNumber:      booking.roomNumber,
        roomAmount:      booking.roomAmount,
        servicesAmount:  booking.servicesAmount ?? 0,
        discount:        booking.discount ?? 0,
        totalAmount:     booking.totalAmount,
        remainingAmount: Math.max(0, booking.totalAmount - paidAmount),
        paidAmount:      paidAmount,
        issuedBy:        req.user?.id,
        items:           buildInvoiceItemsFromBooking(booking),
        branchId:        booking.branchId,
      })
    }

    await Room.findByIdAndUpdate(roomId, {
      currentBookingId: null,
      currentGuestName: null,
      roomStatus:       'inactive',
    })

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'checkout_room',
      description: `Trả lẻ phòng ${sub.roomNumber} (đoàn ${booking.groupName || ''}) — ${booking.customerName}`,
      user: req.user, branchId: booking.branchId,
      metadata: { roomNumber: sub.roomNumber, customerName: booking.customerName, actualCheckOut: actualCO, allCheckedOut },
    })

    res.json({
      success: true,
      message: allCheckedOut
        ? `Đã trả phòng cuối — đoàn đã hoàn tất`
        : `Trả phòng ${sub.roomNumber} thành công (còn ${booking.rooms.filter(r => r.status === 'checked_in').length} phòng đang ở)`,
      data: { booking, subRoom: sub, allCheckedOut, remaining: Math.max(0, booking.totalAmount - paidAmount) },
    })
  } catch (err) { next(err) }
}

const cancel = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (['checked_out', 'cancelled'].includes(booking.status))
      return res.status(400).json({ success: false, message: `Không thể huỷ từ trạng thái: ${booking.status}` })

    const prevStatus     = booking.status
    booking.status       = 'cancelled'
    booking.cancelReason = req.body.reason ?? ''
    booking.cancelledAt  = new Date()
    booking.cancelledBy  = req.user?.id
    await booking.save()

    if (['reserved', 'confirmed', 'checked_in'].includes(prevStatus)) {
      await Room.findByIdAndUpdate(booking.roomId, {
        currentBookingId: null,
        currentGuestName: null,
      })
    }

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'cancel',
      description: `Huỷ đặt phòng ${booking.roomNumber} — ${booking.customerName}${req.body.reason ? ` (${req.body.reason})` : ''}`,
      user: req.user, branchId: booking.branchId,
      metadata: { reason: req.body.reason, prevStatus, roomNumber: booking.roomNumber },
    })

    res.json({ success: true, message: 'Đã huỷ đặt phòng', data: { booking } })
  } catch (err) { next(err) }
}

const undo = async (req, res, next) => {
  try {
    const perm = checkUndoPermission(req.user)
    if (!perm.ok) {
      return res.status(perm.status).json({
        success: false,
        code:    perm.code,
        message: perm.message,
      })
    }

    const { reason } = req.body
    if (!reason) return res.status(400).json({ success: false, message: 'Cần nhập lý do hoàn tác' })

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

    let newStatus
    if (booking.status === 'checked_in')       newStatus = 'reserved'
    else if (booking.status === 'checked_out') newStatus = 'checked_in'
    else return res.status(400).json({ success: false, message: 'Chỉ hoàn tác được checked_in hoặc checked_out' })

    const wasCheckedOut = booking.status === 'checked_out'
    if (wasCheckedOut) {
      booking.actualCheckOut = null
    }

    booking.status     = newStatus
    booking.undoReason = reason
    await booking.save()

    const roomUpdate = {
      currentBookingId: booking._id,
      currentGuestName: booking.customerName,
    }
    if (wasCheckedOut) {
      roomUpdate.roomStatus = 'active'
    }
    await Room.findByIdAndUpdate(booking.roomId, roomUpdate)

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'undo',
      description: `Hoàn tác (${reason})`,
      user: req.user, branchId: booking.branchId,
      metadata: {
        reason, newStatus, roomNumber: booking.roomNumber,
        actorRole: req.user.role,
      },
    })

    res.json({ success: true, message: 'Hoàn tác thành công', data: { booking } })
  } catch (err) { next(err) }
}

const undoRoom = async (req, res, next) => {
  try {
    const perm = checkUndoPermission(req.user)
    if (!perm.ok) {
      return res.status(perm.status).json({
        success: false,
        code:    perm.code,
        message: perm.message,
      })
    }

    const { roomId, reason } = req.body
    if (!reason) return res.status(400).json({ success: false, message: 'Cần nhập lý do hoàn tác' })
    if (!roomId)  return res.status(400).json({ success: false, message: 'Thiếu roomId' })

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    if (!Array.isArray(booking.rooms) || booking.rooms.length === 0) {
      return res.status(400).json({ success: false, message: 'Không phải booking đoàn — dùng /undo' })
    }

    const sub = booking.rooms.find(r => String(r.roomId?._id ?? r.roomId) === String(roomId))
    if (!sub) return res.status(404).json({ success: false, message: 'Không tìm thấy phòng trong đoàn' })

    let newSubStatus
    let prevStatus = sub.status
    if (sub.status === 'checked_in')       newSubStatus = 'reserved'
    else if (sub.status === 'checked_out') newSubStatus = 'checked_in'
    else return res.status(400).json({ success: false, message: `Chỉ hoàn tác được checked_in/checked_out (hiện tại: ${sub.status})` })

    const wasCheckedOut = sub.status === 'checked_out'

    sub.status = newSubStatus
    if (wasCheckedOut) {
      sub.actualCheckOut = null
    }

    const allCheckedOut = booking.rooms.every(r => r.status === 'checked_out' || r.status === 'cancelled')
    const anyCheckedIn  = booking.rooms.some(r => r.status === 'checked_in')

    if (anyCheckedIn) {
      booking.status = 'checked_in'
      booking.actualCheckOut = null
    } else if (allCheckedOut) {
      booking.status = 'checked_out'
    } else {
      booking.status = 'reserved'
    }

    booking.undoReason = reason
    await booking.save()

    const roomUpdate = {
      currentBookingId: booking._id,
      currentGuestName: booking.customerName,
    }
    if (wasCheckedOut) {
      roomUpdate.roomStatus = 'active'
    }
    await Room.findByIdAndUpdate(sub.roomId, roomUpdate)

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'undo',
      description: `Hoàn tác phòng ${sub.roomNumber}: ${prevStatus} → ${newSubStatus} (${reason})`,
      user: req.user, branchId: booking.branchId,
      metadata: {
        reason, roomId, roomNumber: sub.roomNumber, prevStatus, newSubStatus, bookingId: booking._id,
        actorRole: req.user.role,
      },
    })

    res.json({ success: true, message: `Đã hoàn tác phòng ${sub.roomNumber}`, data: { booking } })
  } catch (err) {
    console.error('[undoRoom] error:', err)
    next(err)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ⭐ NEW 24/05/2026: HOÀN TÁC ĐỔI PHÒNG (undo lần chuyển phòng CUỐI CÙNG)
//   Dùng khi đổi phòng NHẦM. Gỡ entry cuối khỏi transferHistory, đưa khách về phòng
//   trước đó, hoàn lại phí chuyển phòng của lần đó, rebuild lại giá. Như chưa từng đổi.
//   - Chỉ Admin/Manager (checkUndoPermission).
//   - Chỉ undo được khi CÒN transferHistory và booking chưa checked_out
//     (đã trả phòng thì không undo đổi phòng — phải undo checkout trước).
//   - KHÔNG hỗ trợ booking đoàn ở đây (cần subRoomId — xử lý riêng nếu cần).
// ════════════════════════════════════════════════════════════════════════════
const undoMoveRoom = async (req, res, next) => {
  try {
    const perm = checkUndoPermission(req.user)
    if (!perm.ok) {
      return res.status(perm.status).json({ success: false, code: perm.code, message: perm.message })
    }

    const { reason } = req.body
    if (!reason) return res.status(400).json({ success: false, message: 'Cần nhập lý do hoàn tác đổi phòng' })

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

    if (Array.isArray(booking.rooms) && booking.rooms.length > 0) {
      return res.status(400).json({ success: false, message: 'Booking đoàn — hoàn tác đổi phòng theo đoàn chưa được hỗ trợ' })
    }
    if (booking.status === 'checked_out') {
      return res.status(400).json({ success: false, message: 'Booking đã trả phòng — hãy hoàn tác trả phòng (undo checkout) trước' })
    }
    const hist = Array.isArray(booking.transferHistory) ? booking.transferHistory : []
    if (hist.length === 0) {
      return res.status(400).json({ success: false, message: 'Booking chưa từng đổi phòng — không có gì để hoàn tác' })
    }

    // Lần đổi CUỐI cần undo
    const last = hist[hist.length - 1]
    const fromRoomId     = last.fromRoomId
    const fromRoomNumber = last.fromRoomNumber
    const curRoomId      = booking.roomId          // phòng hiện tại (phòng đã đổi NHẦM tới)
    const restoreFee     = last.fee || 0

    // Lấy thông tin phòng cũ (để khôi phục roomType + policy)
    const fromRoom = await Room.findById(fromRoomId).populate('typeId')
    if (!fromRoom) {
      return res.status(404).json({ success: false, message: `Không tìm thấy phòng cũ ${fromRoomNumber} để quay về` })
    }

    // (1) Gỡ entry cuối khỏi transferHistory
    booking.transferHistory = hist.slice(0, -1)

    // (2) Khôi phục phòng hiện tại về phòng cũ
    booking.roomId     = fromRoomId
    booking.roomNumber = fromRoomNumber
    booking.roomType   = fromRoom.typeId?.name || fromRoom.typeName || booking.roomType

    // (3) Hoàn lại phí chuyển phòng của lần undo
    booking.transferFee = Math.max(0, (booking.transferFee || 0) - restoreFee)

    // (4) Khôi phục policy về oldPolicyId của lần đổi (nếu có)
    if (last.oldPolicyId) {
      try {
        const oldPol = await PricePolicy.findById(last.oldPolicyId)
        if (oldPol) {
          const cap = fromRoom.typeId?.capacity ?? 2
          booking.policyId       = oldPol._id
          booking.policyName     = oldPol.name
          booking.policySnapshot = buildPolicySnapshot(oldPol, cap)
        }
      } catch (_) {}
    }

    // (5) Rebuild lại priceBreakdown từ transferHistory CÒN LẠI (đã gỡ entry cuối).
    //     Nếu không còn transfer nào → tính lại như booking thường (1 phòng).
    try {
      const _branch = await Branch.findById(booking.branchId)
      if (booking.transferHistory.length > 0) {
        const _rebuilt = await rebuildBookingBreakdown(booking, _branch)
        if (_rebuilt && Array.isArray(_rebuilt.breakdown) && _rebuilt.breakdown.length > 0) {
          booking.priceBreakdown = _rebuilt.breakdown
          booking.roomAmount     = _rebuilt.roomAmount
        }
      } else {
        // Không còn transfer → tính lại đơn giản theo phòng cũ
        const policy = booking.policyId ? await PricePolicy.findById(booking.policyId) : null
        const maxAdults   = fromRoom.typeId?.maxAdults   ?? fromRoom.typeId?.capacity ?? 2
        const maxChildren = fromRoom.typeId?.maxChildren ?? 0
        const maxOccupancy = fromRoom.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
        if (policy && _branch) {
          const r = calculatePrice({
            checkIn:   booking.actualCheckIn ?? booking.checkIn,
            checkOut:  booking.checkOut,
            priceType: booking.priceType,
            policy, branch: _branch,
            adults: booking.adults, children: booking.children,
            maxAdults, maxChildren, maxOccupancy,
          })
          if (!r.error) {
            booking.priceBreakdown = r.breakdown
            booking.roomAmount     = r.roomAmount
          }
        }
      }
      // Cập nhật discount + totalAmount
      let _disc = booking.discount ?? 0
      if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
        const _roomPart = booking.isFreeRoom ? 0 : booking.roomAmount
        const _sub = _roomPart + (booking.servicesAmount ?? 0)
        _disc = Math.round(_sub * (booking.discountPercent ?? 0) / 100) + (booking.discountAmount ?? 0)
      }
      booking.discount    = _disc
      booking.totalAmount = Math.max(0,
        booking.roomAmount + (booking.servicesAmount ?? 0) - _disc + (booking.transferFee ?? 0))
    } catch (_rebuildErr) {
      console.error('[undoMoveRoom] rebuild breakdown failed:', _rebuildErr.message)
    }

    booking.notes = `${booking.notes || ''}\n[Hoàn tác đổi phòng: ${booking.roomNumber} ← (huỷ chuyển tới ${last.toRoomNumber})${reason ? ' • ' + reason : ''}]`.trim()
    booking.undoReason = reason
    await booking.save()

    // (6) Cập nhật trạng thái phòng: giải phóng phòng đổi-nhầm, gán lại phòng cũ.
    //     Chỉ giải phóng phòng nhầm nếu KHÔNG còn chặng nào dùng nó.
    const stillUses = (booking.transferHistory || []).some(t =>
      String(t.toRoomId) === String(curRoomId) || String(t.fromRoomId) === String(curRoomId))
    if (!stillUses && String(curRoomId) !== String(fromRoomId)) {
      const curUpdate = { currentBookingId: null, currentGuestName: null }
      if (booking.status === 'checked_in') curUpdate.roomStatus = 'active'  // trả phòng nhầm về available
      await Room.findByIdAndUpdate(curRoomId, curUpdate)
    }
    await Room.findByIdAndUpdate(fromRoomId, {
      currentBookingId: booking._id,
      currentGuestName: booking.customerName,
      ...(booking.status === 'checked_in' ? { roomStatus: 'inactive' } : {}),
    })

    // (7) Sync invoice
    try {
      const invoice = await Invoice.findOne({ bookingId: booking._id })
      if (invoice) {
        invoice.roomAmount      = booking.roomAmount
        invoice.discount        = booking.discount
        invoice.totalAmount     = booking.totalAmount
        invoice.remainingAmount = Math.max(0, invoice.totalAmount - (invoice.paidAmount ?? 0))
        invoice.paymentStatus   = invoice.paidAmount >= invoice.totalAmount ? 'paid' :
                                  invoice.paidAmount > 0 ? 'partial' : 'unpaid'
        await invoice.save()
      }
    } catch (e) {
      console.error('[undoMoveRoom] sync invoice failed (non-fatal):', e.message)
    }

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'undo_move_room',
      description: `Hoàn tác đổi phòng: huỷ chuyển ${fromRoomNumber} → ${last.toRoomNumber} (${reason})`,
      user: req.user, branchId: booking.branchId,
      metadata: {
        reason, restoredRoom: fromRoomNumber, cancelledToRoom: last.toRoomNumber,
        refundedFee: restoreFee, remainingTransfers: booking.transferHistory.length,
        bookingCode: booking.bookingCode, actorRole: req.user.role,
      },
    })

    res.json({
      success: true,
      message: `Đã hoàn tác đổi phòng — khách quay về phòng ${fromRoomNumber}${restoreFee > 0 ? `, hoàn phí ${restoreFee.toLocaleString('vi-VN')}đ` : ''}`,
      data: { booking },
    })
  } catch (err) {
    console.error('[undoMoveRoom] error:', err)
    next(err)
  }
}

const getAvailableByDate = async (req, res, next) => {
  try {
    const { checkIn, checkOut, branchId, excludeBookingId } = req.query
    if (!checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Cần truyền checkIn và checkOut' })

    const checkInDate  = new Date(checkIn)
    const checkOutDate = new Date(checkOut)
    if (checkOutDate <= checkInDate)
      return res.status(400).json({ success: false, message: 'checkOut phải sau checkIn' })

    const roomFilter = { roomStatus: { $ne: 'maintenance' } }
    if (branchId) roomFilter.branchId = branchId

    const allRooms = await Room.find(roomFilter).sort({ number: 1 })

    // ⭐ FIX: Tự xử lý conflict thay vì query Mongo trực tiếp
    //   actionType='reserve' vì đây là tìm phòng để ĐẶT (cho phép đặt sau khoảng A đang ở)
    const bookedRoomIds = new Set()
    for (const room of allRooms) {
      const conflictResult = await findOverlapForNewBooking({
        roomId:        room._id,
        intervalStart: checkInDate,
        intervalEnd:   checkOutDate,
        excludeBookingIds: excludeBookingId ? [excludeBookingId] : [],
        actionType:    'reserve',
      })
      if (conflictResult) {
        bookedRoomIds.add(String(room._id))
      }
    }

    const available = allRooms.filter(r => !bookedRoomIds.has(r._id.toString()))

    res.json({ success: true, data: { data: available, total: available.length } })
  } catch (err) { next(err) }
}
const applyDiscount = async (req, res, next) => {
  try {
    const {
      discountPercent = 0,
      discountAmount  = 0,
      isFreeRoom      = false,
      // ⭐ NEW 19/05/2026: Lý do + nhân viên chịu trách nhiệm
      discountReason   = '',
      discountChargedTo = null,   // userId nhân viên chịu (null = KS chịu)
    } = req.body
    const pct  = Math.max(0, Math.min(100, Number(discountPercent) || 0))
    const amt  = Math.max(0, Number(discountAmount) || 0)
    const free = !!isFreeRoom
    const reason = String(discountReason || '').trim()

    // ⭐ Validate: nếu có discount > 0 (% hoặc số tiền hoặc free) → bắt buộc lý do >= 5 ký tự
    const hasAnyDiscount = pct > 0 || amt > 0 || free
    if (hasAnyDiscount && reason.length < 5) {
      return res.status(400).json({
        success: false,
        code: 'DISCOUNT_REASON_REQUIRED',
        message: 'Vui lòng nhập lý do chiết khấu (≥ 5 ký tự)',
      })
    }

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

    // ⭐ Validate chargedTo (nếu có): phải là user thật + cùng branch + role admin/manager/receptionist
    let chargedToUser = null
    let chargedToName = null
    if (discountChargedTo) {
      try {
        const User = require('../models/User')   // adjust path nếu khác
        chargedToUser = await User.findById(discountChargedTo).select('_id fullName username email role branchId')
        if (!chargedToUser) {
          return res.status(400).json({ success: false, message: 'Không tìm thấy nhân viên được chọn' })
        }
        // Cùng branch
        if (String(chargedToUser.branchId) !== String(booking.branchId)) {
          return res.status(400).json({ success: false, message: 'Nhân viên không thuộc chi nhánh này' })
        }
        // Role hợp lệ (case-insensitive)
        const validRoles = ['admin', 'manager', 'receptionist']
        const roleNormalized = String(chargedToUser.role || '').toLowerCase().trim()
        if (!validRoles.includes(roleNormalized)) {
          return res.status(400).json({ success: false, message: 'Vai trò nhân viên không hợp lệ để chịu chiết khấu' })
        }
        chargedToName = chargedToUser.fullName || chargedToUser.username || chargedToUser.email || ''
      } catch (e) {
        console.error('[applyDiscount] User validation error:', e.message)
        return res.status(500).json({ success: false, message: 'Lỗi xác thực nhân viên' })
      }
    }

    const roomPart  = free ? 0 : (booking.roomAmount ?? 0)
    const subtotal  = roomPart + (booking.servicesAmount ?? 0)
    const pctDiscount = Math.round(subtotal * pct / 100)
    const totalDiscount = pctDiscount + amt

    booking.discountPercent = pct
    booking.discountAmount  = amt
    booking.isFreeRoom      = free
    booking.discount        = totalDiscount
    // ⭐ NEW: Lưu lý do + người chịu trách nhiệm
    booking.discountReason         = hasAnyDiscount ? reason : ''
    booking.discountChargedTo      = chargedToUser?._id ?? null
    booking.discountChargedToName  = chargedToName
    booking.discountChargedToRole  = chargedToUser ? String(chargedToUser.role || '').toLowerCase().trim() : null
    booking.discountAppliedAt      = hasAnyDiscount ? new Date() : null
    booking.discountAppliedBy      = req.user?._id ?? null
    booking.discountAppliedByName  = req.user?.fullName || req.user?.username || req.user?.email || null

    // ⭐ FIX 19/05/2026 v3: Cộng transferFee vào totalAmount (trước đây bỏ sót).
    //   Fallback từ transferHistory nếu booking.transferFee chưa sync.
    const historyFee = Array.isArray(booking.transferHistory)
      ? booking.transferHistory.reduce((s, t) => s + (Number(t?.fee) || 0), 0)
      : 0
    const transferFee = Math.max(booking.transferFee ?? 0, historyFee)
    booking.totalAmount = Math.max(0,
      roomPart + (booking.servicesAmount ?? 0) - totalDiscount + transferFee
    )

    await booking.save()

    const invoice = await Invoice.findOne({ bookingId: booking._id })
    if (invoice) {
      invoice.discount        = totalDiscount
      invoice.totalAmount     = booking.totalAmount
      invoice.remainingAmount = Math.max(0, invoice.totalAmount - (invoice.paidAmount ?? 0))
      invoice.paymentStatus   = invoice.paidAmount >= invoice.totalAmount ? 'paid' :
                                invoice.paidAmount > 0 ? 'partial' : 'unpaid'
      await invoice.save()
    }

    const desc = []
    if (pct > 0) desc.push(`${pct}%`)
    if (amt > 0) desc.push(`${amt.toLocaleString('vi-VN')}đ`)
    if (free)    desc.push('Miễn phí phòng')
    const chargedDesc = chargedToName ? ` (NV chịu: ${chargedToName})` : ''
    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'apply_discount',
      description: `Áp dụng chiết khấu: ${desc.join(' + ') || 'không có'}${chargedDesc}${reason ? ` — ${reason}` : ''}`,
      user: req.user, branchId: booking.branchId,
      metadata: {
        discountPercent: pct, discountAmount: amt, isFreeRoom: free,
        totalDiscount, newTotal: booking.totalAmount,
        discountReason: reason,
        discountChargedTo: chargedToUser?._id ?? null,
        discountChargedToName: chargedToName,
        discountChargedToRole: chargedToUser ? String(chargedToUser.role || '').toLowerCase().trim() : null,
      },
    })

    res.json({ success: true, message: 'Đã áp dụng chiết khấu', data: { booking } })
  } catch (err) { next(err) }
}

const calculateBill = async (req, res, next) => {
  try {
    const { mode = 'checkout', roomId: filterRoomId = null, atTime = null } = req.body
    if (!['now', 'checkout'].includes(mode))
      return res.status(400).json({ success: false, message: 'mode phải là "now" hoặc "checkout"' })

    const booking = await Booking.findById(req.params.id)
    if (!booking) return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })

    if (atTime) {
      const atTimeDate = new Date(atTime)
      const now = new Date()
      if (atTimeDate.getTime() < now.getTime() - 60000) {
        let roomNumberForAudit = null
        if (filterRoomId) {
          const sub = (booking.rooms ?? []).find(r =>
            String(r.roomId?._id ?? r.roomId) === String(filterRoomId)
          )
          if (sub) roomNumberForAudit = sub.roomNumber
        }
        const perm = await canSetPastTime(req.user, booking._id, roomNumberForAudit)
        if (!perm.canSetPast) {
          return res.status(403).json({
            success: false,
            code:    'FORBIDDEN_PAST_CHECKOUT',
            message: perm.reason,
            data: {
              userRole:   req.user?.role ?? null,
              atTime,
              roomNumber: roomNumberForAudit,
            },
          })
        }
      }
    }

    const branch = await Branch.findById(booking.branchId)

    const effectiveCheckIn = booking.actualCheckIn ?? booking.checkIn

    let effectiveCheckOut
    // ⭐ FIX 25/05/2026: Mốc HIỂN THỊ "Tính đến" = giờ THỰC đang xem (không ceil).
    //   effectiveCheckOut có thể bị ceil tới 12:00 để TÍNH TIỀN giá ngày trọn đêm (đúng),
    //   nhưng nhãn "Tính đến" phải là giờ hiện tại để khỏi gây nhầm "tính tới tương lai".
    let viewedAtForDisplay = null
    if (mode === 'now') {
      const refTime = atTime ? new Date(atTime) : new Date()
      effectiveCheckOut = refTime < effectiveCheckIn ? new Date(effectiveCheckIn.getTime() + 60000) : refTime
      viewedAtForDisplay = new Date(effectiveCheckOut)  // giờ thực TRƯỚC khi ceil

      // ⭐ FIX 24/05/2026 (v2): Quy tắc "QUÁ HẠN = TRỌN ĐÊM" — sửa MỐC kích hoạt.
      //   LỖI CŨ: ceil khi now > booking.checkOut (giờ trả KHÁCH ĐẶT, vd 18:00) → quá 18:00
      //   15 phút đã bị nhảy "Tính đến" sang 12:00 hôm sau → tính giá ngày sai.
      //   ĐÚNG (theo spec mục I): chỉ tính trọn đêm khi giờ hiện tại đã QUA MỐC
      //   dayEquivalentHours (vd 23h) của ngày, HOẶC đã thực sự SANG NGÀY khác so với
      //   giờ trả chuẩn. Trước mốc đó → tính tới giờ hiện tại (giá giờ/ngày + phụ thu trễ).
      //   Lưu ý: chỉ áp dụng khi KHÔNG có atTime (atTime = nhân viên chủ động chọn giờ).
      if (!atTime && booking.checkOut && effectiveCheckOut > new Date(booking.checkOut)) {
        const dayEquivH = Number(branch?.dayEquivalentHours ?? 23)
        const [coH, coM] = String(branch?.dayCheckOutTime || branch?.checkOutTime || '12:00')
          .split(':').map(Number)
        // Mốc giờ trả chuẩn của NGÀY check-out dự kiến
        const stdCheckoutOfPlanned = new Date(booking.checkOut)
        stdCheckoutOfPlanned.setHours(coH || 12, coM || 0, 0, 0)
        // Đã sang ngày khác so với ngày trả chuẩn?
        const isAfterPlannedDay =
          effectiveCheckOut.getFullYear() > stdCheckoutOfPlanned.getFullYear() ||
          (effectiveCheckOut.getFullYear() === stdCheckoutOfPlanned.getFullYear() &&
            effectiveCheckOut.getMonth() > stdCheckoutOfPlanned.getMonth()) ||
          (effectiveCheckOut.getFullYear() === stdCheckoutOfPlanned.getFullYear() &&
            effectiveCheckOut.getMonth() === stdCheckoutOfPlanned.getMonth() &&
            effectiveCheckOut.getDate() > stdCheckoutOfPlanned.getDate())
        // Đã qua mốc dayEquivalentHours của ngày hiện tại?
        const pastDayEquiv = effectiveCheckOut.getHours() >= dayEquivH
        // CHỈ ceil trọn đêm khi: qua mốc 23h cùng ngày, HOẶC đã sang ngày khác.
        if (pastDayEquiv || isAfterPlannedDay) {
          const ceil = new Date(effectiveCheckOut)
          ceil.setHours(coH || 12, coM || 0, 0, 0)
          if (ceil < effectiveCheckOut) ceil.setDate(ceil.getDate() + 1)
          effectiveCheckOut = ceil
        }
        // Ngược lại (vd 18:15, chưa qua 23h, cùng ngày) → GIỮ giờ hiện tại, không ceil.
      }
    } else {
      effectiveCheckOut = booking.checkOut
    }

    const isGroup = Array.isArray(booking.rooms) && booking.rooms.length > 1
    if (isGroup) {
      let totalRoomAmount = 0
      const allBreakdown = []
      const targetRooms = filterRoomId
        ? booking.rooms.filter(sr => String(sr.roomId?._id ?? sr.roomId) === String(filterRoomId))
        : booking.rooms

      let singleRoomPaid = 0

      for (const sr of targetRooms) {
        if (sr.status === 'cancelled') continue

        const room   = await Room.findById(sr.roomId).populate('typeId')
        const policy = sr.policyId ? await PricePolicy.findById(sr.policyId) : null
        const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
        const maxChildren = room?.typeId?.maxChildren ?? 0

        const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
        let subPriceResult
        if (sr.status === 'checked_out') {
          subPriceResult = {
            roomAmount: sr.roomAmount ?? 0,
            breakdown:  sr.priceBreakdown ?? [],
          }
        } else {
          const breakdownItems = Array.isArray(sr.priceBreakdown) ? sr.priceBreakdown : []
          // ⭐ FIX 25/05/2026: nhận diện chặng "phòng cũ" (seg1) theo SCHEMA META HIỆN TẠI.
          //   Schema cũ dùng segment===1; schema hiện tại (moveRoomBreakdown / rebuildBreakdownFromHistory)
          //   dùng segment:'oldNights'|'newNights'|'mergedNights' + roomNumber. Giữ cả 2 cho tương thích.
          const isOldSeg = (meta, srRoomNumber) =>
            meta?.segment === 1 ||
            meta?.policy === 'old' ||
            meta?.segment === 'oldNights' ||
            (meta?.roomNumber && String(meta.roomNumber) !== String(srRoomNumber))
          const hasMoveSegments = breakdownItems.some(b => isOldSeg(b?.meta, sr.roomNumber))

          if (hasMoveSegments && mode === 'now' && sr.status === 'checked_in') {
            // ⭐ FIX 25/05/2026: Sub-room đoàn ĐÃ CHUYỂN — dùng computeMoveRoomBreakdown
            //   (Y HỆT phòng lẻ ở nhánh hasTransferred) thay cho seg1/seg2 + calculatePrice.
            //   Lý do: calculatePrice tính chặng phòng MỚI theo NGUYÊN NGÀY → sai spec, và
            //   dính OVER_CAPACITY (khi chuyển sang phòng nhỏ hơn) làm mất trắng chặng mới.
            //   Module moveRoomBreakdown xử lý đúng quy tắc giờ/ngày khi đổi cùng ngày:
            //     • đổi SAU 12:00 (dayCheckOutTime), trước 23h (dayEquiv) → GIÁ GIỜ 12:00 → hiện tại
            //     • đổi TRƯỚC 12:00 → GIÁ GIỜ từ lúc đổi → hiện tại
            //     • đổi rạng sáng / qua mốc 23h / sang ngày khác → GIÁ NGÀY
            //   và KHÔNG enforce sức chứa nên không nuốt mất chặng mới.
            const hist = (booking.transferHistory || [])
              .filter(t => t?.transferAt && t?.toRoomNumber)
              .filter(t => String(t.toRoomNumber) === String(sr.roomNumber) ||
                           String(t?.toRoomId?._id ?? t?.toRoomId) === String(sr.roomId?._id ?? sr.roomId))
              .sort((a, b) => new Date(a.transferAt) - new Date(b.transferAt))
            const lastT = hist[hist.length - 1]

            if (!lastT) {
              // Không tìm thấy transfer của sub-room này → giữ breakdown đã lưu (an toàn)
              subPriceResult = {
                roomAmount: sr.roomAmount ?? 0,
                breakdown:  breakdownItems.map(b => (b && typeof b.toObject === 'function') ? b.toObject() : b),
              }
            } else {
              const oldRoomNum = lastT.fromRoomNumber
              const newRoomNum = sr.roomNumber
              let oldPolicy = null
              if (lastT.oldPolicyId) { try { oldPolicy = await PricePolicy.findById(lastT.oldPolicyId) } catch {} }
              if (!oldPolicy && booking.policySnapshot?.dayPrice) oldPolicy = booking.policySnapshot
              const newPolicy = policy

              let oldRoomType = ''
              let newRoomType = sr.roomType || room?.typeName || ''
              const newRoomTypeId = room?.typeId?._id ?? room?.typeId ?? null
              try {
                const d = await Room.findOne({ number: oldRoomNum, branchId: booking.branchId }).populate('typeId')
                if (d) oldRoomType = d.typeId?.name || d.typeName || ''
              } catch {}

              const hourSlotsOf = (pol) => {
                if (!pol) return []
                return (pol.hourSlots || []).map(s => {
                  const time = s.time || s.duration || ''
                  const m = String(time).match(/(\d+)/)
                  return { durationHours: m ? parseInt(m[1]) : 2, price: s.price || 0 }
                })
              }
              const newHourlyPolicy = await resolveHourlyPolicy(newRoomTypeId, booking.branchId)
              const newRoomHourSlots = newHourlyPolicy ? hourSlotsOf(newHourlyPolicy) : hourSlotsOf(newPolicy)

              // plannedCheckOut cho module: cap theo checkOut của SUB-ROOM (không phải booking)
              const subPlannedCO = sr.checkOut ?? booking.checkOut
              const plannedForSub = (() => {
                const planned = new Date(subPlannedCO)
                const eff = new Date(effectiveCheckOut)
                if (eff > planned) return eff   // quá hạn → eff (đã ceil trọn đêm ở khối trung tâm)
                return eff < planned ? eff : planned
              })()

              const items = computeMoveRoomBreakdown({
                actualCheckIn:   new Date(sr.actualCheckIn ?? booking.checkIn),
                plannedCheckOut: plannedForSub,
                transferAt:      new Date(lastT.transferAt),
                oldRoom: {
                  number: oldRoomNum, type: oldRoomType,
                  policy: { dayPrice: oldPolicy?.dayPrice || 0, hourSlots: hourSlotsOf(oldPolicy) },
                },
                newRoom: {
                  number: newRoomNum, type: newRoomType,
                  policy: {
                    dayPrice: newPolicy?.dayPrice || 0, hourSlots: newRoomHourSlots,
                    dayCheckInTime: newPolicy?.dayCheckInTime, dayCheckOutTime: newPolicy?.dayCheckOutTime,
                    dayEarlyCheckIn: newPolicy?.dayEarlyCheckIn, dayLateCheckOut: newPolicy?.dayLateCheckOut,
                    dayAdultSurcharge: newPolicy?.dayAdultSurcharge, dayChildSurcharge: newPolicy?.dayChildSurcharge,
                  },
                },
                transferFee: 0,   // fee tách riêng (booking.transferFee)
                changeRate:  String(lastT.oldPolicyId ?? '') !== String(lastT.newPolicyId ?? ''),
                isFreeRoom:  !!booking.isFreeRoom,
                branchConfig: branch ? {
                  checkInTime: branch.checkInTime, checkOutTime: branch.checkOutTime,
                  earlyCheckinUntil: branch.earlyCheckinUntil, toleranceMinutes: branch.toleranceMinutes,
                  dayEquivalentHours: branch.dayEquivalentHours,
                } : null,
              })

              let moveItems = items
                .filter(it => !(it.meta && it.meta.transferFee))
                .map(it => ({
                  label: it.label, amount: it.amount,
                  type: it.type === 'surcharge' ? 'surcharge' : 'base',
                  meta: it.meta || {},
                }))

              // Sửa mốc CUỐI label về giờ thực khi effectiveCheckOut bị ceil (giữ nguyên amount)
              if (mode === 'now' && viewedAtForDisplay
                  && viewedAtForDisplay.getTime() < new Date(effectiveCheckOut).getTime()) {
                const _pad = n => String(n).padStart(2, '0')
                const _va = viewedAtForDisplay
                const realEndStr = `${_pad(_va.getDate())}/${_pad(_va.getMonth() + 1)} ${_pad(_va.getHours())}:${_pad(_va.getMinutes())}`
                let _lastBaseIdx = -1
                for (let i = moveItems.length - 1; i >= 0; i--) {
                  if (moveItems[i].type === 'base') { _lastBaseIdx = i; break }
                }
                if (_lastBaseIdx >= 0) {
                  const it = moveItems[_lastBaseIdx]
                  const newLabel = it.label.replace(/→\s*\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\)/, `→ ${realEndStr})`)
                  if (newLabel !== it.label) moveItems[_lastBaseIdx] = { ...it, label: newLabel }
                }
              }

              subPriceResult = {
                roomAmount: moveItems.reduce((s, b) => s + (b.amount || 0), 0),
                breakdown:  moveItems,
              }
            }
          } else if (hasMoveSegments && mode === 'checkout') {
            const plainItems = breakdownItems.map(b =>
              (b && typeof b.toObject === 'function') ? b.toObject() : b
            )
            subPriceResult = {
              roomAmount: sr.roomAmount ?? 0,
              breakdown:  plainItems,
            }
          } else {
            const segCheckIn = sr.actualCheckIn ?? booking.checkIn
            const segCheckOut = (mode === 'now' && sr.status === 'checked_in')
              ? effectiveCheckOut
              : booking.checkOut

            subPriceResult = calculatePrice({
              checkIn:   segCheckIn,
              checkOut:  segCheckOut,
              priceType: sr.priceType ?? booking.priceType,
              policy, branch,
              adults:    sr.adults   ?? booking.adults,
              children:  sr.children ?? booking.children,
              maxAdults, maxChildren, maxOccupancy,
            })
          }
        }

        totalRoomAmount += subPriceResult.roomAmount ?? 0

        if (sr.status !== 'checked_out') {
          sr.roomAmount = subPriceResult.roomAmount ?? 0
        }
        singleRoomPaid += sr.paidAmount ?? 0

        const subItems = (subPriceResult.breakdown ?? []).map(b => {
          const itemRoomNum = b?.meta?.roomNumber ?? sr.roomNumber
          const labelStr = String(b.label ?? '')
          const hasPrefix = /^\[[^\]]+\]\s/.test(labelStr)
          return {
            ...b,
            label: hasPrefix ? labelStr : `[${itemRoomNum}] ${labelStr}`,
            meta:  { ...(b.meta || {}), roomNumber: itemRoomNum },
          }
        })
        allBreakdown.push(...subItems)
      }

      if (filterRoomId) {
        const sr = targetRooms[0]
        if (!sr) {
          return res.status(404).json({ success: false, message: 'Không tìm thấy phòng trong đoàn' })
        }
        const subServices = sr.servicesAmount ?? 0
        const subDiscount = sr.discountAmount ?? 0
        const subTotalAmount = Math.max(0, totalRoomAmount + subServices - subDiscount)

        let subPaidAmount = sr.paidAmount ?? 0

        const invoiceForPay = await Invoice.findOne({ bookingId: booking._id })
        const invoicePaidTotal = invoiceForPay?.paidAmount ?? 0
        const otherSubPaidSum = booking.rooms
          .filter(r => r !== sr)
          .reduce((s, r) => {
            const rTotal = (r.roomAmount ?? 0) + (r.servicesAmount ?? 0) - (r.discountAmount ?? 0)
            return s + Math.min(r.paidAmount ?? 0, rTotal)
          }, 0)
        const excessInvoicePaid = Math.max(0, invoicePaidTotal - otherSubPaidSum)
        subPaidAmount = Math.max(subPaidAmount, excessInvoicePaid)

        subPaidAmount = Math.min(subPaidAmount, subTotalAmount)

        const subRemainingAmount = Math.max(0, subTotalAmount - subPaidAmount)

        const groupRoomAmount = booking.rooms.reduce((s, r) => {
          if (r.status === 'cancelled') return s
          return s + (r.roomAmount ?? 0)
        }, 0)
        const groupServicesAmount = booking.servicesAmount ?? 0
        const groupSubtotalForDisc = groupRoomAmount + groupServicesAmount
        const groupPctDisc = Math.round(groupSubtotalForDisc * (booking.discountPercent ?? 0) / 100)
        const groupTotalAmount = Math.max(0,
          groupRoomAmount + groupServicesAmount - groupPctDisc - (booking.discountAmount ?? 0) + (booking.transferFee ?? 0)
        )
        const groupPaidAmount = invoicePaidTotal
        const groupRemaining = Math.max(0, groupTotalAmount - groupPaidAmount)

        return res.json({
          success: true,
          data: {
            mode,
            effectiveCheckOut,
            isGroup:          true,
            isSingleRoomMode: true,
            roomId:           String(sr.roomId?._id ?? sr.roomId),
            roomNumber:       sr.roomNumber,
            roomAmount:       totalRoomAmount,
            servicesAmount:   subServices,
            discount:         subDiscount,
            transferFee:      0,
            totalAmount:      subTotalAmount,
            paidAmount:       subPaidAmount,
            remainingAmount:  subRemainingAmount,
            breakdown:        allBreakdown,
            groupTotalAmount,
            groupPaidAmount,
            groupRemaining,
            groupRoomCount:   booking.rooms.filter(r => r.status !== 'cancelled').length,
          },
        })
      }

      const servicesAmount = booking.servicesAmount ?? 0

      let recalcDiscount = booking.discount ?? 0
      if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
        const roomPart = booking.isFreeRoom ? 0 : totalRoomAmount
        const subtotal = roomPart + servicesAmount
        const pctDiscount = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
        recalcDiscount = pctDiscount + (booking.discountAmount ?? 0)
      }

      const roomPart    = booking.isFreeRoom ? 0 : totalRoomAmount
      const transferFee = booking.transferFee ?? 0
      const totalAmount = Math.max(0, roomPart + servicesAmount - recalcDiscount + transferFee)

      const invoice = await Invoice.findOne({ bookingId: booking._id })
      const paidAmount      = invoice?.paidAmount ?? 0
      const remainingAmount = Math.max(0, totalAmount - paidAmount)

      const perRoomPaid = booking.rooms.map(sr => ({
        roomId:          String(sr.roomId?._id ?? sr.roomId),
        roomNumber:      sr.roomNumber,
        status:          sr.status,
        roomAmount:      sr.roomAmount ?? 0,
        servicesAmount:  sr.servicesAmount ?? 0,
        discountAmount:  sr.discountAmount ?? 0,
        paidAmount:      sr.paidAmount ?? 0,
        totalAmount:     (sr.roomAmount ?? 0) + (sr.servicesAmount ?? 0) - (sr.discountAmount ?? 0),
        remainingAmount: Math.max(0, (sr.roomAmount ?? 0) + (sr.servicesAmount ?? 0) - (sr.discountAmount ?? 0) - (sr.paidAmount ?? 0)),
      }))

      return res.json({
        success: true,
        data: {
          mode,
          effectiveCheckOut,
          isGroup:          true,
          totalRooms:       booking.rooms.length,
          checkedOutRooms:  booking.rooms.filter(r => r.status === 'checked_out').length,
          roomAmount:       totalRoomAmount,
          servicesAmount,
          discount:         recalcDiscount,
          transferFee,
          totalAmount,
          paidAmount,
          remainingAmount,
          breakdown:        allBreakdown,
          perRoomPaid,
        },
      })
    }

    const room   = await Room.findById(booking.roomId).populate('typeId')
    const policy = booking.policyId ? await PricePolicy.findById(booking.policyId) : null
    const maxAdults   = room?.typeId?.maxAdults   ?? room?.typeId?.capacity ?? 2
    const maxChildren = room?.typeId?.maxChildren ?? 0

    const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
    const hasCustomPrice = (booking.priceBreakdown ?? []).some(b => b.meta?.customPrice === true)

    // ⭐ FIX 24/05/2026: Chỉ tính các lần chuyển ĐÃ XẢY RA tính tới thời điểm xem.
    //   Khi xem "Đến hiện tại" ở mốc TRƯỚC khi đổi phòng (now/atTime < transferAt),
    //   sự kiện chuyển chưa diễn ra → bỏ qua, chỉ tính phòng khách thực đang ở tới giờ xem.
    //   Tránh lỗi: tính phòng cũ quá giờ xem + cộng phụ thu chuyển phòng của sự kiện tương lai.
    //   (mode='checkout' dùng booking.checkOut nên mọi transfer trong kỳ đều đã xảy ra → giữ đủ.)
    const _allTransfers = (booking.transferHistory ?? [])
      .filter(t => t?.transferAt && t?.fromRoomNumber && t?.toRoomNumber)
      .sort((a, b) => new Date(a.transferAt) - new Date(b.transferAt))
    const _occurredTransfers = _allTransfers.filter(
      t => new Date(t.transferAt) <= new Date(effectiveCheckOut)
    )
    // Booking "view" theo thời điểm xem: nếu có transfer tương lai bị loại, phòng đang ở
    // phải lùi về phòng GỐC tại mốc xem (fromRoomNumber của transfer kế tiếp chưa xảy ra).
    const _firstFutureTransfer = _allTransfers.find(
      t => new Date(t.transferAt) > new Date(effectiveCheckOut)
    )
    // ⭐ FIX: dùng PLAIN OBJECT (không kế thừa prototype Mongoose) để tránh lỗi
    //   "Cannot read ...mongoose#Document#scope". booking_view chỉ dùng để ĐỌC
    //   (transferHistory đã lọc, roomNumber, actualCheckIn...), không gọi method Mongoose.
    const _bookingPlain = (booking && typeof booking.toObject === 'function')
      ? booking.toObject({ virtuals: true })
      : booking
    const booking_view = (_occurredTransfers.length !== _allTransfers.length)
      ? {
          ..._bookingPlain,
          transferHistory: _occurredTransfers,
          // phòng đang ở tại mốc xem = phòng nguồn của lần chuyển tương lai gần nhất
          roomNumber: _firstFutureTransfer ? _firstFutureTransfer.fromRoomNumber : booking.roomNumber,
        }
      : booking

    const hasTransferred = (booking_view.transferHistory ?? []).length > 0
    const lastTransfer = hasTransferred ? booking_view.transferHistory[booking_view.transferHistory.length - 1] : null

    let priceResult
    if (hasCustomPrice) {
      if (mode === 'now') {
        const now = new Date()
        const parseTime = (str) => {
          if (!str) return null
          const dt = new Date(str)
          if (!isNaN(dt.getTime())) return dt
          return null
        }
        const parseRange = (b, refDate) => {
          const mStart = parseTime(b.meta?.startTime)
          const mEnd   = parseTime(b.meta?.endTime)
          if (mStart && mEnd) return { start: mStart, end: mEnd }
          const label = String(b.label ?? '')
          const m = label.match(/\((\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})\)/)
          if (!m) return null
          const [, sd, sm, sh, smi, ed, em, eh, emi] = m
          const year = new Date(refDate ?? Date.now()).getFullYear()
          const start = new Date(year, +sm - 1, +sd, +sh, +smi, 0, 0)
          const end   = new Date(year, +em - 1, +ed, +eh, +emi, 0, 0)
          return { start, end }
        }

        const refDate = booking.checkIn ?? booking.actualCheckIn ?? new Date()
        let nightsToShow = 0
        const baseItems = (booking.priceBreakdown ?? []).filter(b => b.type === 'base')

        for (const b of baseItems) {
          const range = parseRange(b, refDate)
          if (!range) {
            nightsToShow++
            continue
          }
          if (now >= range.end) {
            nightsToShow++
          } else if (now >= range.start) {
            nightsToShow++
            break
          } else {
            const effCheckIn = booking.actualCheckIn ?? booking.checkIn
            if (effCheckIn && now >= effCheckIn && nightsToShow === 0) {
              nightsToShow++
            }
            break
          }
        }

        const filteredBreakdown = []
        let baseCount = 0
        for (const b of (booking.priceBreakdown ?? [])) {
          if (b.type === 'base') {
            if (baseCount < nightsToShow) {
              filteredBreakdown.push(b)
              baseCount++
            }
          } else {
            filteredBreakdown.push(b)
          }
        }

        const filteredTotal = filteredBreakdown.reduce((s, b) => s + (b.amount ?? 0), 0)
        priceResult = {
          roomAmount:       filteredTotal,
          nights:           nightsToShow || booking.nights,
          breakdown:        filteredBreakdown,
          finalPriceType:   booking.priceType,
          converted:        false,
          notice:           null,
        }
      } else {
        priceResult = {
          roomAmount:       booking.roomAmount,
          nights:           booking.nights,
          breakdown:        booking.priceBreakdown ?? [],
          finalPriceType:   booking.priceType,
          converted:        false,
          notice:           null,
        }
      }
    } else if (hasTransferred) {
      // ⭐ FIX 19/05/2026: Gộp 2 mode 'now' và 'checkout' vào chung logic v20.1.
      //   Khác biệt duy nhất: effectiveCheckOut.
      //     - mode='now'      → now()           → có overstay → push "Trả phòng muộn"
      //     - mode='checkout' → booking.checkOut → không overstay → không push
      //   Nhánh cũ mode='checkout' đọc thẳng booking.priceBreakdown/roomAmount — sai
      //   khi DB stale (vd: sau changeDates với booking đã transfer thì DB lưu giá
      //   theo policy phòng MỚI × toàn bộ thời gian, không phân đoạn cũ/mới).
      //   v20.0: Dùng moveRoomBreakdown để tính breakdown đúng spec
      //   Replay lần transfer cuối với plannedCheckOut = booking.checkOut (giờ trả CHUẨN)

      // ⭐ FIX 19/05/2026 v3: Multi-transfer fallback.
      //   computeMoveRoomBreakdown chỉ build cho 1 transfer. Với ≥ 2 transfer,
      //   booking.priceBreakdown được build incrementally trong moveRoom handler
      //   (mỗi lần move thêm seg mới). Recompute từ đầu sẽ mất segment trung gian.
      //   → Ưu tiên đọc từ DB, không recompute.
      const transferCount = (booking_view.transferHistory ?? []).length
      if (transferCount >= 2) {
        // ⭐ FIX 24/05/2026: ≥2 transfer — HYBRID:
        //   - Các chặng CŨ (đã ở xong, mọi phòng trừ phòng đang ở): lấy từ rebuild
        //     (finalized, KHÔNG nuốt chặng giữa như đọc DB stale trước đây).
        //   - Chặng ĐANG Ở (phòng hiện tại): tính LIVE bằng computeMoveRoomBreakdown
        //     của lần đổi CUỐI → giữ đúng quy tắc giờ↔ngày theo dayEquivalentHours
        //     (live trước 23h = giá giờ từ transferAt; sau 23h = giá ngày).
        try {
          const hist = (booking_view.transferHistory ?? [])
            .filter(t => t?.transferAt && t?.fromRoomNumber && t?.toRoomNumber)
            .sort((a, b) => new Date(a.transferAt) - new Date(b.transferAt))
          const lastT = hist[hist.length - 1]

          // (1) Rebuild để lấy các chặng CŨ đã finalized (bỏ chặng phòng đang ở).
          const rebuilt = await rebuildBookingBreakdown(booking_view, branch, {
            plannedCheckOut: new Date(lastT.transferAt),   // chỉ tới mốc đổi cuối → chỉ ra chặng cũ
          })
          const frozenItems = (rebuilt?.breakdown ?? [])
            .filter(b => b?.meta?.finalized)

          // (2) Chặng đang ở: replay lần đổi cuối bằng module (giờ/ngày đúng theo 23h).
          const oldRoomNum = lastT.fromRoomNumber
          const newRoomNum = lastT.toRoomNumber
          let oldPolicy = null
          if (lastT.oldPolicyId) { try { oldPolicy = await PricePolicy.findById(lastT.oldPolicyId) } catch {} }
          if (!oldPolicy && booking.policySnapshot?.dayPrice) oldPolicy = booking.policySnapshot
          const newPolicy = policy

          let newRoomTypeId = null, oldRoomType = '', newRoomType = booking.roomType || ''
          try {
            const d = await Room.findOne({ number: oldRoomNum, branchId: booking.branchId }).populate('typeId')
            if (d) oldRoomType = d.typeId?.name || d.typeName || ''
          } catch {}
          try {
            const d = await Room.findOne({ number: newRoomNum, branchId: booking.branchId }).populate('typeId')
            if (d) { newRoomType = d.typeId?.name || d.typeName || newRoomType; newRoomTypeId = d.typeId?._id || d.typeId || null }
          } catch {}

          const hourSlotsOf = (pol) => {
            if (!pol) return []
            return (pol.hourSlots || []).map(s => {
              const time = s.time || s.duration || ''
              const m = String(time).match(/(\d+)/)
              return { durationHours: m ? parseInt(m[1]) : 2, price: s.price || 0 }
            })
          }
          const newHourlyPolicy = await resolveHourlyPolicy(newRoomTypeId, booking.branchId)
          const newRoomHourSlots = newHourlyPolicy ? hourSlotsOf(newHourlyPolicy) : hourSlotsOf(newPolicy)

          const plannedForLast = (() => {
            const planned = new Date(booking.checkOut)
            const eff = new Date(effectiveCheckOut)
            if (eff > planned) return eff
            return eff < planned ? eff : planned
          })()

          const liveItems = computeMoveRoomBreakdown({
            actualCheckIn:   new Date(booking.actualCheckIn ?? booking.checkIn),  // ⭐ giờ nhận GỐC (để logic giờ/ngày khớp nhánh 1-transfer)
            plannedCheckOut: plannedForLast,
            transferAt:      new Date(lastT.transferAt),
            oldRoom: { number: oldRoomNum, type: oldRoomType, policy: { dayPrice: oldPolicy?.dayPrice || 0, hourSlots: hourSlotsOf(oldPolicy) } },
            newRoom: { number: newRoomNum, type: newRoomType, policy: {
              dayPrice: newPolicy?.dayPrice || 0, hourSlots: newRoomHourSlots,
              dayCheckInTime: newPolicy?.dayCheckInTime, dayCheckOutTime: newPolicy?.dayCheckOutTime,
              dayEarlyCheckIn: newPolicy?.dayEarlyCheckIn, dayLateCheckOut: newPolicy?.dayLateCheckOut,
              dayAdultSurcharge: newPolicy?.dayAdultSurcharge, dayChildSurcharge: newPolicy?.dayChildSurcharge,
            } },
            transferFee: 0,   // fee tách riêng (booking.transferFee)
            // ⭐ FIX 25/05/2026: changeRate theo ý định nhân viên (policyId), không suy từ loại phòng.
            changeRate:  String(lastT.oldPolicyId ?? '') !== String(lastT.newPolicyId ?? ''),
            isFreeRoom:  !!booking.isFreeRoom,
            branchConfig: branch ? {
              checkInTime: branch.checkInTime, checkOutTime: branch.checkOutTime,
              earlyCheckinUntil: branch.earlyCheckinUntil, toleranceMinutes: branch.toleranceMinutes,
              dayEquivalentHours: branch.dayEquivalentHours,
            } : null,
          })
          // Chỉ giữ các dòng của phòng ĐANG Ở (bỏ dòng phòng cũ trùng + fee)
          let liveOfCurrent = liveItems
            .filter(it => !(it.meta && it.meta.transferFee))
            .filter(it => String(it.meta?.roomNumber) === String(newRoomNum))
            .map(it => ({ label: it.label, amount: it.amount, type: it.type === 'surcharge' ? 'surcharge' : 'base', meta: it.meta || {} }))

          // ⭐ FIX 25/05/2026: Khi effectiveCheckOut bị CEIL (tới 12:00) để tính tiền giá
          //   ngày trọn đêm, label chặng cuối ghi mốc "→ 12:00" gây nhầm. Sửa mốc CUỐI
          //   trong label về GIỜ THỰC đang xem (viewedAtForDisplay), GIỮ NGUYÊN amount.
          //   Chỉ áp khi mode='now' + có ceil (viewedAt < effectiveCheckOut).
          if (mode === 'now' && viewedAtForDisplay
              && viewedAtForDisplay.getTime() < new Date(effectiveCheckOut).getTime()) {
            const _pad = n => String(n).padStart(2, '0')
            const _va = viewedAtForDisplay
            const realEndStr = `${_pad(_va.getDate())}/${_pad(_va.getMonth() + 1)} ${_pad(_va.getHours())}:${_pad(_va.getMinutes())}`
            let _lastBaseIdx = -1
            for (let i = liveOfCurrent.length - 1; i >= 0; i--) {
              if (liveOfCurrent[i].type === 'base') { _lastBaseIdx = i; break }
            }
            if (_lastBaseIdx >= 0) {
              const it = liveOfCurrent[_lastBaseIdx]
              const newLabel = it.label.replace(/→\s*\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\)/, `→ ${realEndStr})`)
              if (newLabel !== it.label) liveOfCurrent[_lastBaseIdx] = { ...it, label: newLabel }
            }
          }

          // ⭐ FIX 24/05/2026: Việc bỏ "Trả phòng trễ" khi chặng mới tính GIÁ GIỜ đã được
          //   xử lý TRONG computeMoveRoomBreakdown (cờ newRoomPricedHourly). Ở đây KHÔNG lọc
          //   theo same-day nữa — vì nếu chặng mới ra GIÁ NGÀY thì trả trễ VẪN tính (đúng spec).

          const merged = [...frozenItems, ...liveOfCurrent]
          priceResult = {
            roomAmount:     merged.filter(b => !(b.meta && b.meta.excludeFromTotal)).reduce((s, b) => s + (b.amount || 0), 0),
            nights:         booking.nights,
            breakdown:      merged,
            finalPriceType: booking.priceType,
            converted:      false,
            notice:         null,
          }
        } catch (e) {
          console.error('[calculateBill ≥2 transfer] hybrid failed, fallback DB:', e.message)
          priceResult = {
            roomAmount:     booking.roomAmount,
            nights:         booking.nights,
            breakdown:      booking.priceBreakdown ?? [],
            finalPriceType: booking.priceType,
            converted:      false,
            notice:         null,
          }
        }
      } else {
      try {
        const oldRoomNum = lastTransfer.fromRoomNumber
        const newRoomNum = lastTransfer.toRoomNumber

        // Resolve policies
        let oldPolicy = null
        if (lastTransfer.oldPolicyId) {
          oldPolicy = await PricePolicy.findById(lastTransfer.oldPolicyId)
        }
        if (!oldPolicy && booking.policySnapshot && booking.policySnapshot.dayPrice) {
          oldPolicy = booking.policySnapshot
        }
        const newPolicy = policy  // policy hiện tại = phòng mới

        // Resolve room types từ Room collection
        let oldRoomType = ''
        let newRoomType = booking.roomType || ''
        let newRoomTypeId = null   // ⭐ NEW: để query hourly policy
        try {
          const oldRoomDoc = await Room.findOne({
            number: oldRoomNum, branchId: booking.branchId,
          }).populate('typeId')
          if (oldRoomDoc) {
            oldRoomType = oldRoomDoc.typeId?.name || oldRoomDoc.typeName || ''
          }
        } catch (_) {}
        try {
          const newRoomDoc = await Room.findOne({
            number: newRoomNum, branchId: booking.branchId,
          }).populate('typeId')
          if (newRoomDoc) {
            newRoomType   = newRoomDoc.typeId?.name || newRoomDoc.typeName || newRoomType
            newRoomTypeId = newRoomDoc.typeId?._id || newRoomDoc.typeId || null
          }
        } catch (_) {}

        const hourSlotsOf = (pol) => {
          if (!pol) return []
          return (pol.hourSlots || []).map(s => {
            const time = s.time || s.duration || ''
            const m = String(time).match(/(\d+)/)
            return {
              durationHours: m ? parseInt(m[1]) : 2,
              price: s.price || 0,
            }
          })
        }

        // ⭐ NEW 20/05/2026: Lấy bảng giá GIỜ từ policy hourEnabled của roomType phòng MỚI
        //   ("Giá Nghỉ Giờ") — KHÔNG dùng hourSlots của policy giá ngày booking đang dùng.
        const newHourlyPolicy = await resolveHourlyPolicy(newRoomTypeId, booking.branchId)
        const newRoomHourSlots = newHourlyPolicy
          ? hourSlotsOf(newHourlyPolicy)
          : hourSlotsOf(newPolicy)

        const items = computeMoveRoomBreakdown({
          actualCheckIn:   effectiveCheckIn,
          // ⭐ FIX 19/05/2026 v2: plannedCheckOut = min(booking.checkOut, effectiveCheckOut)
          //   - effectiveCheckOut > booking.checkOut (overstay): dùng booking.checkOut,
          //     phần trễ được block baseline-vs-overstay (3609–3656) push "Trả phòng muộn"
          //   - effectiveCheckOut < booking.checkOut (trả sớm / past-checkout): dùng
          //     effectiveCheckOut, module tính đến đúng giờ trả sớm, KHÔNG tính dư.
          //   Phiên bản cũ luôn dùng booking.checkOut → tính dư khi past-checkout < planned CO.
          // ⭐ FIX 21/05/2026: mode 'now' — nếu giờ hiện tại đã VƯỢT mốc dayEquivalentHours
          //   (vd 20:00) thì làm tròn LÊN giờ checkout chuẩn ngày hôm sau (tính thêm 1 đêm),
          //   khớp với logic priceCalculator (nhánh thường). computeMoveRoomBreakdown KHÔNG tự
          //   xử lý dayEquiv nên phải làm tròn ở đây, riêng nhánh chuyển phòng.
          // ⭐ FIX 24/05/2026 v3: effectiveCheckOut ĐÃ được ceil "trọn đêm" ở khối trung tâm
          //   (khi quá hạn). Ở đây chỉ cần:
          //   - Quá hạn (eff > booking.checkOut): dùng thẳng eff (đã là giờ trả chuẩn trọn đêm).
          //   - Chưa quá hạn (trả sớm/đúng hạn): cap ở booking.checkOut (không tính dư).
          plannedCheckOut: (() => {
            const planned = new Date(booking.checkOut)
            const eff = new Date(effectiveCheckOut)
            if (eff > planned) return eff   // quá hạn → trọn đêm (eff đã ceil sẵn)
            return eff < planned ? eff : planned   // chưa quá hạn → cap
          })(),
          transferAt:      new Date(lastTransfer.transferAt),
          oldRoom: {
            number: oldRoomNum,
            type:   oldRoomType,
            policy: {
              dayPrice:  oldPolicy?.dayPrice || 0,
              hourSlots: hourSlotsOf(oldPolicy),
            },
          },
          newRoom: {
            number: newRoomNum,
            type:   newRoomType,
            policy: {
              dayPrice:  newPolicy?.dayPrice || 0,
              hourSlots: newRoomHourSlots,
              // ⭐ FIX 23/05/2026: Truyền đủ field để moveRoomBreakdown tính phụ thu
              //   trả muộn (dayLateCheckOut) + nhận sớm (dayEarlyCheckIn) + giờ chuẩn.
              //   Trước đây chỉ truyền dayPrice + hourSlots → module thiếu dayLateCheckOut
              //   → KHÔNG tính được "Trả phòng trễ" → mất phụ thu (lỗi BK_5TW5US).
              dayCheckInTime:   newPolicy?.dayCheckInTime,
              dayCheckOutTime:  newPolicy?.dayCheckOutTime,
              dayEarlyCheckIn:  newPolicy?.dayEarlyCheckIn,
              dayLateCheckOut:  newPolicy?.dayLateCheckOut,
              dayAdultSurcharge: newPolicy?.dayAdultSurcharge,
              dayChildSurcharge: newPolicy?.dayChildSurcharge,
            },
          },
          // ⭐ FIX: Truyền fee từ transferHistory để module sinh dòng phụ thu
          //   booking.transferFee là TỔNG dồn các lần chuyển — đây chỉ lấy fee lần cuối
          transferFee: Number(lastTransfer.fee) || 0,
          // ⭐ FIX 25/05/2026: changeRate theo ý định nhân viên (policyId), không suy từ loại phòng.
          changeRate:  String(lastTransfer.oldPolicyId ?? '') !== String(lastTransfer.newPolicyId ?? ''),
          isFreeRoom:  !!booking.isFreeRoom,
          branchConfig: branch ? {
            checkInTime: branch.checkInTime,
            checkOutTime: branch.checkOutTime,
            earlyCheckinUntil: branch.earlyCheckinUntil,
            toleranceMinutes: branch.toleranceMinutes,
            dayEquivalentHours: branch.dayEquivalentHours,
          } : null,
        })

        // ⭐ FIX: KHÔNG filter fee item nữa — để nó hiển thị trong breakdown
        //   Nhưng phải cẩn thận: không double count với booking.transferFee đã cộng vào totalAmount
        let breakdownItems = items.map(it => ({
          label: it.label,
          amount: it.amount,
          type: it.type === 'surcharge' ? 'surcharge' : 'base',
          meta: it.meta || {},
        }))

        // ⭐ FIX 25/05/2026: sửa mốc CUỐI label chặng về GIỜ THỰC khi effectiveCheckOut bị ceil
        //   (giữ amount giá ngày trọn đêm). Chỉ sửa dòng base CUỐI (chặng đang ở), không đụng chặng cũ.
        if (mode === 'now' && viewedAtForDisplay
            && viewedAtForDisplay.getTime() < new Date(effectiveCheckOut).getTime()) {
          const _pad = n => String(n).padStart(2, '0')
          const _va = viewedAtForDisplay
          const realEndStr = `${_pad(_va.getDate())}/${_pad(_va.getMonth() + 1)} ${_pad(_va.getHours())}:${_pad(_va.getMinutes())}`
          let _lastBaseIdx = -1
          for (let i = breakdownItems.length - 1; i >= 0; i--) {
            if (breakdownItems[i].type === 'base') { _lastBaseIdx = i; break }
          }
          if (_lastBaseIdx >= 0) {
            const it = breakdownItems[_lastBaseIdx]
            const newLabel = it.label.replace(/→\s*\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\)/, `→ ${realEndStr})`)
            if (newLabel !== it.label) breakdownItems[_lastBaseIdx] = { ...it, label: newLabel }
          }
        }

        // ⭐ FIX 24/05/2026: BỎ dòng "Trả phòng trễ" của phòng MỚI khi xem live (mode='now')
        //   mà giờ xem CÙNG NGÀY calendar với lúc đổi phòng. Lý do nghiệp vụ: khách vừa
        //   đổi vào phòng mới trong ngày, chưa thể "trả trễ" — phí trễ chỉ vô nghĩa khi
        //   khách còn ở tiếp trong cùng ngày. Nếu đã sang ngày khác (qua đêm) → GIỮ.
        //   Chỉ áp dụng cho chặng đổi phòng (lateCheckout của phòng mới), không đụng booking thường.
        // ⭐ FIX 24/05/2026: Việc bỏ "Trả phòng trễ" khi chặng mới tính GIÁ GIỜ đã xử lý
        //   TRONG computeMoveRoomBreakdown (cờ newRoomPricedHourly). KHÔNG lọc theo same-day
        //   ở đây — nếu chặng mới ra GIÁ NGÀY thì trả trễ VẪN tính (đúng quy tắc).

        // ⭐ FIX 18/05/2026 (v20.1) — Bổ sung phụ thu
        //   moveRoomBreakdown CHỈ trả tiền phòng. Cần thêm:
        //   1. "Nhận phòng sớm" của phòng CŨ → đọc từ booking.priceBreakdown (đã preserve ở moveRoom)
        //   2. "Trả phòng muộn" của phòng MỚI → tính từ giờ chuẩn CO → effectiveCheckOut
        //   3. Phụ thu vượt sức chứa → tính từ phòng MỚI
        //
        //   KHÔNG gọi calculatePrice với checkIn=transferAt vì sẽ sinh "Nhận phòng sớm" SAI
        try {
          // ⭐ FIX 19/05/2026 v21: Bỏ block (1) "PRESERVE Nhận phòng sớm" từ DB.
          //   Module moveRoomBreakdown v21 đã tự tính phụ thu "Nhận phòng sớm" của phòng cũ
          //   dựa trên policy.dayEarlyCheckIn (computeTimeSurcharge) khi actualCheckIn < CI chuẩn
          //   cùng ngày. → KHÔNG cần preserve từ DB nữa (sẽ double count).
          //   Lưu ý: bookings cũ có dòng "Nhận phòng sớm" trong DB sẽ bị "thay thế" bằng
          //   recompute từ policy hiện tại → đảm bảo nhất quán.

          // ── (2) Tính phụ thu CO trễ cho phòng MỚI ──
          //   Approach: Gọi calculatePrice 2 lần:
          //     - Lần 1: với plannedCheckOut (giờ chuẩn) → roomAmount baseline
          //     - Lần 2: với effectiveCheckOut (giờ hiện tại) → roomAmount overstay
          //   Diff = phụ thu CO trễ. Bằng cách này bắt được cả "convert to night" case
          //   (priceCalculator add 1 base night thay vì surcharge khi co.getHours() >= dayEquivHours).
          const newRoomDoc = await Room.findById(booking.roomId).populate('typeId')
          const newMaxAdults    = newRoomDoc?.typeId?.maxAdults   ?? newRoomDoc?.typeId?.capacity ?? 2
          const newMaxChildren  = newRoomDoc?.typeId?.maxChildren ?? 0
          const newMaxOccupancy = newRoomDoc?.typeId?.maxOccupancy ?? (newMaxAdults + newMaxChildren)

          const transferAtDate = new Date(lastTransfer.transferAt)
          const ciHourStr = branch?.checkInTime || '14:00'
          const [ciH, ciM] = String(ciHourStr).split(':').map(Number)
          const standardCIofTransferDay = new Date(transferAtDate)
          standardCIofTransferDay.setHours(ciH || 14, ciM || 0, 0, 0)
          const surchargeCheckIn = transferAtDate > standardCIofTransferDay
            ? transferAtDate
            : standardCIofTransferDay

          // Baseline: với plannedCheckOut (không trễ).
          //   ⭐ FIX 19/05/2026 v2: dùng min(booking.checkOut, effectiveCheckOut) để
          //   khi past-checkout (effectiveCheckOut < booking.checkOut), baseline không
          //   tính dư đêm ở phụ thu vượt sức chứa (NL/TE).
          const baselineCheckOut = effectiveCheckOut < new Date(booking.checkOut)
            ? effectiveCheckOut
            : new Date(booking.checkOut)
          const baselineResult = calculatePrice({
            checkIn:   surchargeCheckIn,
            checkOut:  baselineCheckOut,
            priceType: booking.priceType,
            policy:    newPolicy,
            branch,
            adults:    booking.adults,
            children:  booking.children,
            maxAdults: newMaxAdults,
            maxChildren: newMaxChildren,
            maxOccupancy: newMaxOccupancy,
          })

          const baselineAmount = baselineResult?.roomAmount || 0

          // Overstay: với effectiveCheckOut (= now)
          const overstayResult = calculatePrice({
            checkIn:   surchargeCheckIn,
            checkOut:  effectiveCheckOut,           // ⭐ now
            priceType: booking.priceType,
            policy:    newPolicy,
            branch,
            adults:    booking.adults,
            children:  booking.children,
            maxAdults: newMaxAdults,
            maxChildren: newMaxChildren,
            maxOccupancy: newMaxOccupancy,
          })

          const overstayAmount = overstayResult?.roomAmount || 0
          const overstayDiff = Math.max(0, overstayAmount - baselineAmount)

          // ── Thêm dòng "Trả phòng muộn" nếu có chênh lệch ──
          // ⭐ FIX 23/05/2026: VÔ HIỆU HÓA block này. moveRoomBreakdown (sau khi được
          //   truyền đủ dayLateCheckOut) đã TỰ tính "Trả phòng trễ" cho phòng mới dựa trên
          //   plannedCheckOut (đã qua roundUpCheckoutForNow xử lý cả overstay/dayEquiv).
          //   Giữ block này sẽ THÊM dòng trả muộn LẦN 2 → double count.
          if (false && overstayDiff > 0 && effectiveCheckOut > new Date(booking.checkOut)) {
            const lateMs = effectiveCheckOut.getTime() - new Date(booking.checkOut).getTime()
            const lateH = Math.floor(lateMs / 3600000)
            const lateM = Math.round((lateMs % 3600000) / 60000)
            const lateLabel = lateH >= 24
              ? `Trả phòng muộn (${Math.floor(lateH / 24)}d ${lateH % 24}h)`
              : `Trả phòng muộn (${lateH}h${lateM > 0 ? lateM + 'm' : ''})`
            breakdownItems.push({
              label: `[${newRoomNum}] ${lateLabel}`,
              amount: overstayDiff,
              type:   'surcharge',
              meta:   { roomNumber: newRoomNum, lateCheckout: true },
            })
          }

          // ⭐ FIX 19/05/2026 v21: Bỏ block (2.5) cũ.
          //   Module moveRoomBreakdown v21 đã tự tính phụ thu "Trả phòng trễ"
          //   của phòng mới dựa trên policy.dayLateCheckOut khi plannedCheckOut
          //   vượt CO chuẩn cùng ngày → KHÔNG cần BE patch nữa.

          // ── (3) Phụ thu vượt sức chứa (NL/TE) — đọc từ baseline ──
          //   Baseline đã chứa các phụ thu này vì policy có dayAdultSurcharge.
          //   Lấy từ baseline (không từ overstay) để khớp với plannedCheckOut.
          if (baselineResult && Array.isArray(baselineResult.breakdown)) {
            const capacitySurcharges = baselineResult.breakdown.filter(b => {
              if (b.type !== 'surcharge') return false
              const lbl = String(b.label || '')
              // Bỏ "Nhận phòng sớm" (đã preserve ở (1)) + "Trả phòng muộn" (đã thêm ở (2))
              return !lbl.includes('Nhận phòng sớm')
                  && !lbl.includes('early_checkin')
                  && !lbl.includes('Trả phòng muộn')
                  && !lbl.includes('late_checkout')
            })
            for (const sur of capacitySurcharges) {
              breakdownItems.push({
                label: `[${newRoomNum}] ${sur.label}`,
                amount: sur.amount,
                type:   'surcharge',
                meta:   { ...(sur.meta || {}), roomNumber: newRoomNum },
              })
            }
          }
        } catch (surErr) {
          console.warn('[calculateBill v20.1] surcharge calc failed:', surErr.message)
        }

        priceResult = {
          // ⭐ roomAmount = chỉ tiền phòng + phụ thu (không tính fee chuyển phòng vì transferFee tách riêng)
          roomAmount:       breakdownItems
            .filter(b => !(b.meta && b.meta.transferFee))
            .reduce((s, b) => s + (b.amount || 0), 0),
          nights:           booking.nights,
          breakdown:        breakdownItems,
          finalPriceType:   booking.priceType,
          converted:        false,
          notice:           null,
        }
      } catch (e) {
        console.error('[calculateBill v20] move-room compute error:', e.message)
        // Fallback: đọc trực tiếp breakdown đã lưu
        priceResult = {
          roomAmount:       booking.roomAmount,
          nights:           booking.nights,
          breakdown:        booking.priceBreakdown ?? [],
          finalPriceType:   booking.priceType,
          converted:        false,
          notice:           null,
        }
      }
      }  // ⭐ end of else { (multi-transfer fallback)
    } else {
      // ⭐ FIX 24/05/2026: Xem TRƯỚC khi đổi phòng (transfer tương lai đã bị lọc) →
      //   phòng thực đang ở tại mốc xem là phòng GỐC, không phải phòng hiện tại của booking.
      //   Dùng policy của phòng gốc đó để tính đúng (không tính nhầm giá phòng mới).
      let _plainPolicy = policy
      let _plainMaxAdults = maxAdults, _plainMaxChildren = maxChildren, _plainMaxOccupancy = maxOccupancy
      if (_firstFutureTransfer && _firstFutureTransfer.fromRoomNumber) {
        try {
          if (_firstFutureTransfer.oldPolicyId) {
            const op = await PricePolicy.findById(_firstFutureTransfer.oldPolicyId)
            if (op) _plainPolicy = op
          }
          const origRoomDoc = await Room.findOne({
            number: _firstFutureTransfer.fromRoomNumber, branchId: booking.branchId,
          }).populate('typeId')
          if (origRoomDoc?.typeId) {
            _plainMaxAdults    = origRoomDoc.typeId.maxAdults   ?? origRoomDoc.typeId.capacity ?? _plainMaxAdults
            _plainMaxChildren  = origRoomDoc.typeId.maxChildren ?? _plainMaxChildren
            _plainMaxOccupancy = origRoomDoc.typeId.maxOccupancy ?? (_plainMaxAdults + _plainMaxChildren)
          }
        } catch (_) {}
      }
      priceResult = calculatePrice({
        checkIn:   effectiveCheckIn,
        checkOut:  effectiveCheckOut,
        priceType: booking.priceType,
        policy: _plainPolicy, branch,
        adults:    booking.adults,
        children:  booking.children,
        maxAdults: _plainMaxAdults, maxChildren: _plainMaxChildren, maxOccupancy: _plainMaxOccupancy,
      })
    }

    if (priceResult.error) {
      console.warn('[calculateBill] priceResult.error:', priceResult.error.message)
    }

    // ⭐ FIX v20.0: Đồng bộ label breakdown giữa mode 'now' và 'checkout'
    //   - Mode 'checkout' đọc từ booking.priceBreakdown (có thể có/không prefix)
    //   - Mode 'now' gọi calculatePrice → label trần "Giá ngày (...)"
    //   → Thêm prefix [roomNumber] vào label của mode 'now' để hiển thị nhất quán.
    //   KHÔNG thêm roomType (chỉ là tên loại phòng) để label gọn hơn.
    if (priceResult.breakdown && Array.isArray(priceResult.breakdown)) {
      const roomNumPrefix = booking_view.roomNumber || booking.roomNumber || ''
      priceResult.breakdown = priceResult.breakdown.map(b => {
        const lbl = String(b.label || '')
        // Đã có prefix [...] rồi → giữ nguyên
        if (lbl.startsWith('[')) return b
        // Là dòng giá phòng (Giá ngày / Giá đêm / Giá nghỉ giờ) → thêm prefix [roomNumber]
        const isPriceLine = /^Giá\s+(ngày|đêm|nghỉ giờ|giờ|tuần|tháng)/i.test(lbl)
        if (!isPriceLine || !roomNumPrefix) return b
        return { ...b, label: `[${roomNumPrefix}] ${lbl}` }
      })
    }

    const servicesAmount = booking.servicesAmount ?? 0
    const discount       = booking.discount ?? 0

    let recalcDiscount = discount
    if (booking.discountPercent > 0 || booking.discountAmount > 0 || booking.isFreeRoom) {
      const roomPart = booking.isFreeRoom ? 0 : priceResult.roomAmount
      const subtotal = roomPart + servicesAmount
      const pctDiscount = Math.round(subtotal * (booking.discountPercent ?? 0) / 100)
      recalcDiscount = pctDiscount + (booking.discountAmount ?? 0)
    }

    const roomPart    = booking.isFreeRoom ? 0 : priceResult.roomAmount
    // ⭐ FIX 19/05/2026 v2: Fallback transferFee từ transferHistory khi booking.transferFee
    //   chưa được sync (booking cũ tạo trước khi có logic cộng dồn vào field này).
    //   Sum tất cả fee trong transferHistory, dùng booking.transferFee nếu nó lớn hơn
    //   (trường hợp đã sync đúng) hoặc giá trị transferHistory (nếu booking.transferFee=0).
    const historyFee = Array.isArray(booking.transferHistory)
      ? booking.transferHistory.reduce((s, t) => s + (Number(t?.fee) || 0), 0)
      : 0
    const transferFee = Math.max(booking.transferFee ?? 0, historyFee)
    const totalAmount = Math.max(0, roomPart + servicesAmount - recalcDiscount + transferFee)

    const invoice = await Invoice.findOne({ bookingId: booking._id })
    const paidAmount      = invoice?.paidAmount ?? 0
    const remainingAmount = Math.max(0, totalAmount - paidAmount)

    // ⭐ FIX 18/05/2026: Strip roomType prefix khỏi label cũ (legacy data)
    //   Label cũ có format: "[604] 1🛏 Deluxe Garden View Room - Giá ngày (...)"
    //   → strip thành: "[604] Giá ngày (...)"
    //   Pattern: [XXX] <bất cứ gì> - Giá <type> (...)  →  [XXX] Giá <type> (...)
    const cleanedBreakdown = (priceResult.breakdown || []).map(b => {
      const lbl = String(b.label || '')
      const stripped = lbl.replace(
        /^(\[[^\]]+\])\s+.+?\s+-\s+(Giá\s+(ngày|đêm|nghỉ giờ|giờ|tuần|tháng))/i,
        '$1 $2'
      )
      return stripped === lbl ? b : { ...b, label: stripped }
    })

    res.json({
      success: true,
      data: {
        mode,
        effectiveCheckOut,
        viewedAt:         viewedAtForDisplay,  // ⭐ giờ thực để hiển thị "Tính đến" (mode now)
        nights:           priceResult.nights,
        roomAmount:       priceResult.roomAmount,
        servicesAmount,
        discount:         recalcDiscount,
        transferFee,
        totalAmount,
        paidAmount,
        remainingAmount,
        breakdown:        cleanedBreakdown,
        usedStoredBreakdown: hasTransferred && mode === 'checkout',
        finalPriceType:   priceResult.finalPriceType,
        converted:        priceResult.converted,
        notice:           priceResult.notice,
      },
    })
  } catch (err) {
    console.error('[calculateBill] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

const allocatePaymentToRooms = (booking, amount, targetRoomId = null) => {
  if (!Array.isArray(booking.rooms) || booking.rooms.length === 0) {
    return { allocations: [], remaining: amount }
  }

  const subRemaining = (sr) => {
    const total = (sr.roomAmount ?? 0) + (sr.servicesAmount ?? 0) - (sr.discountAmount ?? 0)
    return Math.max(0, total - (sr.paidAmount ?? 0))
  }

  const ordered = []
  if (targetRoomId) {
    const targetIdx = booking.rooms.findIndex(sr =>
      String(sr.roomId?._id ?? sr.roomId) === String(targetRoomId)
    )
    if (targetIdx >= 0) ordered.push(targetIdx)
  }
  for (let i = 0; i < booking.rooms.length; i++) {
    if (!ordered.includes(i)) ordered.push(i)
  }

  let remaining = amount
  const allocations = []

  for (const idx of ordered) {
    if (remaining <= 0) break
    const sr = booking.rooms[idx]
    if (sr.status === 'cancelled') continue

    const need = subRemaining(sr)
    if (need <= 0) continue

    const allocate = Math.min(need, remaining)
    sr.paidAmount = (sr.paidAmount ?? 0) + allocate
    remaining -= allocate

    allocations.push({
      roomId:     String(sr.roomId?._id ?? sr.roomId),
      roomNumber: sr.roomNumber,
      amount:     allocate,
    })
  }

  return { allocations, remaining }
}
const getAvailableByType = async (req, res, next) => {
  try {
    const { branchId, checkIn, checkOut } = req.query
    if (!branchId || !checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Thiếu branchId/checkIn/checkOut' })

    const ci = new Date(checkIn)
    const co = new Date(checkOut)

    const allRooms = await Room.find({
      branchId,
      roomStatus: { $ne: 'maintenance' },
    }).populate('typeId')

    // ⭐ FIX: Dùng helper findOverlapForNewBooking với actionType='reserve'
    //    để cho phép xem available phòng để ĐẶT trước (kể cả khi A chưa trả)
    const bookedRoomIds = new Set()
    for (const room of allRooms) {
      const conflictResult = await findOverlapForNewBooking({
        roomId:        room._id,
        intervalStart: ci,
        intervalEnd:   co,
        actionType:    'reserve',
      })
      if (conflictResult) {
        bookedRoomIds.add(String(room._id))
      }
    }

    const typeMap = new Map()
    allRooms.forEach(room => {
      const typeId   = String(room.typeId?._id ?? '')
      const typeName = room.typeId?.name ?? room.typeName ?? '—'
      const maxAdults   = room.typeId?.maxAdults   ?? room.typeId?.capacity ?? 2
      const maxChildren = room.typeId?.maxChildren ?? 0
      const maxOccupancy = room?.typeId?.maxOccupancy ?? (maxAdults + maxChildren)
      const isAvailable = !bookedRoomIds.has(String(room._id))

      if (!typeMap.has(typeId)) {
        typeMap.set(typeId, {
          typeId, typeName, maxAdults, maxChildren,
          totalRooms:     0,
          availableRooms: 0,
          rooms: [],
        })
      }
      const entry = typeMap.get(typeId)
      entry.totalRooms++
      if (isAvailable) entry.availableRooms++
      entry.rooms.push({
        id:        room._id,
        number:    room.number,
        typeName,
        typeId,
        maxAdults, maxChildren,
        available: isAvailable,
      })
    })

    res.json({
      success: true,
      data: { types: Array.from(typeMap.values()) },
    })
  } catch (err) {
    console.error('[getAvailableByType] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

// ⭐ HELPER: Tính giá cho cả nhóm phòng
async function calculateGroupPrice({ branchId, checkIn, checkOut, rooms: roomsInput }) {
  const checkInDate  = new Date(checkIn)
  const checkOutDate = new Date(checkOut)

  const branch = await Branch.findById(branchId)
  if (!branch) throw new Error('Không tìm thấy chi nhánh')

  const lines       = []
  let totalAmount   = 0

  for (const r of roomsInput) {
    const room = await Room.findById(r.roomId).populate('typeId')
    if (!room) throw new Error(`Không tìm thấy phòng ${r.roomId}`)

    const policy = r.policyId ? await PricePolicy.findById(r.policyId) : null

    const priceResult = calculatePrice({
      checkIn:   checkInDate,
      checkOut:  checkOutDate,
      priceType: r.priceType ?? 'day',
      policy, branch,
      adults:    r.adults ?? 2,
      children:  r.children ?? 0,
      maxAdults:   room.typeId?.maxAdults   ?? room.typeId?.capacity ?? 2,
      maxChildren: room.typeId?.maxChildren ?? 0,
    })

    if (priceResult.error) {
      const err = new Error(`Phòng ${room.number}: ${priceResult.error.message}`)
      err.code       = priceResult.error.code
      err.statusCode = 400
      err.data = {
        roomId:          r.roomId,
        roomNumber:      room.number,
        finalPriceType:  priceResult.error.finalPriceType,
        availableTypes:  priceResult.error.availableTypes,
        availableLabels: priceResult.error.availableLabels,
        policyName:      policy?.name ?? '',
      }
      throw err
    }

    lines.push({
      roomId:           room._id,
      roomNumber:       room.number,
      typeId:           room.typeId?._id ?? null,
      typeName:         room.typeName ?? room.typeId?.name ?? '',
      maxAdults:   room.typeId?.maxAdults   ?? room.typeId?.capacity ?? 2,
      maxChildren: room.typeId?.maxChildren ?? 0,
      adults:           r.adults ?? 2,
      children:         r.children ?? 0,
      policyId:         policy?._id ?? null,
      policyName:       policy?.name ?? '',
      requestedPriceType: r.priceType ?? 'day',
      finalPriceType:   priceResult.finalPriceType ?? r.priceType ?? 'day',
      converted:        priceResult.converted ?? false,
      notice:           priceResult.notice ?? '',
      roomAmount:       priceResult.roomAmount,
      breakdown:        priceResult.breakdown,
      nights:           priceResult.nights ?? 0,
    })

    totalAmount += priceResult.roomAmount
  }

  const byType = new Map()
  for (const line of lines) {
    const key = String(line.typeId ?? '_unknown')
    if (!byType.has(key)) {
      byType.set(key, {
        typeId:      line.typeId,
        typeName:    line.typeName,
        capacity:    line.capacity,
        maxAdults:   line.maxAdults,
        maxChildren: line.maxChildren,
        rooms:       [],
        subTotal:    0,
      })
    }
    const entry = byType.get(key)
    entry.rooms.push(line)
    entry.subTotal += line.roomAmount
  }

  return {
    totalAmount,
    nights:   lines[0]?.nights ?? 0,
    lines,
    typeGroups: Array.from(byType.values()),
  }
}

const previewGroup = async (req, res) => {
  try {
    const { branchId, checkIn, checkOut, rooms: roomsInput = [] } = req.body

    if (!branchId || !checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Thiếu branchId/checkIn/checkOut' })
    if (!Array.isArray(roomsInput) || roomsInput.length === 0)
      return res.json({ success: true, data: { totalAmount: 0, lines: [], typeGroups: [], nights: 0 } })

    const result = await calculateGroupPrice({ branchId, checkIn, checkOut, rooms: roomsInput })

    res.json({ success: true, data: result })
  } catch (err) {
    if (err.statusCode === 400) {
      return res.status(400).json({
        success: false,
        code:    err.code,
        message: err.message,
        data:    err.data,
      })
    }
    console.error('[previewGroup] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

const createGroup = async (req, res, next) => {
  try {
    const {
      customerName, customerPhone = '', customerId = null,
      groupName = '',
      checkIn, checkOut, branchId,
      source = 'Trực tiếp',
      status: initialStatus = 'reserved',
      rooms: roomsInput = [],
    } = req.body

    if (!customerName) return res.status(400).json({ success: false, message: 'Thiếu tên khách' })
    if (!checkIn || !checkOut) return res.status(400).json({ success: false, message: 'Thiếu checkIn/checkOut' })
    if (!Array.isArray(roomsInput) || roomsInput.length === 0)
      return res.status(400).json({ success: false, message: 'Cần chọn ít nhất 1 phòng' })

    const checkInDate  = new Date(checkIn)
    const checkOutDate = new Date(checkOut)
    if (checkOutDate <= checkInDate)
      return res.status(400).json({ success: false, message: 'Ngày check-out phải sau check-in' })

    const branch = await Branch.findById(branchId)
    if (!branch) return res.status(404).json({ success: false, message: 'Không tìm thấy chi nhánh' })

    const willCheckInNowGrp = initialStatus === 'checked_in'
    const nowForGrp = new Date()

    // ⭐ FIX 07/05/2026: Chặn đặt đoàn / nhận đoàn ở quá khứ (giống create())
    {
      const nowMs = nowForGrp.getTime()
      const tolerance = 60 * 1000

      if (!willCheckInNowGrp) {
        if (checkInDate.getTime() < nowMs - tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PAST_CHECKIN',
            message: `Không thể đặt đoàn với giờ nhận phòng (${checkInDate.toLocaleString('vi-VN')}) đã qua. Vui lòng chọn giờ nhận phòng từ ${nowForGrp.toLocaleString('vi-VN')} trở đi.`,
            data: { now: nowForGrp, requestedCheckIn: checkInDate },
          })
        }
        if (checkOutDate.getTime() < nowMs - tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PAST_CHECKOUT',
            message: `Không thể đặt đoàn với giờ trả phòng (${checkOutDate.toLocaleString('vi-VN')}) đã qua.`,
            data: { now: nowForGrp, requestedCheckOut: checkOutDate },
          })
        }
      } else {
        if (checkOutDate.getTime() < nowMs - tolerance) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PAST_CHECKOUT',
            message: `Không thể nhận đoàn với giờ trả phòng dự kiến (${checkOutDate.toLocaleString('vi-VN')}) đã qua so với hiện tại (${nowForGrp.toLocaleString('vi-VN')}).`,
            data: { now: nowForGrp, requestedCheckOut: checkOutDate },
          })
        }
      }
    }

    const grpIntervalStart = willCheckInNowGrp && nowForGrp < checkInDate
      ? nowForGrp
      : checkInDate

    for (const r of roomsInput) {
      const conflictResult = await findOverlapForNewBooking({
        roomId:        r.roomId,
        intervalStart: grpIntervalStart,
        intervalEnd:   checkOutDate,
        actionType:    willCheckInNowGrp ? 'checkin' : 'reserve',
      })
      if (conflictResult) {
        const room = await Room.findById(r.roomId)
        const { conflict, conflictStart, conflictEnd, conflictStatus, isStillCheckedIn } = conflictResult
        const statusLabel = {
          reserved:   'đã đặt',
          confirmed:  'đã xác nhận',
          checked_in: isStillCheckedIn ? 'đang ở (chưa trả phòng)' : 'đang ở',
        }[conflictStatus] ?? conflictStatus
        const actionLabel = willCheckInNowGrp ? 'nhận phòng ngay' : 'đặt phòng'
        return res.status(400).json({
          success: false,
          code: 'CONFLICT_OVERLAP',
          message: isStillCheckedIn
            ? `Không thể ${actionLabel} — phòng ${room?.number ?? r.roomId} đang có khách ${conflict.customerName} chưa trả phòng (dự kiến trả ${new Date(conflictEnd).toLocaleString('vi-VN')}). Vui lòng xử lý trả phòng cho khách hiện tại trước.`
            : `Không thể ${actionLabel} — phòng ${room?.number ?? r.roomId} đang có khách (${conflict.customerName} — ${statusLabel}) từ ${new Date(conflictStart).toLocaleString('vi-VN')} đến ${new Date(conflictEnd).toLocaleString('vi-VN')}.`,
          data: {
            roomNumber:           room?.number ?? null,
            conflictBookingId:    conflict._id,
            conflictCustomerName: conflict.customerName,
            conflictCheckIn:      conflictStart,
            conflictCheckOut:     conflictEnd,
            conflictStatus,
            isStillCheckedIn,
            attemptedCheckInAt:   willCheckInNowGrp ? nowForGrp : null,
          },
        })
      }
    }

    const isGroupBooking = roomsInput.length > 1

    let priceResult
    try {
      priceResult = await calculateGroupPrice({
        branchId, checkIn: checkInDate, checkOut: checkOutDate, rooms: roomsInput,
      })
    } catch (err) {
      if (err.statusCode === 400) {
        return res.status(400).json({
          success: false,
          code:    err.code,
          message: err.message,
          data:    err.data,
        })
      }
      throw err
    }

    const totalRoomAmount = priceResult.totalAmount

    const subRooms = []
    let firstRoomData = null

    for (let i = 0; i < priceResult.lines.length; i++) {
      const line = priceResult.lines[i]
      const r    = roomsInput[i]
      const room = await Room.findById(r.roomId).populate('typeId')
      const policy = line.policyId ? await PricePolicy.findById(line.policyId) : null

      const breakdown = Array.isArray(line.breakdown) ? line.breakdown : []

      const subRoom = {
        roomId:         line.roomId,
        roomNumber:     line.roomNumber,
        roomType:       line.typeName,
        typeId:         line.typeId,
        priceType:      line.finalPriceType,
        adults:         line.adults,
        children:       line.children,
        policyId:       line.policyId,
        policyName:     line.policyName,
        roomAmount:     line.roomAmount,
        priceBreakdown: breakdown.map(b => ({
          label:  String(b.label ?? ''),
          amount: Number(b.amount ?? 0),
          type:   b.type === 'surcharge' ? 'surcharge' : 'base',
          meta:   { ...(b.meta || {}), roomNumber: line.roomNumber },
        })),
        status:         initialStatus === 'checked_in' ? 'checked_in' : 'reserved',
        actualCheckIn:  initialStatus === 'checked_in' ? new Date() : null,
      }
      subRooms.push(subRoom)
      if (i === 0) firstRoomData = { ...subRoom, room, policy }
    }

    const nightsCalc = Math.max(1, Math.ceil((checkOutDate - checkInDate) / 86400000))

    let finalCustomerId = customerId
    if (!finalCustomerId) {
      let customer
      try {
        if (customerPhone && customerPhone !== '0000000000') {
          customer = await Customer.findOne({ phone: customerPhone })
          if (!customer) customer = await Customer.create({ name: customerName, phone: customerPhone })
        } else {
          customer = await Customer.create({ name: customerName })
        }
        finalCustomerId = customer._id
      } catch (e) {
        console.error('[createGroup] create customer failed:', e.message)
        return res.status(500).json({
          success: false,
          message: 'Không thể tạo khách hàng: ' + e.message,
        })
      }
    }

    const booking = await Booking.create({
      customerId:      finalCustomerId,
      customerName,
      customerPhone:   customerPhone || '0000000000',
      roomId:          firstRoomData.roomId,
      roomNumber:      firstRoomData.roomNumber,
      roomType:        firstRoomData.roomType,
      branchId,
      checkIn:         checkInDate,
      checkOut:        checkOutDate,
      nights:          nightsCalc,
      priceType:       firstRoomData.priceType,
      adults:          firstRoomData.adults,
      children:        firstRoomData.children,
      roomAmount:      totalRoomAmount,
      totalAmount:     totalRoomAmount,
      servicesAmount:  0,
      discount:        0,
      discountPercent: 0,
      discountAmount:  0,
      isFreeRoom:      false,
      priceBreakdown:  firstRoomData.priceBreakdown,
      policyId:        firstRoomData.policyId,
      policyName:      firstRoomData.policyName,
      policySnapshot:  firstRoomData.policy
        ? buildPolicySnapshot(firstRoomData.policy, firstRoomData.room.typeId?.capacity ?? null)
        : null,
      status:          initialStatus,
      actualCheckIn:   initialStatus === 'checked_in' ? new Date() : null,
      source,
      isGroup:         isGroupBooking,
      groupName,
      rooms:           isGroupBooking ? subRooms : [],
    })

    for (const sr of subRooms) {
      await Room.findByIdAndUpdate(sr.roomId, {
        currentBookingId: booking._id,
        currentGuestName: customerName,
      })
    }

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: isGroupBooking ? 'create_group' : (initialStatus === 'checked_in' ? 'create_and_checkin' : 'create'),
      description: isGroupBooking
        ? `Tạo đoàn "${groupName || customerName}" — ${subRooms.length} phòng (${subRooms.map(r => r.roomNumber).join(', ')})`
        : `Tạo đặt phòng ${firstRoomData.roomNumber} cho ${customerName}`,
      user: req.user, branchId,
      metadata: {
        isGroup: isGroupBooking, groupName,
        roomCount: subRooms.length,
        roomNumbers: subRooms.map(r => r.roomNumber),
        totalAmount: totalRoomAmount,
      },
    })

    res.status(201).json({
      success: true,
      message: isGroupBooking ? 'Tạo đặt đoàn thành công' : 'Tạo đặt phòng thành công',
      data: { booking },
    })
  } catch (err) {
    console.error('[createGroup] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ⭐ FEATURE 11/05/2026: GỘP ĐOÀN / TÁCH ĐOÀN
// ════════════════════════════════════════════════════════════════════════════

// ⭐ POST /bookings/:id/merge-group
//   body: { targetBookingIds: [id1, id2, ...], groupName?: '' }
//
//   Gộp các booking đơn (hoặc đoàn) vào booking `:id` thành 1 đoàn duy nhất.
//   - `:id` là booking gốc (sẽ thành đoàn chính)
//   - `targetBookingIds` là các booking sẽ được gộp vào (sẽ bị cancel với reason)
//   - Cho phép gộp cross-customer (khách khác nhau cũng OK)
//   - Validate: cùng branchId, không có booking checked_out/cancelled,
//     không trùng room
const mergeGroup = async (req, res, next) => {
  try {
    const { targetBookingIds = [], groupName = '' } = req.body

    if (!Array.isArray(targetBookingIds) || targetBookingIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Cần chọn ít nhất 1 booking để gộp vào đoàn',
      })
    }

    const mainBooking = await Booking.findById(req.params.id)
    if (!mainBooking) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy booking gốc' })
    }
    if (['cancelled', 'checked_out'].includes(mainBooking.status)) {
      return res.status(400).json({
        success: false,
        message: `Không thể gộp đoàn — booking gốc đang ở trạng thái: ${mainBooking.status}`,
      })
    }

    // Load tất cả target bookings
    const targets = await Booking.find({ _id: { $in: targetBookingIds } })
    if (targets.length !== targetBookingIds.length) {
      return res.status(400).json({
        success: false,
        message: `Không tìm thấy đủ ${targetBookingIds.length} booking — chỉ tìm được ${targets.length}`,
      })
    }

    // Validate từng target
    for (const t of targets) {
      if (String(t._id) === String(mainBooking._id)) {
        return res.status(400).json({
          success: false,
          message: 'Không thể gộp booking với chính nó',
        })
      }
      if (['cancelled', 'checked_out'].includes(t.status)) {
        return res.status(400).json({
          success: false,
          message: `Booking ${t._id} (${t.customerName}) đang ở trạng thái ${t.status}, không thể gộp`,
        })
      }
      if (String(t.branchId) !== String(mainBooking.branchId)) {
        return res.status(400).json({
          success: false,
          message: `Booking ${t.customerName} thuộc chi nhánh khác — không thể gộp`,
        })
      }
    }

    // Build danh sách roomIds hiện có của mainBooking
    // ⭐ FIX 11/05/2026: CHỈ tính phòng đang active (không phải cancelled/checked_out)
    //   Phòng cancelled/checked_out vẫn còn record trong rooms[] nhưng không còn
    //   chiếm chỗ → cho phép gộp booking khác có phòng đó.
    const existingRoomIds = new Set()
    const isSingleActive = !Array.isArray(mainBooking.rooms) || mainBooking.rooms.length === 0
    if (isSingleActive && mainBooking.roomId
        && !['cancelled', 'checked_out'].includes(mainBooking.status)) {
      existingRoomIds.add(String(mainBooking.roomId))
    }
    if (Array.isArray(mainBooking.rooms)) {
      for (const sr of mainBooking.rooms) {
        if (!sr.roomId) continue
        if (['cancelled', 'checked_out'].includes(sr.status)) continue  // ⭐ skip
        existingRoomIds.add(String(sr.roomId?._id ?? sr.roomId))
      }
    }

    // Check trùng room với targets
    for (const t of targets) {
      const tRoomIds = []
      // ⭐ FIX 11/05/2026: Cũng skip phòng cancelled/checked_out của target
      const tIsSingle = !Array.isArray(t.rooms) || t.rooms.length === 0
      if (tIsSingle && t.roomId
          && !['cancelled', 'checked_out'].includes(t.status)) {
        tRoomIds.push(String(t.roomId))
      }
      if (Array.isArray(t.rooms)) {
        for (const sr of t.rooms) {
          if (!sr.roomId) continue
          if (['cancelled', 'checked_out'].includes(sr.status)) continue  // ⭐ skip
          tRoomIds.push(String(sr.roomId?._id ?? sr.roomId))
        }
      }
      for (const rid of tRoomIds) {
        if (existingRoomIds.has(rid)) {
          // Lookup room number để báo lỗi rõ hơn
          let roomNumber = rid
          if (Array.isArray(t.rooms)) {
            const sr = t.rooms.find(r => String(r.roomId?._id ?? r.roomId) === rid)
            if (sr?.roomNumber) roomNumber = sr.roomNumber
          } else if (t.roomNumber && String(t.roomId) === rid) {
            roomNumber = t.roomNumber
          }
          return res.status(400).json({
            success: false,
            code: 'DUPLICATE_ROOM_IN_MERGE',
            message: `Phòng ${roomNumber} có trong cả booking gốc và booking ${t.customerName} — không thể gộp. Hãy chọn booking khác.`,
            data: {
              roomNumber,
              targetBookingId: t._id,
              targetCustomerName: t.customerName,
            },
          })
        }
        existingRoomIds.add(rid)
      }
    }

    // Convert mainBooking → group (nếu chưa)
    if (!Array.isArray(mainBooking.rooms) || mainBooking.rooms.length === 0) {
      // Promote single → group: tạo sub-room đầu từ data hiện tại
      mainBooking.rooms = [{
        roomId:         mainBooking.roomId,
        roomNumber:     mainBooking.roomNumber,
        roomType:       mainBooking.roomType,
        checkIn:        mainBooking.checkIn,
        checkOut:       mainBooking.checkOut,
        nights:         mainBooking.nights,
        priceType:      mainBooking.priceType,
        adults:         mainBooking.adults,
        children:       mainBooking.children,
        policyId:       mainBooking.policyId,
        policyName:     mainBooking.policyName,
        roomAmount:     mainBooking.roomAmount ?? 0,
        servicesAmount: mainBooking.servicesAmount ?? 0,
        discountAmount: 0,
        paidAmount:     0,
        priceBreakdown: (mainBooking.priceBreakdown ?? []).map(b => {
          const item = (b && typeof b.toObject === 'function') ? b.toObject() : b
          const lbl = String(item.label ?? '')
          const hasPrefix = /^\[[^\]]+\]\s/.test(lbl)
          return {
            label:  hasPrefix ? lbl : `[${mainBooking.roomNumber}] ${lbl}`,
            amount: Number(item.amount ?? 0),
            type:   item.type === 'surcharge' ? 'surcharge' : 'base',
            meta:   { ...(item.meta || {}), roomNumber: mainBooking.roomNumber },
          }
        }),
        status:         mainBooking.status,
        actualCheckIn:  mainBooking.actualCheckIn,
        actualCheckOut: mainBooking.actualCheckOut,
      }]
      mainBooking.isGroup = true
    }

    // Push từng phòng của targets vào mainBooking.rooms[]
    const mergedRoomInfos = []  // để log
    for (const t of targets) {
      const tSubRooms = (Array.isArray(t.rooms) && t.rooms.length > 0)
        ? t.rooms
        : [{
            roomId:         t.roomId,
            roomNumber:     t.roomNumber,
            roomType:       t.roomType,
            checkIn:        t.checkIn,
            checkOut:       t.checkOut,
            nights:         t.nights,
            priceType:      t.priceType,
            adults:         t.adults,
            children:       t.children,
            policyId:       t.policyId,
            policyName:     t.policyName,
            roomAmount:     t.roomAmount ?? 0,
            servicesAmount: t.servicesAmount ?? 0,
            discountAmount: 0,
            paidAmount:     0,
            priceBreakdown: (t.priceBreakdown ?? []).map(b => {
              const item = (b && typeof b.toObject === 'function') ? b.toObject() : b
              const lbl = String(item.label ?? '')
              const hasPrefix = /^\[[^\]]+\]\s/.test(lbl)
              return {
                label:  hasPrefix ? lbl : `[${t.roomNumber}] ${lbl}`,
                amount: Number(item.amount ?? 0),
                type:   item.type === 'surcharge' ? 'surcharge' : 'base',
                meta:   { ...(item.meta || {}), roomNumber: t.roomNumber },
              }
            }),
            status:         t.status,
            actualCheckIn:  t.actualCheckIn,
            actualCheckOut: t.actualCheckOut,
          }]

      for (const sr of tSubRooms) {
        if (['cancelled', 'checked_out'].includes(sr.status)) continue
        const srObj = (sr && typeof sr.toObject === 'function') ? sr.toObject() : sr
        // Reset paid/discount của target — sẽ track ở mainBooking level
        srObj.paidAmount     = srObj.paidAmount     ?? 0
        srObj.discountAmount = srObj.discountAmount ?? 0
        mainBooking.rooms.push(srObj)
        mergedRoomInfos.push({
          bookingId:   String(t._id),
          customerName: t.customerName,
          roomNumber:  srObj.roomNumber,
        })
      }
    }

    // Recalc tổng
    const totalRoomAmount    = mainBooking.rooms.reduce((s, r) => {
      if (['cancelled'].includes(r.status)) return s
      return s + (r.roomAmount ?? 0)
    }, 0)
    const totalServicesAmount = mainBooking.rooms.reduce((s, r) => s + (r.servicesAmount ?? 0), 0)
                              + (mainBooking.servicesAmount ?? 0)

    mainBooking.roomAmount     = totalRoomAmount
    mainBooking.servicesAmount = totalServicesAmount

    const subtotal = totalRoomAmount + totalServicesAmount
    const pctDisc  = Math.round(subtotal * (mainBooking.discountPercent ?? 0) / 100)
    mainBooking.discount    = pctDisc + (mainBooking.discountAmount ?? 0)
    mainBooking.totalAmount = Math.max(0, subtotal - mainBooking.discount + (mainBooking.transferFee ?? 0))

    // Update checkIn/checkOut bao trùm
    const allCheckIns  = mainBooking.rooms.map(sr => sr.checkIn  ?? mainBooking.checkIn)
    const allCheckOuts = mainBooking.rooms.map(sr => sr.checkOut ?? mainBooking.checkOut)
    mainBooking.checkIn  = new Date(Math.min(...allCheckIns.map(d => new Date(d).getTime())))
    mainBooking.checkOut = new Date(Math.max(...allCheckOuts.map(d => new Date(d).getTime())))

    // Set groupName nếu được truyền
    if (groupName) mainBooking.groupName = groupName
    mainBooking.isGroup = true

    // Recalc status booking: nếu có phòng nào checked_in → đoàn checked_in
    const anyCheckedIn = mainBooking.rooms.some(r => r.status === 'checked_in')
    const anyReserved  = mainBooking.rooms.some(r => r.status === 'reserved' || r.status === 'confirmed')
    if (anyCheckedIn) {
      mainBooking.status = 'checked_in'
    } else if (anyReserved) {
      mainBooking.status = mainBooking.status === 'confirmed' ? 'confirmed' : 'reserved'
    }

    mainBooking.markModified('rooms')
    await mainBooking.save()

    // Cancel các target booking với reason
    for (const t of targets) {
      t.status       = 'cancelled'
      t.cancelReason = `Gộp vào đoàn ${mainBooking.customerName}${mainBooking.groupName ? ` (${mainBooking.groupName})` : ''} — booking #${mainBooking._id}`
      t.cancelledAt  = new Date()
      t.cancelledBy  = req.user?.id ?? req.user?._id ?? null
      await t.save()
    }

    // Update Room.currentBookingId của các phòng đã merge sang mainBooking
    const allMergedRoomIds = []
    for (const t of targets) {
      if (t.roomId) allMergedRoomIds.push(t.roomId)
      if (Array.isArray(t.rooms)) {
        for (const sr of t.rooms) {
          if (sr.roomId && !['cancelled', 'checked_out'].includes(sr.status)) {
            allMergedRoomIds.push(sr.roomId?._id ?? sr.roomId)
          }
        }
      }
    }
    if (allMergedRoomIds.length > 0) {
      await Room.updateMany(
        { _id: { $in: allMergedRoomIds } },
        {
          currentBookingId: mainBooking._id,
          currentGuestName: mainBooking.customerName,
        }
      )
    }

    // Sync invoice nếu có
    try {
      const invoice = await Invoice.findOne({ bookingId: mainBooking._id })
      if (invoice) {
        invoice.roomAmount      = mainBooking.roomAmount
        invoice.servicesAmount  = mainBooking.servicesAmount ?? 0
        invoice.discount        = mainBooking.discount ?? 0
        invoice.totalAmount     = mainBooking.totalAmount
        invoice.remainingAmount = Math.max(0, mainBooking.totalAmount - (invoice.paidAmount ?? 0))
        invoice.items           = buildInvoiceItemsFromBooking(mainBooking)
        await invoice.save()
      }
    } catch (e) {
      console.error('[mergeGroup] sync invoice failed (non-fatal):', e.message)
    }

    await logAction({
      entityType: 'Booking', entityId: mainBooking._id,
      action: 'merge_group',
      description: `Gộp ${targets.length} booking vào đoàn ${mainBooking.customerName}: ${mergedRoomInfos.map(r => `${r.roomNumber} (${r.customerName})`).join(', ')}`,
      user: req.user, branchId: mainBooking.branchId,
      metadata: {
        mergedCount:        targets.length,
        mergedRoomInfos,
        targetBookingIds:   targets.map(t => String(t._id)),
        newTotalAmount:     mainBooking.totalAmount,
        newRoomCount:       mainBooking.rooms.length,
        groupName:          mainBooking.groupName ?? null,
      },
    })

    res.json({
      success: true,
      message: `Đã gộp ${targets.length} booking vào đoàn (${mainBooking.rooms.length} phòng)`,
      data: { booking: mainBooking, mergedCount: targets.length },
    })
  } catch (err) {
    console.error('[mergeGroup] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

// ⭐ POST /bookings/:id/split-room
//   body: { roomId, newCustomerName?, newCustomerPhone? }
//
//   Tách 1 phòng khỏi đoàn `:id` → tạo booking single mới.
//   - Phòng cần tách: status phải là `reserved/confirmed/checked_in`
//     (không phải checked_out/cancelled)
//   - Nếu đoàn cũ chỉ còn 1 phòng sau tách → degrade thành single booking
//   - paidAmount của sub-room → chuyển sang booking mới (giữ track)
//   - Có thể tách với customer khác (newCustomerName/Phone) — nếu không truyền
//     thì dùng customer của booking gốc
const splitRoom = async (req, res, next) => {
  try {
    const { roomId, newCustomerName, newCustomerPhone, groupName = '' } = req.body

    if (!roomId) {
      return res.status(400).json({ success: false, message: 'Thiếu roomId cần tách' })
    }

    const booking = await Booking.findById(req.params.id)
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    }
    if (!Array.isArray(booking.rooms) || booking.rooms.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Booking này không phải đoàn — không thể tách',
      })
    }
    if (booking.rooms.length === 1) {
      return res.status(400).json({
        success: false,
        message: 'Đoàn chỉ còn 1 phòng — không thể tách nữa',
      })
    }
    if (['cancelled', 'checked_out'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: `Không thể tách phòng — booking đang ở trạng thái: ${booking.status}`,
      })
    }

    const subIdx = booking.rooms.findIndex(sr =>
      String(sr.roomId?._id ?? sr.roomId) === String(roomId)
    )
    if (subIdx < 0) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy phòng trong đoàn' })
    }
    const sub = booking.rooms[subIdx]
    if (['cancelled', 'checked_out'].includes(sub.status)) {
      return res.status(400).json({
        success: false,
        message: `Không thể tách phòng đang ở trạng thái: ${sub.status}`,
      })
    }

    // Customer cho booking mới
    let newCustomerId
    let useNewName = newCustomerName?.trim()
    let useNewPhone = newCustomerPhone?.toString().trim() ?? ''
    if (useNewName) {
      // Tách sang khách khác
      let customer
      if (useNewPhone) {
        customer = await Customer.findOne({ phone: useNewPhone })
        if (!customer) customer = await Customer.create({ name: useNewName, phone: useNewPhone })
      } else {
        customer = await Customer.create({ name: useNewName })
      }
      newCustomerId = customer._id
    } else {
      // Dùng customer của booking gốc
      newCustomerId = booking.customerId
      useNewName    = booking.customerName
      useNewPhone   = booking.customerPhone
    }

    const subObj = (sub && typeof sub.toObject === 'function') ? sub.toObject() : sub

    // Tạo booking mới (single) từ sub-room
    const newBooking = await Booking.create({
      customerId:      newCustomerId,
      customerName:    useNewName,
      customerPhone:   useNewPhone || '0000000000',
      roomId:          subObj.roomId,
      roomNumber:      subObj.roomNumber,
      roomType:        subObj.roomType,
      branchId:        booking.branchId,
      checkIn:         subObj.checkIn  ?? booking.checkIn,
      checkOut:        subObj.checkOut ?? booking.checkOut,
      nights:          subObj.nights   ?? booking.nights,
      priceType:       subObj.priceType ?? booking.priceType,
      adults:          subObj.adults   ?? booking.adults,
      children:        subObj.children ?? booking.children,
      roomAmount:      subObj.roomAmount ?? 0,
      servicesAmount:  subObj.servicesAmount ?? 0,
      discount:        subObj.discountAmount ?? 0,
      discountPercent: 0,
      discountAmount:  subObj.discountAmount ?? 0,
      isFreeRoom:      false,
      totalAmount:     Math.max(0, (subObj.roomAmount ?? 0) + (subObj.servicesAmount ?? 0) - (subObj.discountAmount ?? 0)),
      priceBreakdown:  (subObj.priceBreakdown ?? []).map(b => {
        const item = (b && typeof b.toObject === 'function') ? b.toObject() : b
        const lbl = String(item.label ?? '').replace(/^\[[^\]]+\]\s*/, '')
        return {
          label:  lbl,
          amount: Number(item.amount ?? 0),
          type:   item.type === 'surcharge' ? 'surcharge' : 'base',
          meta:   { ...(item.meta || {}), roomNumber: subObj.roomNumber },
        }
      }),
      policyId:        subObj.policyId   ?? booking.policyId,
      policyName:      subObj.policyName ?? booking.policyName,
      policySnapshot:  booking.policySnapshot,  // snapshot kế thừa
      status:          subObj.status,
      actualCheckIn:   subObj.actualCheckIn  ?? null,
      actualCheckOut:  subObj.actualCheckOut ?? null,
      source:          booking.source ?? 'Trực tiếp',
      isGroup:         false,
      rooms:           [],
      // ⭐ Note: paidAmount của sub không copy thẳng — sẽ tạo invoice riêng
      //   nếu cần. Tạm thời paidAmount của newBooking = 0, sub.paidAmount sẽ
      //   chuyển vào invoice mới ở bước tiếp theo (xem block sync invoice).
    })

    // Trừ phòng đã tách khỏi đoàn cũ
    const subPaidAmount = subObj.paidAmount ?? 0
    booking.rooms.splice(subIdx, 1)
    booking.markModified('rooms')

    // Nếu sau tách đoàn cũ chỉ còn 1 phòng → degrade thành single booking
    let degradedToSingle = false
    if (booking.rooms.length === 1) {
      const remaining = booking.rooms[0]
      const remObj = (remaining && typeof remaining.toObject === 'function') ? remaining.toObject() : remaining
      booking.roomId         = remObj.roomId
      booking.roomNumber     = remObj.roomNumber
      booking.roomType       = remObj.roomType
      booking.checkIn        = remObj.checkIn  ?? booking.checkIn
      booking.checkOut       = remObj.checkOut ?? booking.checkOut
      booking.nights         = remObj.nights   ?? booking.nights
      booking.priceType      = remObj.priceType ?? booking.priceType
      booking.adults         = remObj.adults   ?? booking.adults
      booking.children       = remObj.children ?? booking.children
      booking.roomAmount     = remObj.roomAmount ?? 0
      booking.actualCheckIn  = remObj.actualCheckIn  ?? booking.actualCheckIn
      booking.actualCheckOut = remObj.actualCheckOut ?? booking.actualCheckOut
      booking.priceBreakdown = (remObj.priceBreakdown ?? []).map(b => {
        const item = (b && typeof b.toObject === 'function') ? b.toObject() : b
        const lbl = String(item.label ?? '').replace(/^\[[^\]]+\]\s*/, '')
        return {
          label:  lbl,
          amount: Number(item.amount ?? 0),
          type:   item.type === 'surcharge' ? 'surcharge' : 'base',
          meta:   { ...(item.meta || {}), roomNumber: remObj.roomNumber },
        }
      })
      booking.policyId   = remObj.policyId   ?? booking.policyId
      booking.policyName = remObj.policyName ?? booking.policyName
      booking.status     = remObj.status
      booking.isGroup    = false
      booking.rooms      = []
      degradedToSingle = true
    }

    // Recalc tổng cho booking gốc
    if (!degradedToSingle) {
      const newTotalRoom = booking.rooms.reduce((s, r) => {
        if (r.status === 'cancelled') return s
        return s + (r.roomAmount ?? 0)
      }, 0)
      booking.roomAmount = newTotalRoom
      const newSubtotal = newTotalRoom + (booking.servicesAmount ?? 0)
      const newPctDisc  = Math.round(newSubtotal * (booking.discountPercent ?? 0) / 100)
      booking.discount    = newPctDisc + (booking.discountAmount ?? 0)
      booking.totalAmount = Math.max(0, newSubtotal - booking.discount + (booking.transferFee ?? 0))

      // Update checkIn/checkOut bao trùm
      const allCheckIns  = booking.rooms.map(sr => sr.checkIn  ?? booking.checkIn)
      const allCheckOuts = booking.rooms.map(sr => sr.checkOut ?? booking.checkOut)
      if (allCheckIns.length > 0)  booking.checkIn  = new Date(Math.min(...allCheckIns.map(d => new Date(d).getTime())))
      if (allCheckOuts.length > 0) booking.checkOut = new Date(Math.max(...allCheckOuts.map(d => new Date(d).getTime())))

      // Update booking.roomId nếu đang trỏ tới phòng vừa tách
      if (String(booking.roomId) === String(roomId)) {
        const firstRemaining = booking.rooms[0]
        if (firstRemaining) {
          booking.roomId     = firstRemaining.roomId
          booking.roomNumber = firstRemaining.roomNumber
          booking.roomType   = firstRemaining.roomType
        }
      }
    } else {
      // Đã degrade — recalc totalAmount cho single
      const newSubtotal = (booking.roomAmount ?? 0) + (booking.servicesAmount ?? 0)
      const newPctDisc  = Math.round(newSubtotal * (booking.discountPercent ?? 0) / 100)
      booking.discount    = newPctDisc + (booking.discountAmount ?? 0)
      booking.totalAmount = Math.max(0, newSubtotal - booking.discount + (booking.transferFee ?? 0))
    }

    if (groupName && !degradedToSingle) booking.groupName = groupName
    await booking.save()

    // Update Room.currentBookingId của phòng vừa tách → newBooking
    await Room.findByIdAndUpdate(roomId, {
      currentBookingId: newBooking._id,
      currentGuestName: useNewName,
    })

    // Sync invoice: tạo invoice mới cho booking tách, deduct số tiền của sub
    // ra khỏi invoice gốc nếu có
    try {
      const oldInvoice = await Invoice.findOne({ bookingId: booking._id })
      if (oldInvoice) {
        // Trừ phần đã trả của sub khỏi paidAmount của invoice cũ
        const newOldPaid = Math.max(0, (oldInvoice.paidAmount ?? 0) - subPaidAmount)
        oldInvoice.paidAmount      = newOldPaid
        oldInvoice.roomAmount      = booking.roomAmount
        oldInvoice.servicesAmount  = booking.servicesAmount ?? 0
        oldInvoice.discount        = booking.discount ?? 0
        oldInvoice.totalAmount     = booking.totalAmount
        oldInvoice.remainingAmount = Math.max(0, booking.totalAmount - newOldPaid)
        oldInvoice.paymentStatus   = newOldPaid >= booking.totalAmount ? 'paid' :
                                     newOldPaid > 0 ? 'partial' : 'unpaid'
        oldInvoice.items           = buildInvoiceItemsFromBooking(booking)
        await oldInvoice.save()
      }

      // Tạo invoice mới cho newBooking nếu sub có paidAmount > 0
      if (subPaidAmount > 0) {
        await Invoice.create({
          bookingId:       newBooking._id,
          customerId:      newBooking.customerId,
          customerName:    newBooking.customerName,
          roomNumber:      newBooking.roomNumber,
          roomAmount:      newBooking.roomAmount,
          servicesAmount:  newBooking.servicesAmount ?? 0,
          discount:        newBooking.discount ?? 0,
          totalAmount:     newBooking.totalAmount,
          paidAmount:      subPaidAmount,
          remainingAmount: Math.max(0, newBooking.totalAmount - subPaidAmount),
          paymentStatus:   subPaidAmount >= newBooking.totalAmount ? 'paid' :
                           subPaidAmount > 0 ? 'partial' : 'unpaid',
          issuedBy:        req.user?.id,
          items:           buildInvoiceItemsFromBooking(newBooking),
          branchId:        newBooking.branchId,
        })
      }
    } catch (e) {
      console.error('[splitRoom] sync invoice failed (non-fatal):', e.message)
    }

    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'split_room',
      description: `Tách phòng ${subObj.roomNumber} khỏi đoàn ${booking.customerName}${useNewName !== booking.customerName ? ` → tạo booking mới cho ${useNewName}` : ''}${degradedToSingle ? ' (đoàn còn 1 phòng → trở thành booking đơn)' : ''}`,
      user: req.user, branchId: booking.branchId,
      metadata: {
        splitRoomNumber: subObj.roomNumber,
        splitRoomId:     String(roomId),
        newBookingId:    String(newBooking._id),
        newCustomerName: useNewName,
        degradedToSingle,
        subPaidTransferred: subPaidAmount,
      },
    })

    res.json({
      success: true,
      message: `Đã tách phòng ${subObj.roomNumber} thành booking riêng${degradedToSingle ? ' — đoàn cũ còn 1 phòng đã chuyển thành booking đơn' : ''}`,
      data: {
        booking,            // booking gốc (đã update)
        newBooking,         // booking mới được tạo từ phòng tách
        degradedToSingle,
      },
    })
  } catch (err) {
    console.error('[splitRoom] error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

// ⭐ GET /bookings/:id/group-merge-candidates
//   Trả về danh sách booking có thể gộp vào booking `:id`:
//   - Cùng branchId
//   - Status: reserved/confirmed/checked_in
//   - Không phải bản thân nó
//   - Không trùng room với booking hiện tại
const getMergeCandidates = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id)
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    }

    // Build set roomIds của booking hiện tại để loại
    const myRoomIds = new Set()
    if (booking.roomId) myRoomIds.add(String(booking.roomId))
    if (Array.isArray(booking.rooms)) {
      for (const sr of booking.rooms) {
        if (sr.roomId) myRoomIds.add(String(sr.roomId?._id ?? sr.roomId))
      }
    }

    const candidates = await Booking.find({
      _id:      { $ne: booking._id },
      branchId: booking.branchId,
      status:   { $in: ['reserved', 'confirmed', 'checked_in'] },
    }).sort({ checkIn: 1 }).limit(100)

    // Filter: loại bỏ booking có room trùng
    const filtered = candidates.filter(c => {
      const cRoomIds = []
      if (c.roomId) cRoomIds.push(String(c.roomId))
      if (Array.isArray(c.rooms)) {
        for (const sr of c.rooms) {
          if (sr.roomId) cRoomIds.push(String(sr.roomId?._id ?? sr.roomId))
        }
      }
      return cRoomIds.every(rid => !myRoomIds.has(rid))
    })

    res.json({
      success: true,
      data: {
        candidates: filtered.map(c => ({
          _id:           c._id,
          customerName:  c.customerName,
          customerPhone: c.customerPhone,
          roomNumber:    c.roomNumber,
          checkIn:       c.checkIn,
          checkOut:      c.checkOut,
          status:        c.status,
          isGroup:       c.isGroup,
          totalRooms:    Array.isArray(c.rooms) ? c.rooms.length : 1,
          rooms:         Array.isArray(c.rooms) ? c.rooms.map(sr => ({
            roomNumber: sr.roomNumber,
            status:     sr.status,
          })) : [],
          totalAmount:   c.totalAmount,
        })),
        total: filtered.length,
      },
    })
  } catch (err) {
    console.error('[getMergeCandidates] error:', err)
    next(err)
  }
}

// ⭐ GET /bookings/:id/can-set-past?roomId=xxx
const getCanSetPast = async (req, res, next) => {
  try {
    const { roomId = null } = req.query
    const booking = await Booking.findById(req.params.id)
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    }

    let roomNumberForAudit = null
    if (roomId && Array.isArray(booking.rooms)) {
      const sub = booking.rooms.find(r =>
        String(r.roomId?._id ?? r.roomId) === String(roomId)
      )
      if (sub) roomNumberForAudit = sub.roomNumber
    }

    const perm = await canSetPastTime(req.user, booking._id, roomNumberForAudit)
    res.json({
      success: true,
      data: {
        canSetPast: perm.canSetPast,
        reason:     perm.reason ?? null,
        userRole:   req.user?.role ?? null,
        isPrivilegedRole:  PRIVILEGED_PAST_ROLES.includes(req.user?.role),
        roomNumber: roomNumberForAudit,
        lastCheckoutAt: perm.lastCheckoutAt ?? null,
      },
    })
  } catch (err) {
    console.error('[getCanSetPast] error:', err)
    next(err)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ⭐ NEW 30/05/2026: Gửi EMAIL XÁC NHẬN ĐẶT PHÒNG cho khách.
//   POST /bookings/:id/send-confirmation
//   Body (optional): { email }  — email khách nhập tay trên FE (khi booking
//     chưa có sẵn email). Nếu có → ưu tiên dùng + lưu lại vào Booking/Customer.
//
//   Nguồn email (theo yêu cầu): ưu tiên booking.customerEmail → fallback
//     Customer.email (qua booking.customerId) → fallback email body request.
//
//   Nội dung: mã booking, phòng, ngày nhận/trả, breakdown giá + chính sách,
//     tổng tiền, hướng dẫn thanh toán (số dư còn lại).
// ════════════════════════════════════════════════════════════════════════════

const escHtml = (s) =>
  String(s ?? '').replace(/[<>&"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))

const fmtVND = (v) => (Number(v) || 0).toLocaleString('vi-VN')

const fmtDateTimeVN = (d) => {
  if (!d) return '—'
  try { return new Date(d).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) }
  catch { return '—' }
}

// Validate email cơ bản
const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim())

// Dựng HTML email xác nhận từ booking + branch + invoice.
//   bill (optional): số liệu hoá đơn FE đang hiển thị (theo tab "Đến hiện tại" /
//   "Đến khi trả phòng") — { mode, breakdown, totalAmount, paidAmount, remainingAmount }.
//   Nếu có bill → ƯU TIÊN dùng để email khớp 100% với FE. Nếu không → fallback
//   booking.priceBreakdown + invoice (số liệu lưu cứng).
function buildConfirmationHtml({ booking, branch, invoice, bill = null }) {
  const brandName = branch?.name || 'LuxHotel'

  const rows = (bill && Array.isArray(bill.breakdown))
    ? bill.breakdown
    : (Array.isArray(booking.priceBreakdown) ? booking.priceBreakdown : [])

  const breakdownRows = rows.map((b) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #EEF2F7;color:#334155;font-size:13px">${escHtml(b.label)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #EEF2F7;color:#0F172A;font-size:13px;text-align:right;white-space:nowrap">${fmtVND(b.amount)} đ</td>
    </tr>`).join('')

  const total      = bill ? Number(bill.totalAmount ?? 0)     : Number(booking.totalAmount ?? 0)
  const paid       = bill ? Number(bill.paidAmount ?? 0)      : Number(invoice?.paidAmount ?? 0)
  const remaining  = bill ? Number(bill.remainingAmount ?? Math.max(0, total - paid))
                          : Math.max(0, total - paid)

  // Khối hướng dẫn thanh toán — chỉ hiện khi còn nợ
  const paymentBlock = remaining > 0 ? `
    <div style="margin-top:18px;padding:14px 16px;background:#FFF7ED;border:1px solid #FED7AA;border-radius:8px">
      <div style="font-size:14px;font-weight:700;color:#9A3412;margin-bottom:6px">Hướng dẫn thanh toán</div>
      <div style="font-size:13px;color:#7C2D12;line-height:1.6">
        Số tiền còn lại cần thanh toán: <b>${fmtVND(remaining)} đ</b>.<br/>
        Vui lòng hoàn tất thanh toán khi nhận phòng hoặc theo hướng dẫn của lễ tân.
        ${branch?.phone || branch?.hotline ? `Mọi thắc mắc xin liên hệ: <b>${escHtml(branch.phone || branch.hotline)}</b>.` : ''}
      </div>
    </div>` : `
    <div style="margin-top:18px;padding:14px 16px;background:#ECFDF5;border:1px solid #A7F3D0;border-radius:8px">
      <div style="font-size:13px;color:#065F46;line-height:1.6">
        ✅ Đặt phòng đã được thanh toán đầy đủ. Hẹn gặp quý khách!
      </div>
    </div>`

  const policyLine = booking.policyName
    ? `<div style="font-size:12px;color:#64748B;margin-top:4px">Chính sách giá: <b>${escHtml(booking.policyName)}</b></div>`
    : ''

  // Nhãn mốc tính tiền — giúp khách hiểu số liệu tương ứng thời điểm nào.
  let billNote = ''
  if (bill?.mode === 'now') {
    const asOf = bill.viewedAt || bill.effectiveCheckOut
    billNote = `<div style="font-size:12px;color:#64748B;margin-bottom:6px">Tạm tính đến: <b>${fmtDateTimeVN(asOf)}</b></div>`
  } else if (bill?.mode === 'checkout') {
    billNote = `<div style="font-size:12px;color:#64748B;margin-bottom:6px">Tính đến giờ trả phòng dự kiến: <b>${fmtDateTimeVN(bill.effectiveCheckOut || booking.checkOut)}</b></div>`
  }

  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:24px 12px">
    <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">

      <!-- Header -->
      <div style="background:linear-gradient(135deg,#0B76EF,#0EA5E9);padding:22px 24px">
        <div style="color:#fff;font-size:20px;font-weight:800;letter-spacing:.3px">${escHtml(brandName)}</div>
        <div style="color:#DBEAFE;font-size:13px;margin-top:2px">Xác nhận đặt phòng</div>
      </div>

      <!-- Body -->
      <div style="padding:22px 24px">
        <p style="font-size:14px;color:#0F172A;margin:0 0 14px">
          Kính gửi <b>${escHtml(booking.customerName || 'Quý khách')}</b>,
        </p>
        <p style="font-size:14px;color:#334155;line-height:1.6;margin:0 0 18px">
          Cảm ơn quý khách đã đặt phòng tại ${escHtml(brandName)}. Dưới đây là thông tin chi tiết đặt phòng của quý khách:
        </p>

        <!-- Thông tin chính -->
        <table style="width:100%;border-collapse:collapse;background:#F8FAFC;border-radius:8px;overflow:hidden">
          ${booking.bookingCode ? `<tr><td style="padding:8px 12px;color:#64748B;font-size:13px;width:42%">Mã đặt phòng</td><td style="padding:8px 12px;color:#0F172A;font-size:13px;font-weight:700">${escHtml(booking.bookingCode)}</td></tr>` : ''}
          <tr><td style="padding:8px 12px;color:#64748B;font-size:13px">Phòng</td><td style="padding:8px 12px;color:#0F172A;font-size:13px;font-weight:600">${escHtml(booking.roomNumber || '—')}${booking.roomType ? ` — ${escHtml(booking.roomType)}` : ''}</td></tr>
          <tr><td style="padding:8px 12px;color:#64748B;font-size:13px">Nhận phòng</td><td style="padding:8px 12px;color:#0F172A;font-size:13px">${fmtDateTimeVN(booking.checkIn)}</td></tr>
          <tr><td style="padding:8px 12px;color:#64748B;font-size:13px">Trả phòng</td><td style="padding:8px 12px;color:#0F172A;font-size:13px">${fmtDateTimeVN(booking.checkOut)}</td></tr>
          ${booking.customerPhone ? `<tr><td style="padding:8px 12px;color:#64748B;font-size:13px">Số điện thoại</td><td style="padding:8px 12px;color:#0F172A;font-size:13px">${escHtml(booking.customerPhone)}</td></tr>` : ''}
        </table>
        ${policyLine}

        <!-- Chi tiết giá -->
        ${breakdownRows ? `
        <div style="margin-top:18px">
          <div style="font-size:14px;font-weight:700;color:#0F172A;margin-bottom:6px">Chi tiết giá</div>
          ${billNote}
          <table style="width:100%;border-collapse:collapse;border:1px solid #EEF2F7;border-radius:8px;overflow:hidden">
            ${breakdownRows}
            <tr>
              <td style="padding:10px;background:#F8FAFC;font-size:14px;font-weight:800;color:#0F172A">Tổng cộng</td>
              <td style="padding:10px;background:#F8FAFC;font-size:14px;font-weight:800;color:#0B76EF;text-align:right">${fmtVND(total)} đ</td>
            </tr>
            ${paid > 0 ? `<tr><td style="padding:8px 10px;font-size:13px;color:#64748B">Đã thanh toán</td><td style="padding:8px 10px;font-size:13px;color:#16A34A;text-align:right">− ${fmtVND(paid)} đ</td></tr>` : ''}
            ${paid > 0 ? `<tr><td style="padding:8px 10px;font-size:13px;font-weight:700;color:#0F172A">Còn lại</td><td style="padding:8px 10px;font-size:13px;font-weight:700;color:#DC2626;text-align:right">${fmtVND(remaining)} đ</td></tr>` : ''}
          </table>
        </div>` : `
        <div style="margin-top:18px;font-size:14px;color:#0F172A">
          Tổng cộng: <b style="color:#0B76EF">${fmtVND(total)} đ</b>
        </div>`}

        ${paymentBlock}

        <p style="font-size:13px;color:#64748B;line-height:1.6;margin:20px 0 0">
          Nếu có bất kỳ thay đổi nào về lịch trình, vui lòng liên hệ trực tiếp với chúng tôi.<br/>
          Trân trọng,<br/><b>${escHtml(brandName)}</b>
        </p>
      </div>

      <!-- Footer -->
      <div style="padding:14px 24px;background:#F8FAFC;border-top:1px solid #EEF2F7;text-align:center">
        <div style="font-size:11px;color:#94A3B8">
          ${branch?.address ? escHtml(branch.address) + ' · ' : ''}${branch?.phone || branch?.hotline ? escHtml(branch.phone || branch.hotline) : ''}
        </div>
        <div style="font-size:11px;color:#CBD5E1;margin-top:4px">Email này được gửi tự động từ hệ thống ${escHtml(brandName)}.</div>
      </div>
    </div>
  </div>
</body></html>`
}

const sendConfirmationEmail = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id)
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy đặt phòng' })
    }

    // 1) Resolve email: ưu tiên booking.customerEmail → Customer.email → body
    const bodyEmail = String(req.body?.email ?? '').trim()
    let targetEmail = String(booking.customerEmail ?? '').trim()
    let customer = null

    if (!targetEmail && booking.customerId) {
      try {
        customer = await Customer.findById(booking.customerId)
        if (customer?.email) targetEmail = String(customer.email).trim()
      } catch (_) {}
    }

    // Nếu khách nhập tay (FE truyền email) → ưu tiên dùng email đó
    const usedManualEmail = !!bodyEmail
    if (usedManualEmail) targetEmail = bodyEmail

    if (!targetEmail) {
      return res.status(400).json({
        success: false,
        code: 'NO_EMAIL',
        message: 'Đặt phòng chưa có email. Vui lòng nhập email khách hàng.',
      })
    }
    if (!isValidEmail(targetEmail)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_EMAIL',
        message: 'Email không hợp lệ. Vui lòng kiểm tra lại.',
      })
    }

    // 2) Lấy branch (cho tên KS + cấu hình mail) + invoice (đã trả/còn lại)
    const branch = await Branch.findById(booking.branchId)
    let invoice = null
    try { invoice = await Invoice.findOne({ bookingId: booking._id }) } catch (_) {}

    // 2b) Số liệu hoá đơn FE đang hiển thị (theo tab user chọn) — nếu có thì
    //   email khớp 100% với FE. Sanitize để không nhúng dữ liệu lạ vào template.
    const sanitizeBill = (raw) => {
      if (!raw || typeof raw !== 'object') return null
      const breakdown = Array.isArray(raw.breakdown)
        ? raw.breakdown
            .filter((b) => b && (b.label !== undefined))
            .map((b) => ({ label: String(b.label ?? ''), amount: Number(b.amount) || 0 }))
        : []
      const mode = (raw.mode === 'checkout' || raw.mode === 'now') ? raw.mode : undefined
      return {
        mode,
        breakdown,
        totalAmount:     Number(raw.totalAmount ?? 0),
        paidAmount:      Number(raw.paidAmount ?? 0),
        remainingAmount: raw.remainingAmount !== undefined ? Number(raw.remainingAmount) : undefined,
        effectiveCheckOut: raw.effectiveCheckOut ?? null,
        viewedAt:          raw.viewedAt ?? null,
      }
    }
    const bill = sanitizeBill(req.body?.bill)

    // 3) Dựng nội dung
    const brandName = branch?.name || 'LuxHotel'
    const subject = `[${brandName}] Xác nhận đặt phòng${booking.bookingCode ? ` #${booking.bookingCode}` : ''} — Phòng ${booking.roomNumber ?? ''}`.trim()
    const html = buildConfirmationHtml({ booking, branch, invoice, bill })

    // 4) Gửi (throw nếu lỗi SMTP → trả 502 để FE báo rõ)
    try {
      await sendMail({ to: targetEmail, subject, html, branchId: booking.branchId })
    } catch (mailErr) {
      console.error('[sendConfirmationEmail] SMTP error:', mailErr.message)
      return res.status(502).json({
        success: false,
        code: 'MAIL_SEND_FAILED',
        message: `Không gửi được email: ${mailErr.message}`,
      })
    }

    // 5) Lưu lại email nếu khách nhập tay (để lần sau không phải nhập lại)
    if (usedManualEmail) {
      try {
        if (!booking.customerEmail || booking.customerEmail !== targetEmail) {
          booking.customerEmail = targetEmail
          await booking.save()
        }
      } catch (e) { console.warn('[sendConfirmationEmail] lưu customerEmail vào booking lỗi:', e.message) }
      try {
        if (booking.customerId) {
          const c = customer || await Customer.findById(booking.customerId)
          if (c && c.email !== targetEmail) {
            c.email = targetEmail
            await c.save()
          }
        }
      } catch (e) { console.warn('[sendConfirmationEmail] lưu email vào customer lỗi:', e.message) }
    }

    // 6) Audit log
    await logAction({
      entityType: 'Booking', entityId: booking._id,
      action: 'send_confirmation_email',
      description: `Gửi email xác nhận đặt phòng tới ${targetEmail}`,
      user: req.user, branchId: booking.branchId,
      metadata: { to: targetEmail, bookingCode: booking.bookingCode, manualEmail: usedManualEmail, billMode: bill?.mode ?? null },
    })

    return res.json({
      success: true,
      message: `Đã gửi email xác nhận tới ${targetEmail}`,
      data: { to: targetEmail, savedEmail: usedManualEmail },
    })
  } catch (err) {
    console.error('[sendConfirmationEmail] error:', err)
    next(err)
  }
}

module.exports = {
  getAll, getOne, create, update,
  previewPrice, changeDates, changeDatesRoom, moveRoom,
  checkin, checkout, cancel, undo,
  getAvailableByDate,
  applyDiscount,
  calculateBill,
  changePolicy,
  createGroup,
  getAvailableByType,
  previewGroup,
  checkinRoom,
  checkoutRoom,
  undoRoom,
  undoMoveRoom,
  getCanSetPast,
  // ⭐ NEW 11/05/2026
  mergeGroup,
  splitRoom,
  getMergeCandidates,
  // ⭐ NEW 30/05/2026: Gửi email xác nhận
  sendConfirmationEmail,
}