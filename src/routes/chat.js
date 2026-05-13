// backend/src/routes/chat.js
// ============================================================
// AI Chat Assistant cho Palm PMS — Updated 13/05/2026
//
// Đã sync với schema thực tế:
// - Room: { number, typeId, roomStatus, branchId }
// - Booking: { checkIn, checkOut, status, totalAmount, customerName, rooms[] }
// - Doanh thu: tính từ Booking.actualCheckOut (status='checked_out')
// - Group support: booking có rooms[] = đoàn nhiều phòng
// ============================================================

const express  = require('express');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const router = express.Router();

// ⚠️ Đổi path nếu models của bạn ở chỗ khác
const Room        = require('../models/Room');
const RoomType    = require('../models/RoomType');
const Booking     = require('../models/Booking');
const Branch      = require('../models/Branch');
const Customer    = require('../models/Customer');
const Invoice     = require('../models/Invoice');
const PricePolicy = require('../models/PricePolicy');

// ⭐ Dùng cùng calculator như booking thật → giá khớp 100%
const { calculatePrice } = require('../utils/priceCalculator');

// ⭐ Services mới: prompt builder + context cache
const {
  buildFullSystemPrompt,
  trackExampleUsage,
} = require('../services/chatPromptBuilder');
const {
  getOrCreateCache,
  getStats: getCacheStats,
} = require('../services/chatCache');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ============================================================
// ⭐ CACHE & RATE LIMIT (tối ưu quota Gemini)
// ============================================================

// Cache kết quả tool — TTL 60s. Câu hỏi giống nhau trong 60s = dùng lại.
const toolCache = new Map();
const TOOL_CACHE_TTL = 60 * 1000;

function getCacheKey(toolName, args, ctx) {
  return `${toolName}|${ctx.role}|${ctx.userBranchId || 'all'}|${JSON.stringify(args)}`;
}

function getCachedTool(key) {
  const entry = toolCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.t > TOOL_CACHE_TTL) {
    toolCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedTool(key, data) {
  toolCache.set(key, { data, t: Date.now() });
  // Cleanup khi cache > 200 entries (tránh leak)
  if (toolCache.size > 200) {
    const oldest = [...toolCache.entries()]
      .sort((a, b) => a[1].t - b[1].t)
      .slice(0, 50);
    oldest.forEach(([k]) => toolCache.delete(k));
  }
}

// Rate limit per user — 15 messages/phút, 200 messages/giờ (Tier 1 paid)
const rateLimitMap = new Map();
const RATE_LIMIT_PER_MIN = 15;
const RATE_LIMIT_PER_HOUR = 200;

function checkRateLimit(userKey) {
  const now = Date.now();
  let bucket = rateLimitMap.get(userKey);
  if (!bucket) {
    bucket = { timestamps: [] };
    rateLimitMap.set(userKey, bucket);
  }

  // Bỏ timestamps cũ hơn 1 giờ
  bucket.timestamps = bucket.timestamps.filter(t => now - t < 60 * 60 * 1000);

  const lastMin = bucket.timestamps.filter(t => now - t < 60 * 1000).length;
  const lastHour = bucket.timestamps.length;

  if (lastMin >= RATE_LIMIT_PER_MIN) {
    return { ok: false, reason: `Bạn đang gửi quá nhanh. Vui lòng chờ ${Math.ceil((60 * 1000 - (now - bucket.timestamps[bucket.timestamps.length - RATE_LIMIT_PER_MIN])) / 1000)}s.` };
  }
  if (lastHour >= RATE_LIMIT_PER_HOUR) {
    return { ok: false, reason: 'Bạn đã đạt giới hạn 60 tin nhắn/giờ. Vui lòng thử lại sau.' };
  }

  bucket.timestamps.push(now);
  return { ok: true };
}

// Cleanup rate limit map định kỳ
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitMap.entries()) {
    bucket.timestamps = bucket.timestamps.filter(t => now - t < 60 * 60 * 1000);
    if (bucket.timestamps.length === 0) rateLimitMap.delete(key);
  }
}, 10 * 60 * 1000);

// ============================================================
// HELPER: Resolve branchId theo role
// ============================================================
async function resolveBranchId(ctx, branchNameFromAI) {
  const { role, userBranchId } = ctx;
  if (role !== 'Admin') return userBranchId || null;

  if (branchNameFromAI && branchNameFromAI.trim()) {
    const keyword = branchNameFromAI.trim();
    const branch = await Branch.findOne({
      $or: [
        { name: new RegExp(keyword, 'i') },
        { code: new RegExp(`^${keyword}$`, 'i') },
      ],
      status: { $ne: 'inactive' },
    }).lean();
    return branch ? String(branch._id) : null;
  }
  return null;
}

const fmt = n => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n);

// ============================================================
// HELPER: Tính real status của room (giống logic dashboardController)
// ============================================================
async function computeRoomRealStatus(branchId = null) {
  const roomFilter = { isActive: { $ne: false } };
  if (branchId) roomFilter.branchId = branchId;

  const allRooms = await Room.find(roomFilter)
    .populate('typeId', 'name')
    .populate('branchId', 'name')
    .select('number typeId branchId roomStatus')
    .lean();

  const now = new Date();

  // Tìm active bookings
  const bookingFilter = {
    $or: [
      { status: 'checked_in' },
      { status: { $in: ['confirmed', 'reserved'] }, checkOut: { $gte: now } },
    ],
  };
  if (branchId) bookingFilter.branchId = branchId;

  const activeBookings = await Booking.find(bookingFilter)
    .select('roomId rooms status customerName checkIn checkOut')
    .lean();

  // Map roomId → booking
  const roomBookingMap = new Map();
  for (const bk of activeBookings) {
    if (bk.roomId) {
      roomBookingMap.set(String(bk.roomId), { booking: bk, subRoom: null });
    }
    if (Array.isArray(bk.rooms)) {
      for (const sr of bk.rooms) {
        if (!sr.roomId) continue;
        if (['cancelled', 'checked_out'].includes(sr.status)) continue;
        const rid = String(sr.roomId._id ?? sr.roomId);
        roomBookingMap.set(rid, { booking: bk, subRoom: sr });
      }
    }
  }

  return allRooms.map(r => {
    const entry = roomBookingMap.get(String(r._id));
    let realStatus = 'available';

    if (r.roomStatus === 'maintenance') {
      realStatus = 'maintenance';
    } else if (r.roomStatus === 'inactive') {
      realStatus = entry ? 'occupied' : 'cleaning';
    } else if (entry) {
      const effectiveStatus = entry.subRoom?.status ?? entry.booking.status;
      if (effectiveStatus === 'checked_in') realStatus = 'occupied';
      else if (effectiveStatus === 'reserved' || effectiveStatus === 'confirmed') realStatus = 'reserved';
      else if (effectiveStatus === 'checked_out') realStatus = 'checkout';
    }

    return {
      _id: r._id,
      number: r.number,
      typeName: r.typeId?.name,
      branchName: r.branchId?.name,
      roomStatus: r.roomStatus,
      realStatus,
      activeBooking: entry?.booking ? {
        customerName: entry.booking.customerName,
        checkIn: entry.subRoom?.checkIn ?? entry.booking.checkIn,
        checkOut: entry.subRoom?.checkOut ?? entry.booking.checkOut,
      } : null,
    };
  });
}

// ============================================================
// TOOLS DEFINITION
// ============================================================
const tools = [{
  functionDeclarations: [
    {
      name: 'get_rooms_overview',
      description: 'Tổng quan trạng thái phòng (tổng số, đang ở, trống, đặt trước, dọn dẹp, bảo trì). Dùng khi user hỏi: "có bao nhiêu phòng trống", "tình hình phòng", "phòng nào đang ở".',
      parameters: {
        type: 'object',
        properties: {
          branchName: { type: 'string', description: 'Tên/mã chi nhánh (CHỈ truyền nếu user nói rõ)' },
          status: { type: 'string', description: 'Lọc theo trạng thái: available, occupied, reserved, checkout, cleaning, maintenance' },
        },
      },
    },

    {
      name: 'check_room_availability',
      description: 'Kiểm tra phòng trống VÀ tính GIÁ ĐẦY ĐỦ (bao gồm phụ thu). HỖ TRỢ CHIA NHÓM (gia đình/đoàn): truyền groups[] để mỗi group được ở 1 phòng riêng, hệ thống tự chọn phòng tối ưu.',
      parameters: {
        type: 'object',
        properties: {
          checkIn:  { type: 'string', description: 'ISO datetime: YYYY-MM-DDTHH:mm hoặc YYYY-MM-DD' },
          checkOut: { type: 'string', description: 'ISO datetime: YYYY-MM-DDTHH:mm hoặc YYYY-MM-DD' },
          branchName: { type: 'string', description: 'Tên/mã chi nhánh' },
          adults:   { type: 'number', description: 'Tổng số NL (KHI KHÔNG có groups). Khi có groups: số NL CÒN LẠI sau khi trừ groups.' },
          children: { type: 'number', description: 'Tổng số TE (KHI KHÔNG có groups). Khi có groups: số TE CÒN LẠI sau khi trừ groups.' },
          priceType: { type: 'string', description: 'hour/day/night/week/month (mặc định day)' },
          groups: {
            type: 'array',
            description: 'Danh sách nhóm/gia đình muốn ở chung 1 phòng. Mỗi item là 1 group có adults + children. Vd: [{name:"Gia đình A", adults:2, children:2}, {name:"Gia đình B", adults:2, children:1}]. Hệ thống tự chọn loại phòng tối ưu cho từng nhóm. PHẢI dùng khi user nói "gia đình ở chung", "nhóm A", "đoàn này tách phòng".',
            items: {
              type: 'object',
              properties: {
                name:     { type: 'string', description: 'Tên nhóm (vd "Gia đình A", "Nhóm 1")' },
                adults:   { type: 'number', description: 'Số NL trong nhóm' },
                children: { type: 'number', description: 'Số TE trong nhóm' },
              },
              required: ['adults'],
            },
          },
        },
        required: ['checkIn', 'checkOut'],
      },
    },

    {
      name: 'get_room_types',
      description: 'Danh sách loại phòng và sức chứa.',
      parameters: {
        type: 'object',
        properties: {
          branchName: { type: 'string' },
        },
      },
    },

    {
      name: 'get_price_policies',
      description: 'Lấy danh sách chính sách giá theo loại phòng. Dùng khi hỏi "giá phòng deluxe", "bảng giá".',
      parameters: {
        type: 'object',
        properties: {
          roomTypeName: { type: 'string', description: 'Tên loại phòng (vd Deluxe, Standard)' },
          branchName: { type: 'string' },
        },
      },
    },

    {
      name: 'search_bookings',
      description: 'Tìm danh sách booking theo điều kiện. Dùng khi hỏi "booking hôm nay", "khách check-in", "đặt phòng tuần này".',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'reserved/confirmed/checked_in/checked_out/cancelled' },
          fromDate: { type: 'string', description: 'YYYY-MM-DD' },
          toDate: { type: 'string', description: 'YYYY-MM-DD' },
          dateField: { type: 'string', description: 'checkIn (mặc định) hoặc actualCheckOut' },
          branchName: { type: 'string' },
          customerName: { type: 'string', description: 'Tìm theo tên khách (partial match)' },
          limit: { type: 'number', description: 'Mặc định 20, tối đa 50' },
        },
      },
    },

    {
      name: 'get_booking_detail',
      description: 'Chi tiết 1 booking theo customerName hoặc roomNumber hoặc bookingId.',
      parameters: {
        type: 'object',
        properties: {
          customerName: { type: 'string' },
          roomNumber: { type: 'string' },
          bookingId: { type: 'string' },
        },
      },
    },

    {
      name: 'get_today_arrivals_departures',
      description: 'Khách check-in / check-out hôm nay. Dùng khi hỏi "ai check-in hôm nay", "ai trả phòng hôm nay".',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'arrivals (check-in) hoặc departures (check-out) hoặc both' },
          branchName: { type: 'string' },
        },
      },
    },

    {
      name: 'search_customer',
      description: 'Tìm khách hàng theo tên hoặc SĐT.',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
        },
        required: ['keyword'],
      },
    },

    {
      name: 'get_revenue_stats',
      description: 'Thống kê doanh thu theo khoảng ngày. Tính từ Booking đã checked_out với actualCheckOut trong khoảng đó.',
      parameters: {
        type: 'object',
        properties: {
          fromDate: { type: 'string' },
          toDate: { type: 'string' },
          branchName: { type: 'string' },
        },
        required: ['fromDate', 'toDate'],
      },
    },

    {
      name: 'get_today_revenue',
      description: 'Doanh thu hôm nay. Shortcut tiện cho câu hỏi "doanh thu hôm nay".',
      parameters: {
        type: 'object',
        properties: {
          branchName: { type: 'string' },
        },
      },
    },

    {
      name: 'get_occupancy_rate',
      description: 'Công suất phòng (% phòng đang được sử dụng).',
      parameters: {
        type: 'object',
        properties: {
          branchName: { type: 'string' },
        },
      },
    },

    {
      name: 'get_top_rooms',
      description: 'Top phòng bán chạy theo doanh thu trong khoảng ngày.',
      parameters: {
        type: 'object',
        properties: {
          fromDate: { type: 'string' },
          toDate: { type: 'string' },
          branchName: { type: 'string' },
          limit: { type: 'number', description: 'Mặc định 5' },
        },
        required: ['fromDate', 'toDate'],
      },
    },

    {
      name: 'get_branches',
      description: 'Danh sách chi nhánh.',
      parameters: { type: 'object', properties: {} },
    },

    // ⭐ NEW: Lấy ảnh phòng
    {
      name: 'get_room_images',
      description: 'Lấy hình ảnh phòng theo loại phòng (RoomType) HOẶC theo số phòng cụ thể. Dùng khi user hỏi: "cho xem phòng Deluxe", "ảnh phòng 101", "phòng VIP trông thế nào", "hình ảnh phòng Standard". Tool trả về danh sách URL ảnh — AI hiển thị bằng markdown ![alt](url).',
      parameters: {
        type: 'object',
        properties: {
          roomTypeName: {
            type: 'string',
            description: 'Tên loại phòng (vd "Deluxe", "Standard", "VIP"). Truyền nếu user hỏi về loại phòng.',
          },
          roomNumber: {
            type: 'string',
            description: 'Số phòng cụ thể (vd "101", "205"). Truyền nếu user hỏi về 1 phòng cụ thể.',
          },
          branchName: { type: 'string', description: 'Tên/mã chi nhánh' },
          maxImages: { type: 'number', description: 'Số ảnh tối đa trả về (mặc định 6, tối đa 12)' },
        },
      },
    },
  ],
}];

// ============================================================
// HANDLERS
// ============================================================
const today = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

const endOfToday = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
};

const makeHandlers = (ctx) => ({

  // ── 1. Tổng quan phòng ──
  async get_rooms_overview({ branchName, status }) {
    const branchId = await resolveBranchId(ctx, branchName);
    const rooms = await computeRoomRealStatus(branchId);

    const summary = {
      total: rooms.length,
      available: 0,
      occupied: 0,
      reserved: 0,
      checkout: 0,
      cleaning: 0,
      maintenance: 0,
    };

    rooms.forEach(r => { summary[r.realStatus] = (summary[r.realStatus] || 0) + 1; });

    let filtered = rooms;
    if (status) filtered = rooms.filter(r => r.realStatus === status);

    return {
      scope: branchId ? 'Chi nhánh chỉ định' : 'Tất cả chi nhánh',
      summary,
      ...(status ? {
        filterStatus: status,
        roomList: filtered.slice(0, 30).map(r => ({
          number: r.number,
          type: r.typeName,
          branch: r.branchName,
          status: r.realStatus,
          guest: r.activeBooking?.customerName,
          checkOut: r.activeBooking?.checkOut,
        })),
      } : {}),
    };
  },

  // ── 2. Kiểm tra phòng trống + ĐỀ XUẤT GÓI PHÒNG TỐI ƯU ──
  async check_room_availability({ checkIn, checkOut, branchName, adults = 2, children = 0, priceType = 'day', groups = [] }) {
    const branchId = await resolveBranchId(ctx, branchName);
    const ci = new Date(checkIn);
    const co = new Date(checkOut);
    const nights = Math.max(1, Math.ceil((co - ci) / 86400000));

    // ⭐ Normalize groups
    const validGroups = Array.isArray(groups)
      ? groups.filter(g => g && (g.adults > 0 || g.children > 0))
        .map((g, i) => ({
          name: g.name || `Nhóm ${i + 1}`,
          adults: Math.max(0, parseInt(g.adults, 10) || 0),
          children: Math.max(0, parseInt(g.children, 10) || 0),
        }))
      : [];

    const roomFilter = { roomStatus: 'active' };
    if (branchId) roomFilter.branchId = branchId;

    const allRooms = await Room.find(roomFilter)
      .populate('typeId', 'name maxAdults maxChildren area')
      .populate('branchId', 'name')
      .lean();

    const roomIds = allRooms.map(r => r._id);

    // Tìm conflict bookings
    const conflicts = await Booking.find({
      $or: [
        { roomId: { $in: roomIds } },
        { 'rooms.roomId': { $in: roomIds } },
      ],
      status: { $in: ['confirmed', 'reserved', 'checked_in'] },
      checkIn: { $lt: co },
      checkOut: { $gt: ci },
    }).select('roomId rooms').lean();

    const bookedIds = new Set();
    conflicts.forEach(b => {
      if (b.roomId) bookedIds.add(String(b.roomId));
      if (Array.isArray(b.rooms)) {
        b.rooms.forEach(sr => {
          if (sr.roomId) bookedIds.add(String(sr.roomId._id ?? sr.roomId));
        });
      }
    });

    const available = allRooms.filter(r => !bookedIds.has(String(r._id)));

    if (available.length === 0) {
      return {
        scope: branchId ? 'Theo chi nhánh' : 'Tất cả chi nhánh',
        checkIn, checkOut, nights, adults, children,
        totalAvailable: 0,
        message: 'Không có phòng trống trong khoảng thời gian này.',
      };
    }

    // Lấy branch để priceCalculator dùng
    const branch = branchId ? await Branch.findById(branchId).lean() : null;
    const sampleBranchId = available[0]?.branchId?._id;
    const effectiveBranch = branch || (sampleBranchId ? await Branch.findById(sampleBranchId).lean() : null);

    // Lấy active PricePolicy
    const uniqueTypeIds = [...new Set(available.map(r => String(r.typeId?._id)).filter(Boolean))];
    const policies = await PricePolicy.find({
      roomTypeId: { $in: uniqueTypeIds },
      isActive: true,
      ...(branchId ? { branchId } : {}),
    }).sort({ displayOrder: 1, name: 1 }).lean();

    const policyByType = {};
    for (const p of policies) {
      const tid = String(p.roomTypeId);
      if (!policyByType[tid]) policyByType[tid] = p;
    }

    // ⭐ Helper: gộp các dòng phụ thu trùng label (vd 3 dòng "Phụ thu 1 NL" → 1 dòng tổng)
    const dedupSurcharges = (items) => {
      const map = new Map();
      for (const it of items) {
        const key = it.label;
        if (map.has(key)) {
          const cur = map.get(key);
          cur.amount += it.amount;
          cur.count = (cur.count || 1) + 1;
        } else {
          map.set(key, { label: it.label, amount: it.amount, count: 1 });
        }
      }
      return [...map.values()].map(it => ({
        label: it.count > 1 ? `${it.label} (×${it.count})` : it.label,
        amount: it.amount,
        amountFormatted: fmt(it.amount),
      }));
    };

    // ⭐ Tính giá cho 1 loại phòng (gồm phụ thu, đã dedup)
    const priceForType = (typeId, type, occupancyAdults, occupancyChildren) => {
      const policy = policyByType[String(typeId)];
      if (!policy || !effectiveBranch) return null;

      try {
        const result = calculatePrice({
          checkIn: ci,
          checkOut: co,
          priceType,
          policy,
          branch: effectiveBranch,
          adults: occupancyAdults,
          children: occupancyChildren,
          maxAdults: type?.maxAdults ?? 2,
          maxChildren: type?.maxChildren ?? 0,
        });

        if (result.error) return null;

        const breakdown = result.breakdown || [];
        let baseAmount = 0;
        const rawSurcharges = [];
        for (const item of breakdown) {
          if (item.type === 'surcharge') {
            rawSurcharges.push({ label: item.label, amount: item.amount });
          } else {
            baseAmount += item.amount || 0;
          }
        }

        return {
          baseAmount,
          baseAmountFormatted: fmt(baseAmount),
          surcharges: dedupSurcharges(rawSurcharges),
          totalAmount: result.roomAmount || 0,
          totalAmountFormatted: fmt(result.roomAmount || 0),
          nights: result.nights || nights,
          policyName: policy.name,
        };
      } catch (err) {
        console.error('[priceForType] error:', err.message);
        return null;
      }
    };

    // ⭐ Group phòng theo type
    const roomsByType = {};
    for (const r of available) {
      const tid = String(r.typeId?._id);
      if (!tid) continue;
      if (!roomsByType[tid]) {
        roomsByType[tid] = {
          type: r.typeId,
          rooms: [],
        };
      }
      roomsByType[tid].rooms.push(r);
    }

    // ⭐ TÍNH PHƯƠNG ÁN TỐI ƯU
    const totalGuests = adults + children;
    const recommendations = [];
    const labelMap = ['⭐ Đề xuất tốt nhất', 'Tuỳ chọn 2', 'Tuỳ chọn 3'];

    // ===========================================
    // ⭐ NEW: GROUP PACKING — khi user truyền groups[]
    //   Mỗi group được ở 1 phòng riêng, hệ thống chọn loại phòng tối ưu
    //   Còn lại NL/TE tự do (không thuộc group) → pack vào phòng share
    // ===========================================
    if (validGroups.length > 0) {
      // Track phòng đã dùng (theo typeId → count)
      const usedRoomsByType = {};
      const groupAllocations = []; // [{ group, type, price }]

      // Bước 1: cho mỗi group, chọn loại phòng RẺ NHẤT đủ chứa
      let allGroupsOk = true;
      for (const grp of validGroups) {
        const grpTotal = grp.adults + grp.children;

        // Lọc các loại phòng đủ chứa và còn phòng trống
        const candidates = Object.values(roomsByType)
          .filter(g => {
            const cap = (g.type.maxAdults || 0) + (g.type.maxChildren || 0);
            const tid = String(g.type._id);
            const used = usedRoomsByType[tid] || 0;
            return cap >= grpTotal && (g.rooms.length - used) >= 1;
          })
          .map(g => ({
            group: g,
            price: priceForType(g.type._id, g.type, grp.adults, grp.children),
          }))
          .filter(x => x.price)
          .sort((a, b) => a.price.totalAmount - b.price.totalAmount);

        if (candidates.length === 0) {
          allGroupsOk = false;
          break;
        }

        const chosen = candidates[0];
        const tid = String(chosen.group.type._id);
        usedRoomsByType[tid] = (usedRoomsByType[tid] || 0) + 1;

        groupAllocations.push({
          groupInfo: grp,
          type: chosen.group.type,
          price: chosen.price,
          availableCount: chosen.group.rooms.length,
        });
      }

      // Bước 2: pack đoàn còn lại (adults + children không thuộc group)
      let remainingAllocations = [];
      let remainingOk = true;

      if (allGroupsOk && (adults > 0 || children > 0)) {
        // Tìm loại phòng có thể pack đoàn còn lại
        // Ưu tiên: ít phòng nhất → rẻ nhất
        const remainingCandidates = Object.values(roomsByType)
          .map(g => {
            const tid = String(g.type._id);
            const usedCount = usedRoomsByType[tid] || 0;
            const availForRemaining = g.rooms.length - usedCount;
            if (availForRemaining < 1) return null;

            const cap = (g.type.maxAdults || 0) + (g.type.maxChildren || 0);
            const maxA = g.type.maxAdults || 0;
            if (cap <= 0) return null;

            // Tính số phòng cần
            const roomsByTotal = Math.ceil((adults + children) / cap);
            const roomsByAdults = maxA > 0 ? Math.ceil(adults / maxA) : Infinity;
            const roomsNeeded = Math.max(roomsByTotal, roomsByAdults);

            if (roomsNeeded > availForRemaining) return null;

            // Phân bổ
            const dist = [];
            let remA = adults, remC = children;
            for (let i = 0; i < roomsNeeded; i++) {
              const left = roomsNeeded - i;
              const aThis = Math.min(maxA, Math.ceil(remA / left));
              const slotLeft = cap - aThis;
              const cThis = Math.min(
                (g.type.maxChildren || 0) > 0 ? g.type.maxChildren : slotLeft,
                slotLeft,
                Math.ceil(remC / left)
              );
              dist.push({ adults: aThis, children: cThis });
              remA -= aThis;
              remC -= cThis;
            }
            if (remA > 0 || remC > 0) return null;

            // Tính giá
            const prices = [];
            let total = 0;
            for (const d of dist) {
              const p = priceForType(g.type._id, g.type, d.adults, d.children);
              if (!p) return null;
              prices.push(p);
              total += p.totalAmount;
            }

            return { group: g, dist, prices, total, roomsNeeded };
          })
          .filter(x => x)
          .sort((a, b) => a.total - b.total);

        if (remainingCandidates[0]) {
          const r = remainingCandidates[0];
          const allSame = r.prices.every(p => p.totalAmount === r.prices[0].totalAmount);
          const breakdown = !allSame
            ? r.prices.map((p, i) => `P${i + 1}: ${p.totalAmountFormatted}`).join(', ')
            : null;

          remainingAllocations.push({
            type: r.group.type,
            quantity: r.roomsNeeded,
            availableCount: r.group.rooms.length,
            distribution: r.dist,
            prices: r.prices,
            totalAmount: r.total,
            note: breakdown ? `Giá phòng khác nhau (${breakdown})` : null,
          });
        } else {
          remainingOk = false;
        }
      }

      // Bước 3: build recommendation từ groups + remaining
      if (allGroupsOk && remainingOk) {
        const rooms = [];

        // Mỗi group → 1 room entry
        for (const alloc of groupAllocations) {
          rooms.push({
            typeName: alloc.type.name,
            maxAdults: alloc.type.maxAdults,
            maxChildren: alloc.type.maxChildren,
            area: alloc.type.area ? `${alloc.type.area}m²` : null,
            quantity: 1,
            availableCount: alloc.availableCount,
            assignAdults: alloc.groupInfo.adults,
            assignChildren: alloc.groupInfo.children,
            groupLabel: `👨‍👩‍👧 ${alloc.groupInfo.name} (${alloc.groupInfo.adults} NL + ${alloc.groupInfo.children} TE)`,
            ...alloc.price,
            totalForQuantity: alloc.price.totalAmount,
            totalForQuantityFormatted: fmt(alloc.price.totalAmount),
          });
        }

        // Remaining → 1 entry với nhiều phòng cùng loại
        for (const rem of remainingAllocations) {
          // ⭐ Build chi tiết từng phòng để AI hiển thị dễ hiểu
          const roomBreakdown = rem.distribution.map((d, i) => ({
            label: `Phòng ${i + 1}`,
            adults: d.adults,
            children: d.children,
            price: rem.prices[i]?.totalAmountFormatted || fmt(rem.prices[i]?.totalAmount || 0),
          }));

          rooms.push({
            typeName: rem.type.name,
            maxAdults: rem.type.maxAdults,
            maxChildren: rem.type.maxChildren,
            area: rem.type.area ? `${rem.type.area}m²` : null,
            quantity: rem.quantity,
            availableCount: rem.availableCount,
            roomBreakdown,                    // ⭐ Mảng chi tiết từng phòng
            groupLabel: `👥 Đoàn còn lại (${adults} NL + ${children} TE)`,
            ...rem.prices[0],
            totalForQuantity: rem.totalAmount,
            totalForQuantityFormatted: fmt(rem.totalAmount),
            note: rem.note,
          });
        }

        const grandTotal = rooms.reduce((s, r) => s + r.totalForQuantity, 0);
        const totalRooms = rooms.reduce((s, r) => s + r.quantity, 0);

        recommendations.push({
          optionLabel: `⭐ Đề xuất chia theo ${validGroups.length} nhóm`,
          rooms,
          totalRooms,
          grandTotal,
          grandTotalFormatted: fmt(grandTotal),
          hasGroups: true,
        });
      }
      // Nếu không pack được → fallback xuống logic cũ (single/multi không group)
    }

    // ===========================================
    // OPTION A: 1 PHÒNG ĐƠN — đủ chứa tất cả khách (không group)
    //   Chỉ chạy khi CHƯA có group recommendation
    // ===========================================
    const hasGroupRec = recommendations.some(r => r.hasGroups);

    const candidatesSingleRoom = hasGroupRec ? [] : Object.values(roomsByType)
      .filter(g => {
        const cap = (g.type.maxAdults || 0) + (g.type.maxChildren || 0);
        return cap >= totalGuests && g.rooms.length >= 1;
      })
      .map(g => {
        const price = priceForType(g.type._id, g.type, adults, children);
        return { group: g, price };
      })
      .filter(x => x.price)
      .sort((a, b) => a.price.totalAmount - b.price.totalAmount);

    // Lấy tối đa 3 option đơn rẻ nhất
    for (const cand of candidatesSingleRoom.slice(0, 3)) {
      const idx = recommendations.length;
      recommendations.push({
        optionLabel: `${labelMap[idx]}: 1 phòng ${cand.group.type.name}`,
        rooms: [{
          typeName: cand.group.type.name,
          maxAdults: cand.group.type.maxAdults,
          maxChildren: cand.group.type.maxChildren,
          area: cand.group.type.area ? `${cand.group.type.area}m²` : null,
          quantity: 1,
          availableCount: cand.group.rooms.length,
          assignAdults: adults,
          assignChildren: children,
          ...cand.price,
          totalForQuantity: cand.price.totalAmount,
          totalForQuantityFormatted: fmt(cand.price.totalAmount),
        }],
        totalRooms: 1,
        grandTotal: cand.price.totalAmount,
        grandTotalFormatted: fmt(cand.price.totalAmount),
      });
    }

    // ===========================================
    // OPTION B: MULTI-ROOM PACKING — chia khách ra nhiều phòng
    // ===========================================
    // Áp dụng khi:
    //   1) Chưa có group recommendation
    //   2) Chưa đủ 3 option
    //   3) Đoàn đông (totalGuests > 4) → cần nhiều phòng
    if (!hasGroupRec && recommendations.length < 3 && totalGuests >= 2) {

      // ⭐ Helper: pack N người vào X phòng cùng loại (greedy distribution)
      //   Trả về { roomsNeeded, distribution: [{adults, children}, ...] } nếu khả thi
      const packIntoType = (typeMaxAdults, typeMaxChildren, availableRooms) => {
        const cap = typeMaxAdults + typeMaxChildren;
        if (cap <= 0) return null;

        // Tính số phòng tối thiểu cần (theo tổng người)
        const roomsNeededByTotal = Math.ceil(totalGuests / cap);
        // Cũng tính theo NL (vì TE ít hơn, đôi khi TE ít → NL quyết định)
        const roomsNeededByAdults = typeMaxAdults > 0
          ? Math.ceil(adults / typeMaxAdults)
          : Infinity;
        const roomsNeeded = Math.max(roomsNeededByTotal, roomsNeededByAdults);

        if (roomsNeeded > availableRooms) return null;
        if (roomsNeeded < 2) return null;  // Đã có option A xử lý

        // Phân bổ khách đều
        const distribution = [];
        let remainingAdults = adults;
        let remainingChildren = children;
        for (let i = 0; i < roomsNeeded; i++) {
          const roomsLeft = roomsNeeded - i;
          // Số NL cho phòng này
          const aThisRoom = Math.min(
            typeMaxAdults,
            Math.ceil(remainingAdults / roomsLeft)
          );
          // Số TE cho phòng này: cho đầy slot còn lại của phòng
          const slotsLeft = cap - aThisRoom;
          const cThisRoom = Math.min(
            typeMaxChildren > 0 ? typeMaxChildren : slotsLeft,
            slotsLeft,
            Math.ceil(remainingChildren / roomsLeft)
          );

          distribution.push({ adults: aThisRoom, children: cThisRoom });
          remainingAdults -= aThisRoom;
          remainingChildren -= cThisRoom;
        }

        // Verify đủ chỗ
        if (remainingAdults > 0 || remainingChildren > 0) return null;

        return { roomsNeeded, distribution };
      };

      // Tính multi-room cho mỗi loại phòng
      const multiRoomCandidates = Object.values(roomsByType)
        .map(g => {
          const packed = packIntoType(
            g.type.maxAdults || 0,
            g.type.maxChildren || 0,
            g.rooms.length
          );
          if (!packed) return null;

          // Tính giá cho từng phòng theo distribution
          let totalPrice = 0;
          let firstPrice = null;
          let allSame = true;
          const roomPrices = [];

          for (const d of packed.distribution) {
            const p = priceForType(g.type._id, g.type, d.adults, d.children);
            if (!p) return null;
            roomPrices.push(p);
            if (!firstPrice) firstPrice = p;
            if (p.totalAmount !== firstPrice.totalAmount) allSame = false;
            totalPrice += p.totalAmount;
          }

          return {
            group: g,
            packed,
            roomPrices,
            firstPrice,
            allSame,
            totalPrice,
          };
        })
        .filter(x => x)
        .sort((a, b) => a.totalPrice - b.totalPrice);

      // Lấy tối đa N multi-room options để fill slot còn trống
      const slotsLeft = 3 - recommendations.length;
      for (const cand of multiRoomCandidates.slice(0, slotsLeft)) {
        const idx = recommendations.length;
        const q = cand.packed.roomsNeeded;

        // ⭐ Build chi tiết từng phòng
        const roomBreakdown = cand.packed.distribution.map((d, i) => ({
          label: `Phòng ${i + 1}`,
          adults: d.adults,
          children: d.children,
          price: cand.roomPrices[i]?.totalAmountFormatted || fmt(cand.roomPrices[i]?.totalAmount || 0),
        }));

        // Note nếu giá các phòng khác nhau
        let note = null;
        if (!cand.allSame) {
          note = 'Giá các phòng khác nhau do chia khách khác nhau (xem chi tiết bên dưới)';
        }

        recommendations.push({
          optionLabel: `${labelMap[idx]}: ${q} phòng ${cand.group.type.name}`,
          rooms: [{
            typeName: cand.group.type.name,
            maxAdults: cand.group.type.maxAdults,
            maxChildren: cand.group.type.maxChildren,
            area: cand.group.type.area ? `${cand.group.type.area}m²` : null,
            quantity: q,
            availableCount: cand.group.rooms.length,
            roomBreakdown,                          // ⭐ Chi tiết từng phòng
            ...cand.firstPrice,
            totalForQuantity: cand.totalPrice,
            totalForQuantityFormatted: fmt(cand.totalPrice),
            note,
          }],
          totalRooms: q,
          grandTotal: cand.totalPrice,
          grandTotalFormatted: fmt(cand.totalPrice),
        });
      }

      // ===========================================
      // OPTION C: MIXED (kết hợp nhiều loại phòng)
      // Chỉ thử nếu CẢ A và B đều rỗng (vd: đoàn quá đông, không loại nào đủ phòng)
      // ===========================================
      if (recommendations.length === 0) {
        // Greedy: sắp xếp các loại theo "giá trên đầu người" tăng dần, rồi pack
        const sortedTypes = Object.values(roomsByType)
          .map(g => {
            const cap = (g.type.maxAdults || 0) + (g.type.maxChildren || 0);
            if (cap <= 0 || g.rooms.length === 0) return null;
            // Tính giá khi pack đầy 1 phòng (để so sánh hiệu quả)
            const p = priceForType(
              g.type._id,
              g.type,
              g.type.maxAdults || 0,
              0
            );
            if (!p) return null;
            return {
              group: g,
              cap,
              maxAdults: g.type.maxAdults || 0,
              maxChildren: g.type.maxChildren || 0,
              available: g.rooms.length,
              pricePerCap: p.totalAmount / cap,
            };
          })
          .filter(x => x)
          .sort((a, b) => a.pricePerCap - b.pricePerCap);

        // Greedy fill: ưu tiên loại rẻ trên đầu người, pack đầy
        let remainAdults = adults;
        let remainChildren = children;
        const mixedRooms = []; // [{group, distribution: [{a,c}]}]

        for (const t of sortedTypes) {
          if (remainAdults <= 0 && remainChildren <= 0) break;
          let used = 0;
          while (used < t.available && (remainAdults > 0 || remainChildren > 0)) {
            // Chia khách vào phòng này
            const aTake = Math.min(t.maxAdults, remainAdults);
            const slotsLeft = t.cap - aTake;
            const cTake = Math.min(
              t.maxChildren > 0 ? t.maxChildren : slotsLeft,
              slotsLeft,
              remainChildren
            );
            if (aTake === 0 && cTake === 0) break;

            const existing = mixedRooms.find(m => m.group === t.group);
            if (existing) {
              existing.distribution.push({ adults: aTake, children: cTake });
            } else {
              mixedRooms.push({
                group: t.group,
                typeData: t,
                distribution: [{ adults: aTake, children: cTake }],
              });
            }
            remainAdults -= aTake;
            remainChildren -= cTake;
            used++;
          }
        }

        // Verify pack đủ
        if (remainAdults <= 0 && remainChildren <= 0 && mixedRooms.length > 0) {
          // Tính giá toàn bộ
          let mixedTotal = 0;
          const mixedRoomDetails = [];
          let canBuild = true;

          for (const m of mixedRooms) {
            const roomPrices = [];
            for (const d of m.distribution) {
              const p = priceForType(m.group.type._id, m.group.type, d.adults, d.children);
              if (!p) { canBuild = false; break; }
              roomPrices.push(p);
              mixedTotal += p.totalAmount;
            }
            if (!canBuild) break;

            const allSame = roomPrices.every(p => p.totalAmount === roomPrices[0].totalAmount);

            // ⭐ Build chi tiết từng phòng
            const roomBreakdown = m.distribution.map((d, i) => ({
              label: `Phòng ${i + 1}`,
              adults: d.adults,
              children: d.children,
              price: roomPrices[i]?.totalAmountFormatted || fmt(roomPrices[i]?.totalAmount || 0),
            }));

            mixedRoomDetails.push({
              typeName: m.group.type.name,
              maxAdults: m.group.type.maxAdults,
              maxChildren: m.group.type.maxChildren,
              area: m.group.type.area ? `${m.group.type.area}m²` : null,
              quantity: m.distribution.length,
              availableCount: m.group.rooms.length,
              roomBreakdown,                          // ⭐ Chi tiết từng phòng
              ...roomPrices[0],
              totalForQuantity: roomPrices.reduce((s, p) => s + p.totalAmount, 0),
              totalForQuantityFormatted: fmt(roomPrices.reduce((s, p) => s + p.totalAmount, 0)),
              note: !allSame ? 'Giá phòng khác nhau (xem chi tiết)' : null,
            });
          }

          if (canBuild) {
            const totalRoomsInMix = mixedRoomDetails.reduce((s, r) => s + r.quantity, 0);
            recommendations.push({
              optionLabel: `⭐ Đề xuất kết hợp ${mixedRoomDetails.length} loại phòng`,
              rooms: mixedRoomDetails,
              totalRooms: totalRoomsInMix,
              grandTotal: mixedTotal,
              grandTotalFormatted: fmt(mixedTotal),
            });
          }
        }
      }
    }

    // Tổng số phòng available theo từng loại (chỉ để hiển thị inventory tham khảo)
    const inventory = Object.values(roomsByType).map(g => ({
      typeName: g.type.name,
      capacity: `${g.type.maxAdults} NL + ${g.type.maxChildren} TE`,
      available: g.rooms.length,
    }));

    return {
      scope: branchId ? 'Theo chi nhánh' : 'Tất cả chi nhánh',
      checkIn, checkOut,
      nights, adults, children,
      groups: validGroups.length > 0 ? validGroups : null,
      totalAvailable: available.length,
      // ⭐ AI CHỈ ĐƯỢC hiển thị các recommendations dưới đây — KHÔNG được tự tạo gói khác
      recommendations: recommendations.length > 0 ? recommendations : null,
      inventory,
      _hint: validGroups.length > 0
        ? 'Phương án đã chia theo các nhóm/gia đình user yêu cầu. Hiển thị MỖI nhóm 1 block (dùng groupLabel để tiêu đề), kèm giá riêng từng nhóm. Cuối cùng có TỔNG chung.'
        : 'CHỈ hiển thị các option trong recommendations[]. Mỗi option có grandTotalFormatted là tổng cuối cùng. KHÔNG cộng nhiều option lại với nhau. KHÔNG liệt kê inventory như một gói đề xuất. Nếu recommendations rỗng → báo "Không có phòng phù hợp với số lượng khách này".',
    };
  },

  // ── 3. Loại phòng ──
  async get_room_types({ branchName }) {
    const branchId = await resolveBranchId(ctx, branchName);
    const q = {};
    if (branchId) q.branchId = branchId;

    const types = await RoomType.find(q)
      .populate('branchId', 'name')
      .select('name maxAdults maxChildren branchId')
      .lean();

    return {
      scope: branchId ? 'Theo chi nhánh' : 'Tất cả',
      roomTypes: types.map(t => ({
        name: t.name,
        branch: t.branchId?.name,
        maxAdults: t.maxAdults,
        maxChildren: t.maxChildren,
        totalCapacity: (t.maxAdults || 0) + (t.maxChildren || 0),
      })),
    };
  },

  // ── 4. Bảng giá ──
  async get_price_policies({ roomTypeName, branchName }) {
    const branchId = await resolveBranchId(ctx, branchName);

    const q = { isActive: true };
    if (branchId) q.branchId = branchId;

    if (roomTypeName) {
      const rt = await RoomType.findOne({ name: new RegExp(roomTypeName, 'i') }).lean();
      if (!rt) return { error: `Không tìm thấy loại phòng "${roomTypeName}"` };
      q.roomTypeId = rt._id;
    }

    const policies = await PricePolicy.find(q)
      .populate('roomTypeId', 'name')
      .populate('branchId', 'name')
      .sort({ displayOrder: 1 })
      .lean();

    return {
      scope: branchId ? 'Theo chi nhánh' : 'Tất cả',
      count: policies.length,
      policies: policies.map(p => ({
        name: p.name,
        roomType: p.roomTypeId?.name || p.roomTypeName,
        branch: p.branchId?.name,
        prices: {
          day: p.dayEnabled ? p.dayPrice : null,
          night: p.nightEnabled ? p.nightPrice : null,
          week: p.weekEnabled ? p.weekPrice : null,
          month: p.monthEnabled ? p.monthPrice : null,
          hour: p.hourEnabled ? p.hourPrice : null,
        },
      })),
    };
  },

  // ── 5. Tìm booking ──
  async search_bookings({ status, fromDate, toDate, dateField = 'checkIn', branchName, customerName, limit = 20 }) {
    const branchId = await resolveBranchId(ctx, branchName);
    const q = {};
    if (status) q.status = status;
    if (branchId) q.branchId = branchId;
    if (customerName) q.customerName = new RegExp(customerName, 'i');

    if (fromDate || toDate) {
      const field = ['checkIn', 'checkOut', 'actualCheckIn', 'actualCheckOut', 'createdAt'].includes(dateField)
        ? dateField : 'checkIn';
      q[field] = {};
      if (fromDate) q[field].$gte = new Date(fromDate);
      if (toDate) {
        const t = new Date(toDate);
        t.setHours(23, 59, 59, 999);
        q[field].$lte = t;
      }
    }

    const bookings = await Booking.find(q)
      .populate('branchId', 'name')
      .select('customerName customerPhone roomNumber roomType checkIn checkOut status totalAmount paymentStatus nights groupName isGroup branchId')
      .sort({ checkIn: -1 })
      .limit(Math.min(limit, 50))
      .lean();

    return {
      scope: branchId ? 'Theo chi nhánh' : 'Tất cả chi nhánh',
      count: bookings.length,
      bookings: bookings.map(b => ({
        customer: b.customerName,
        phone: b.customerPhone,
        room: b.roomNumber,
        roomType: b.roomType,
        branch: b.branchId?.name,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        status: b.status,
        paymentStatus: b.paymentStatus,
        nights: b.nights,
        totalAmount: b.totalAmount,
        totalFormatted: fmt(b.totalAmount || 0),
        isGroup: b.isGroup,
        groupName: b.groupName,
      })),
    };
  },

  // ── 6. Chi tiết booking ──
  async get_booking_detail({ customerName, roomNumber, bookingId }) {
    if (!customerName && !roomNumber && !bookingId) {
      return { error: 'Cần ít nhất 1 trong: customerName, roomNumber, bookingId' };
    }

    const q = {};
    if (bookingId && mongoose.Types.ObjectId.isValid(bookingId)) q._id = bookingId;
    if (customerName) q.customerName = new RegExp(customerName, 'i');
    if (roomNumber) {
      q.$or = [
        { roomNumber: String(roomNumber) },
        { 'rooms.roomNumber': String(roomNumber) },
      ];
    }
    q.status = { $in: ['confirmed', 'reserved', 'checked_in', 'checked_out'] };

    // Non-admin: chỉ thấy booking của branch mình
    if (ctx.role !== 'Admin' && ctx.userBranchId) {
      q.branchId = ctx.userBranchId;
    }

    const b = await Booking.findOne(q)
      .populate('branchId', 'name')
      .sort({ createdAt: -1 })
      .lean();

    if (!b) return { error: 'Không tìm thấy booking phù hợp' };

    return {
      customer: b.customerName,
      phone: b.customerPhone,
      branch: b.branchId?.name,
      room: b.roomNumber,
      roomType: b.roomType,
      isGroup: b.isGroup,
      groupName: b.groupName,
      roomCount: b.isGroup ? (b.rooms?.length || 0) : 1,
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      actualCheckIn: b.actualCheckIn,
      actualCheckOut: b.actualCheckOut,
      status: b.status,
      paymentStatus: b.paymentStatus,
      nights: b.nights,
      adults: b.adults,
      children: b.children,
      roomAmount: fmt(b.roomAmount || 0),
      servicesAmount: fmt(b.servicesAmount || 0),
      discount: fmt(b.discount || 0),
      totalAmount: fmt(b.totalAmount || 0),
      notes: b.notes,
      source: b.source,
      rooms: b.isGroup ? b.rooms?.map(sr => ({
        room: sr.roomNumber,
        status: sr.status,
        amount: fmt(sr.roomAmount || 0),
      })) : undefined,
    };
  },

  // ── 7. Check-in / check-out hôm nay ──
  async get_today_arrivals_departures({ type = 'both', branchName }) {
    const branchId = await resolveBranchId(ctx, branchName);
    const start = today();
    const end = endOfToday();

    const base = {};
    if (branchId) base.branchId = branchId;

    const result = {
      scope: branchId ? 'Theo chi nhánh' : 'Tất cả',
      date: start.toISOString().split('T')[0],
    };

    if (type === 'arrivals' || type === 'both') {
      const arrivals = await Booking.find({
        ...base,
        checkIn: { $gte: start, $lte: end },
        status: { $in: ['reserved', 'confirmed', 'checked_in'] },
      })
        .select('customerName customerPhone roomNumber checkIn status')
        .sort({ checkIn: 1 })
        .lean();

      result.arrivals = {
        count: arrivals.length,
        list: arrivals.map(b => ({
          customer: b.customerName,
          phone: b.customerPhone,
          room: b.roomNumber,
          time: b.checkIn,
          status: b.status,
        })),
      };
    }

    if (type === 'departures' || type === 'both') {
      const departures = await Booking.find({
        ...base,
        checkOut: { $gte: start, $lte: end },
        status: { $in: ['checked_in', 'checked_out'] },
      })
        .select('customerName customerPhone roomNumber checkOut actualCheckOut status totalAmount')
        .sort({ checkOut: 1 })
        .lean();

      result.departures = {
        count: departures.length,
        list: departures.map(b => ({
          customer: b.customerName,
          phone: b.customerPhone,
          room: b.roomNumber,
          scheduledTime: b.checkOut,
          actualTime: b.actualCheckOut,
          status: b.status,
          total: fmt(b.totalAmount || 0),
        })),
      };
    }

    return result;
  },

  // ── 8. Tìm khách hàng ──
  async search_customer({ keyword }) {
    const regex = new RegExp(keyword.trim().replace(/[^\p{L}\d ]/gu, ''), 'i');
    const customers = await Customer.find({
      $or: [{ name: regex }, { phone: regex }, { email: regex }],
    })
      .select('name phone email idNumber totalVisits totalSpent createdAt')
      .limit(10)
      .lean();

    // Non-admin: lọc khách có booking ở branch mình
    let filtered = customers;
    if (ctx.role !== 'Admin' && ctx.userBranchId && customers.length > 0) {
      const validIds = await Booking.distinct('customerId', {
        branchId: ctx.userBranchId,
        customerId: { $in: customers.map(c => c._id) },
      });
      const validSet = new Set(validIds.map(String));
      filtered = customers.filter(c => validSet.has(String(c._id)));
    }

    return {
      count: filtered.length,
      customers: filtered.map(c => ({
        name: c.name,
        phone: c.phone,
        email: c.email,
        totalVisits: c.totalVisits || 0,
        totalSpent: fmt(c.totalSpent || 0),
      })),
    };
  },

  // ── 9. Doanh thu ──
  async get_revenue_stats({ fromDate, toDate, branchName }) {
    const branchId = await resolveBranchId(ctx, branchName);
    const from = new Date(fromDate);
    const to = new Date(toDate);
    from.setHours(0, 0, 0, 0);
    to.setHours(23, 59, 59, 999);

    const match = {
      status: 'checked_out',
      actualCheckOut: { $gte: from, $lte: to },
    };
    if (branchId) {
      match.branchId = mongoose.Types.ObjectId.isValid(branchId)
        ? new mongoose.Types.ObjectId(branchId) : branchId;
    }

    const result = await Booking.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: { $ifNull: ['$totalAmount', 0] } },
          roomRevenue: { $sum: { $ifNull: ['$roomAmount', 0] } },
          servicesRevenue: { $sum: { $ifNull: ['$servicesAmount', 0] } },
          totalBookings: { $sum: 1 },
          avgRevenue: { $avg: { $ifNull: ['$totalAmount', 0] } },
        },
      },
    ]);

    const stats = result[0] || {
      totalRevenue: 0, roomRevenue: 0, servicesRevenue: 0, totalBookings: 0, avgRevenue: 0,
    };

    // Admin xem all → breakdown từng chi nhánh
    let breakdown = null;
    if (!branchId && ctx.role === 'Admin') {
      breakdown = await Booking.aggregate([
        { $match: { status: 'checked_out', actualCheckOut: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: '$branchId',
            revenue: { $sum: { $ifNull: ['$totalAmount', 0] } },
            count: { $sum: 1 },
          },
        },
        { $lookup: { from: 'branches', localField: '_id', foreignField: '_id', as: 'branch' } },
        { $unwind: { path: '$branch', preserveNullAndEmptyArrays: true } },
        { $project: { branchName: '$branch.name', revenue: 1, count: 1 } },
        { $sort: { revenue: -1 } },
      ]);
    }

    return {
      scope: branchId ? 'Theo chi nhánh' : 'Tất cả chi nhánh',
      fromDate, toDate,
      totalRevenue: stats.totalRevenue,
      totalRevenueFormatted: fmt(stats.totalRevenue),
      roomRevenueFormatted: fmt(stats.roomRevenue),
      servicesRevenueFormatted: fmt(stats.servicesRevenue),
      totalBookings: stats.totalBookings,
      avgRevenuePerBooking: fmt(Math.round(stats.avgRevenue || 0)),
      breakdown: breakdown?.map(b => ({
        branch: b.branchName || '(Không có tên)',
        revenue: b.revenue,
        revenueFormatted: fmt(b.revenue),
        bookings: b.count,
      })),
    };
  },

  // ── 10. Doanh thu hôm nay ──
  async get_today_revenue({ branchName }) {
    const branchId = await resolveBranchId(ctx, branchName);
    const start = today();
    const end = endOfToday();

    const match = {
      status: 'checked_out',
      actualCheckOut: { $gte: start, $lte: end },
    };
    if (branchId) {
      match.branchId = mongoose.Types.ObjectId.isValid(branchId)
        ? new mongoose.Types.ObjectId(branchId) : branchId;
    }

    const result = await Booking.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          total: { $sum: { $ifNull: ['$totalAmount', 0] } },
          count: { $sum: 1 },
        },
      },
    ]);

    const stats = result[0] || { total: 0, count: 0 };

    return {
      scope: branchId ? 'Theo chi nhánh' : 'Tất cả chi nhánh',
      date: start.toISOString().split('T')[0],
      revenue: stats.total,
      revenueFormatted: fmt(stats.total),
      checkedOutCount: stats.count,
    };
  },

  // ── 11. Công suất phòng ──
  async get_occupancy_rate({ branchName }) {
    const branchId = await resolveBranchId(ctx, branchName);
    const rooms = await computeRoomRealStatus(branchId);

    const total = rooms.length;
    const occupied = rooms.filter(r => r.realStatus === 'occupied').length;
    const reserved = rooms.filter(r => r.realStatus === 'reserved').length;

    return {
      scope: branchId ? 'Theo chi nhánh' : 'Tất cả chi nhánh',
      date: today().toISOString().split('T')[0],
      totalRooms: total,
      occupiedRooms: occupied,
      reservedRooms: reserved,
      vacantRooms: total - occupied - reserved,
      occupancyRate: total > 0 ? Math.round((occupied / total) * 100) : 0,
      occupancyRateWithReserved: total > 0 ? Math.round(((occupied + reserved) / total) * 100) : 0,
    };
  },

  // ── 12. Top phòng bán chạy ──
  async get_top_rooms({ fromDate, toDate, branchName, limit = 5 }) {
    const branchId = await resolveBranchId(ctx, branchName);
    const from = new Date(fromDate);
    const to = new Date(toDate);
    from.setHours(0, 0, 0, 0);
    to.setHours(23, 59, 59, 999);

    const match = {
      status: 'checked_out',
      actualCheckOut: { $gte: from, $lte: to },
    };
    if (branchId) {
      match.branchId = mongoose.Types.ObjectId.isValid(branchId)
        ? new mongoose.Types.ObjectId(branchId) : branchId;
    }

    const result = await Booking.aggregate([
      { $match: match },
      {
        $facet: {
          singles: [
            { $match: { $or: [{ rooms: { $exists: false } }, { rooms: { $size: 0 } }] } },
            {
              $group: {
                _id: '$roomId',
                roomNumber: { $first: '$roomNumber' },
                roomType: { $first: '$roomType' },
                bookings: { $sum: 1 },
                revenue: { $sum: { $ifNull: ['$totalAmount', 0] } },
              },
            },
          ],
          groups: [
            { $match: { rooms: { $exists: true, $not: { $size: 0 } } } },
            { $unwind: '$rooms' },
            { $match: { 'rooms.status': 'checked_out' } },
            {
              $group: {
                _id: '$rooms.roomId',
                roomNumber: { $first: '$rooms.roomNumber' },
                roomType: { $first: '$rooms.roomType' },
                bookings: { $sum: 1 },
                revenue: { $sum: { $ifNull: ['$rooms.roomAmount', 0] } },
              },
            },
          ],
        },
      },
      { $project: { all: { $concatArrays: ['$singles', '$groups'] } } },
      { $unwind: '$all' },
      {
        $group: {
          _id: '$all._id',
          roomNumber: { $first: '$all.roomNumber' },
          roomType: { $first: '$all.roomType' },
          bookings: { $sum: '$all.bookings' },
          revenue: { $sum: '$all.revenue' },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: Math.min(limit, 10) },
    ]);

    return {
      scope: branchId ? 'Theo chi nhánh' : 'Tất cả',
      fromDate, toDate,
      topRooms: result.map(r => ({
        roomNumber: r.roomNumber || '—',
        roomType: r.roomType || '',
        bookings: r.bookings,
        revenue: r.revenue,
        revenueFormatted: fmt(r.revenue),
      })),
    };
  },

  // ── 13. Chi nhánh ──
  async get_branches() {
    const q = {};
    if (ctx.role !== 'Admin' && ctx.userBranchId) {
      q._id = ctx.userBranchId;
    } else {
      q.status = { $ne: 'inactive' };
    }
    const branches = await Branch.find(q).select('name address city phone').lean();
    return { branches };
  },

  // ── 14. ⭐ Ảnh phòng ──
  async get_room_images({ roomTypeName, roomNumber, branchName, maxImages = 6 }) {
    const branchId = await resolveBranchId(ctx, branchName);
    const limit = Math.min(maxImages || 6, 12);

    // Build query
    const roomQuery = {};
    if (branchId) roomQuery.branchId = branchId;

    // Filter by room number (cụ thể 1 phòng)
    if (roomNumber) {
      roomQuery.number = String(roomNumber);
    }

    // Filter by room type name
    let foundTypeName = null;
    if (roomTypeName) {
      const rt = await RoomType.findOne({
        name: new RegExp(roomTypeName.trim(), 'i'),
        ...(branchId ? { branchId } : {}),
      }).lean();

      if (!rt) {
        return {
          error: `Không tìm thấy loại phòng "${roomTypeName}". Vui lòng kiểm tra lại tên loại phòng.`,
          suggestion: 'Gợi ý: dùng tool get_room_types để xem danh sách loại phòng.',
        };
      }
      roomQuery.typeId = rt._id;
      foundTypeName = rt.name;
    }

    // Nếu không truyền gì cả → trả lỗi
    if (!roomTypeName && !roomNumber) {
      return {
        error: 'Cần truyền ít nhất 1 trong: roomTypeName hoặc roomNumber',
      };
    }

    // Query rooms
    const rooms = await Room.find(roomQuery)
      .populate('typeId', 'name description area maxAdults maxChildren')
      .populate('branchId', 'name')
      .select('number images typeId branchId floorNumber')
      .lean();

    if (rooms.length === 0) {
      return {
        error: roomNumber
          ? `Không tìm thấy phòng số ${roomNumber}`
          : `Không có phòng nào thuộc loại "${foundTypeName}"`,
      };
    }

    // Gom ảnh từ các phòng — ưu tiên phòng có ảnh
    const roomsWithImages = rooms.filter(r => Array.isArray(r.images) && r.images.length > 0);

    if (roomsWithImages.length === 0) {
      return {
        roomType: foundTypeName,
        roomNumber: roomNumber || null,
        totalRoomsFound: rooms.length,
        images: [],
        message: roomNumber
          ? `Phòng ${roomNumber} chưa có ảnh được upload.`
          : `Loại phòng "${foundTypeName}" có ${rooms.length} phòng nhưng chưa có ảnh nào được upload.`,
        suggestion: 'Vui lòng upload ảnh phòng trong trang Quản lý phòng (Settings → Rooms).',
      };
    }

    // Build flat list of images với metadata
    const imageList = [];
    for (const r of roomsWithImages) {
      for (const url of r.images) {
        if (!url || typeof url !== 'string') continue;
        imageList.push({
          url: url.startsWith('http') ? url : `${process.env.SERVER_URL || ''}${url.startsWith('/') ? '' : '/'}${url}`,
          roomNumber: r.number,
          roomType: r.typeId?.name,
          branch: r.branchId?.name,
        });
        if (imageList.length >= limit) break;
      }
      if (imageList.length >= limit) break;
    }

    // Lấy thông tin RoomType (chỉ 1 type nếu user hỏi theo type)
    let typeInfo = null;
    if (foundTypeName && rooms[0]?.typeId) {
      const t = rooms[0].typeId;
      typeInfo = {
        name: t.name,
        description: t.description,
        area: t.area ? `${t.area}m²` : null,
        maxAdults: t.maxAdults,
        maxChildren: t.maxChildren,
        totalCapacity: (t.maxAdults || 0) + (t.maxChildren || 0),
      };
    }

    return {
      roomType: foundTypeName,
      roomNumber: roomNumber || null,
      typeInfo,
      totalRoomsFound: rooms.length,
      totalImages: imageList.length,
      images: imageList,
      // ⭐ Hint cho AI biết cách format ảnh
      _hint: 'Hiển thị ảnh trong markdown: ![Phòng X](url). Có thể đặt 2-3 ảnh liên tiếp, mỗi ảnh xuống dòng riêng.',
    };
  },
});


// ============================================================
// MAIN ENDPOINT
// ============================================================
router.post('/message', async (req, res) => {
  try {
    const { message, history = [], userRole, userBranchId } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ reply: 'Vui lòng nhập tin nhắn hợp lệ.' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        reply: '⚠️ Backend chưa cấu hình GEMINI_API_KEY trong .env',
      });
    }

    const ctx = {
      role: req.user?.role || userRole || 'Receptionist',
      userBranchId: req.user?.branchId
        ? String(req.user.branchId._id || req.user.branchId)
        : (userBranchId || null),
    };

    // ⭐ Rate limit per user: 6 msg/phút, 60 msg/giờ
    const userKey = req.user?._id
      ? String(req.user._id)
      : `${ctx.role}:${ctx.userBranchId || 'anon'}:${req.ip || 'unknown'}`;
    const rateCheck = checkRateLimit(userKey);
    if (!rateCheck.ok) {
      return res.status(429).json({ reply: `⏱️ ${rateCheck.reason}` });
    }

    let userBranchName = null;
    if (ctx.userBranchId && mongoose.Types.ObjectId.isValid(ctx.userBranchId)) {
      const br = await Branch.findById(ctx.userBranchId).select('name').lean();
      userBranchName = br?.name || null;
    }

    console.log('[Chat] ctx:', ctx, '| branchName:', userBranchName, '| msg:', message.slice(0, 60));

    const geminiHistory = history
      .filter(h => h.text && (h.role === 'user' || h.role === 'assistant'))
      .slice(-10)                          // ⭐ Chỉ giữ 10 messages cuối (tiết kiệm token)
      .map(h => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.text }],
      }));
    while (geminiHistory.length && geminiHistory[0].role === 'model') {
      geminiHistory.shift();
    }

    const handlers = makeHandlers(ctx);

    // ⭐ Build full system prompt (core + few-shots từ DB)
    const { systemPrompt, usedExampleIds } = await buildFullSystemPrompt(ctx, userBranchName);

    // Track usage không chờ (fire-and-forget)
    trackExampleUsage(usedExampleIds).catch(() => {});

    // ⭐ Fallback chain — Tier 1 paid:
    //   - Flash 2.5 làm chính: chất lượng cao, 1.000 RPM
    //   - Flash-Lite dự phòng: rẻ hơn 3x
    //   - Pro dự phòng cuối: chất lượng cao nhất
    const MODEL_FALLBACKS = [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
    ];

    // ⭐ Helper tạo model với cache (nếu có) hoặc fallback regular
    async function buildModel(modelName) {
      // Thử dùng cache trước
      const { cache } = await getOrCreateCache(genAI, systemPrompt, tools, ctx, modelName);

      if (cache) {
        // Có cache → dùng cached content (tiết kiệm ~75% input token)
        try {
          return genAI.getGenerativeModelFromCachedContent(cache, {
            generationConfig: { temperature: 0.4, maxOutputTokens: 2000 },
          });
        } catch (err) {
          console.warn(`[Chat] Cached model failed, fallback to regular:`, err.message);
        }
      }

      // Fallback: model thường (gửi full system prompt mỗi lần)
      return genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
        tools,
        generationConfig: { temperature: 0.4, maxOutputTokens: 2000 },
      });
    }

    // ⭐ Helper: gọi sendMessage với retry + fallback model
    async function sendWithFallback(messageOrToolResults, currentChat) {
      let lastError = null;
      for (let modelIdx = 0; modelIdx < MODEL_FALLBACKS.length; modelIdx++) {
        const modelName = MODEL_FALLBACKS[modelIdx];

        let activeChat = currentChat;
        if (modelIdx > 0) {
          console.log(`[Chat] Fallback to ${modelName}`);
          const fallbackModel = await buildModel(modelName);
          const currentHistory = await currentChat.getHistory().catch(() => geminiHistory);
          activeChat = fallbackModel.startChat({ history: currentHistory });
        }

        // Retry 2 lần cho mỗi model với backoff 2s
        for (let retry = 0; retry < 2; retry++) {
          try {
            const r = await activeChat.sendMessage(messageOrToolResults);
            return { result: r, chat: activeChat, model: modelName };
          } catch (err) {
            lastError = err;
            const isRetryable =
              err.message?.includes('503') ||
              err.message?.includes('Service Unavailable') ||
              err.message?.includes('high demand') ||
              err.message?.includes('overloaded') ||
              err.status === 503;

            const isQuotaError =
              err.message?.includes('429') ||
              err.message?.includes('quota') ||
              err.status === 429;

            console.warn(`[Chat] ${modelName} attempt ${retry + 1} failed:`, err.message?.slice(0, 100));

            if (isQuotaError) break;
            if (!isRetryable) throw err;
            if (retry === 0) await new Promise(r => setTimeout(r, 2000));
          }
        }
      }

      throw lastError || new Error('Tất cả model AI đều không khả dụng');
    }

    const model = await buildModel(MODEL_FALLBACKS[0]);

    let chat = model.startChat({ history: geminiHistory });
    let { result, chat: activeChat, model: usedModel } = await sendWithFallback(message, chat);
    chat = activeChat;

    let iterations = 0;
    const MAX_ITER = 5;                    // ⭐ Tier 1: cho phép câu hỏi phức tạp hơn

    while (iterations < MAX_ITER) {
      const calls = result.response.functionCalls?.() || [];
      if (calls.length === 0) break;

      console.log(`[Chat] Iter ${iterations} (${usedModel}) - tools:`, calls.map(c => c.name).join(', '));

      const toolResults = await Promise.all(calls.map(async (call) => {
        const handler = handlers[call.name];
        if (!handler) {
          return {
            functionResponse: {
              name: call.name,
              response: { error: `Unknown tool: ${call.name}` },
            },
          };
        }

        // ⭐ Check cache trước khi gọi tool thật
        const cacheKey = getCacheKey(call.name, call.args || {}, ctx);
        const cached = getCachedTool(cacheKey);
        if (cached) {
          console.log(`[Chat] Tool ${call.name} CACHE HIT`);
          return { functionResponse: { name: call.name, response: cached } };
        }

        try {
          const data = await handler(call.args || {});
          setCachedTool(cacheKey, data);   // ⭐ Cache 60s
          console.log(`[Chat] Tool ${call.name} OK:`, JSON.stringify(data).slice(0, 200));
          return { functionResponse: { name: call.name, response: data } };
        } catch (err) {
          console.error(`[Chat] Tool ${call.name} ERROR:`, err.message);
          return {
            functionResponse: {
              name: call.name,
              response: { error: err.message || 'Tool execution failed' },
            },
          };
        }
      }));

      // ⭐ Gửi tool results với fallback chain
      const sendResult = await sendWithFallback(toolResults, chat);
      result = sendResult.result;
      chat = sendResult.chat;
      usedModel = sendResult.model;
      iterations++;
    }

    const replyText = result.response.text?.() || 'Xin lỗi, tôi không hiểu câu hỏi.';

    // ⭐ Sinh messageId để FE track + submit feedback sau này
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    res.json({
      reply: replyText,
      messageId,                        // ⭐ FE dùng cho feedback
      iterations,
      modelUsed: usedModel,
      scope: {
        role: ctx.role,
        branch: userBranchName || (ctx.role === 'Admin' ? 'Tất cả' : 'Chưa gán'),
      },
    });

  } catch (err) {
    console.error('[Chat] Error:', err);

    let errMsg = '';
    let statusCode = 500;

    if (err.message?.includes('API key')) {
      errMsg = '❌ API key không hợp lệ. Vui lòng liên hệ Admin kiểm tra cấu hình.';
    } else if (
      err.message?.includes('503') ||
      err.message?.includes('Service Unavailable') ||
      err.message?.includes('high demand') ||
      err.message?.includes('overloaded')
    ) {
      errMsg = '⚠️ Server AI của Google đang quá tải. Hệ thống đã thử qua các model dự phòng nhưng tất cả đều bận. Vui lòng thử lại sau 1-2 phút.';
      statusCode = 503;
    } else if (err.message?.includes('quota') || err.message?.includes('429') || err.status === 429) {
      errMsg = '⏱️ Hệ thống AI đang bận (đã đạt giới hạn requests/phút). Vui lòng đợi 30-60 giây rồi thử lại.';
      statusCode = 429;
    } else if (err.message?.includes('SAFETY') || err.message?.includes('blocked')) {
      errMsg = '⚠️ Câu hỏi không phù hợp với chính sách an toàn. Vui lòng diễn đạt lại.';
    } else if (err.message?.includes('timeout') || err.message?.includes('ETIMEDOUT')) {
      errMsg = '⏱️ Hệ thống AI phản hồi chậm. Vui lòng thử lại.';
    } else {
      errMsg = `❌ Lỗi: ${err.message || 'Vui lòng thử lại sau'}.`;
    }

    res.status(statusCode).json({ reply: errMsg, error: err.message });
  }
});

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    hasApiKey: !!process.env.GEMINI_API_KEY,
    model: 'gemini-2.5-flash',
    tier: 'Paid (Tier 1+)',
    fallbacks: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
    toolCount: tools[0].functionDeclarations.length,
    tools: tools[0].functionDeclarations.map(t => t.name),
    cacheStats: {
      toolCacheSize: toolCache.size,
      rateLimitTracked: rateLimitMap.size,
    },
    contextCache: getCacheStats(),     // ⭐ Stats về Gemini context cache
  });
});

module.exports = router;