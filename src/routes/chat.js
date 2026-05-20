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
const jwt      = require('jsonwebtoken');                  // ⭐ Optional auth
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const router = express.Router();

// ⚠️ Đổi path nếu models của bạn ở chỗ khác
const Room        = require('../models/Room');
const RoomType    = require('../models/RoomType');
const Booking     = require('../models/Booking');
const Branch      = require('../models/Branch');
const Customer    = require('../models/Customer');
const Invoice     = require('../models/Invoice');
const PricePolicy = require('../models/PricePolicy');
// ⭐ NEW 14/05/2026: 3 models bổ sung cho AI tra cứu
const User          = require('../models/User');
const Amenity       = require('../models/Amenity');
const PaymentMethod = require('../models/PaymentMethod');
const Procedure = require('../models/Procedure');

// ⭐ Dùng cùng calculator như booking thật → giá khớp 100%
const { calculatePrice } = require('../utils/priceCalculator');

// ⭐ Dùng cùng audit logger + policy snapshot như controller booking
//   (đảm bảo audit log nhất quán, ai tạo booking đều có log)
let logAction = async () => {};
let buildPolicySnapshot = () => null;
try { logAction = require('../utils/auditLogger').logAction || logAction; } catch (e) { console.warn('[chat] auditLogger not found, skip audit'); }
try { buildPolicySnapshot = require('../utils/policySnapshot').buildPolicySnapshot || buildPolicySnapshot; } catch (e) { console.warn('[chat] policySnapshot not found'); }

// ⭐ Services mới: prompt builder + context cache
const {
  buildFullSystemPrompt,
  trackExampleUsage,
} = require('../services/chatPromptBuilder');
const {
  getOrCreateCache,
  getStats: getCacheStats,
} = require('../services/chatCache');

// ⭐ Module phân tích kinh doanh (KPI, trend, chiến lược)
const businessAnalytics = require('../services/chatBusinessAnalytics');

// ⭐ Module phân tích KPI + Lương cho AI
const salaryAnalytics = require('../services/chatSalaryAnalytics');

// ⭐ Sinh suggestion buttons mẫu chuẩn + parse từ reply
const {
  buildStandardSuggestions,
  parseAiSuggestions,
  mergeSuggestions,
} = require('../services/chatSuggestions');

// ⭐ Service lưu chat vào DB (audit + đa thiết bị)
let persistence = null;
try {
  persistence = require('../services/chatPersistence');
} catch (e) {
  console.warn('[chat] chatPersistence not available, skip DB save:', e.message);
}

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
  name: 'prepare_procedure',
  description: 'BƯỚC 1 khi TẠO QUY TRÌNH/SOP/CHECKLIST mới — soạn bản XEM TRƯỚC (KHÔNG ghi vào hệ thống) để Admin duyệt. CHỈ ADMIN. Dùng khi admin nói "thêm quy trình X", "tạo SOP Y", "tạo checklist Z". ⚠️ BẮT BUỘC phải biết positions (quy trình áp dụng cho vị trí nào: Admin/Manager/Receptionist/Staff) TRƯỚC KHI gọi tool — nếu admin chưa nói rõ, PHẢI HỎI trước. AI tự soạn nội dung các bước nếu admin yêu cầu "cho ví dụ", rồi gọi tool này để hiện preview cho admin duyệt.',
  parameters: {
    type: 'object',
    properties: {
      title:       { type: 'string', description: 'Tên quy trình (vd "Quy trình xử lý mất đồ")' },
      positions:   {
        type: 'array',
        description: 'BẮT BUỘC — danh sách vị trí áp dụng. CHỈ chấp nhận: "Admin", "Manager", "Receptionist", "Staff". Nếu admin nói "lễ tân" → map thành "Receptionist"; "buồng phòng/nhân viên" → "Staff"; "quản lý" → "Manager". PHẢI hỏi admin nếu chưa rõ.',
        items: { type: 'string' },
      },
      category:    { type: 'string', description: '"sop" (quy trình chuẩn) hoặc "checklist" (danh sách kiểm tra). Mặc định "sop".' },
      description: { type: 'string', description: 'Mô tả ngắn quy trình (tuỳ chọn)' },
      steps: {
        type: 'array',
        description: 'Danh sách các bước, theo thứ tự. Mỗi bước có title (tiêu đề bước) + content (nội dung chi tiết).',
        items: {
          type: 'object',
          properties: {
            title:   { type: 'string', description: 'Tiêu đề bước (vd "Tiếp nhận thông tin từ khách")' },
            content: { type: 'string', description: 'Nội dung chi tiết của bước' },
          },
          required: ['title'],
        },
      },
      branchName:  { type: 'string', description: 'Tên chi nhánh áp dụng. Admin bỏ trống = dùng chi nhánh hiện tại của admin (hoặc chi nhánh đầu tiên).' },
    },
    required: ['title', 'positions', 'steps'],
  },
},
{
  name: 'confirm_create_procedure',
  description: 'BƯỚC 2 — TẠO QUY TRÌNH THẬT vào hệ thống. CHỈ ADMIN. CHỈ gọi sau khi: (1) đã gọi prepare_procedure, (2) admin đã DUYỆT rõ ràng ("ok", "duyệt", "tạo đi", "đồng ý"). confirmed=true là BẮT BUỘC. Truyền lại ĐẦY ĐỦ thông tin y như đã preview.',
  parameters: {
    type: 'object',
    properties: {
      title:       { type: 'string' },
      positions:   { type: 'array', items: { type: 'string' }, description: 'Y như preview. Chỉ Admin/Manager/Receptionist/Staff.' },
      category:    { type: 'string', description: '"sop" hoặc "checklist"' },
      description: { type: 'string' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title:   { type: 'string' },
            content: { type: 'string' },
          },
          required: ['title'],
        },
      },
      branchName:  { type: 'string' },
      confirmed:   { type: 'boolean', description: 'BẮT BUỘC = true. Flag bảo vệ chắc chắn admin đã duyệt.' },
    },
    required: ['title', 'positions', 'steps', 'confirmed'],
  },
},
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
      name: 'prepare_checkin',
      description: 'BƯỚC 1 của check-in — Preview booking + tính phí phát sinh (CI sớm), KHÔNG check-in thật. Internal only. Phải gọi tool này TRƯỚC để user xem & xác nhận. Tìm booking theo bookingCode HOẶC roomNumber + customerName.',
      parameters: {
        type: 'object',
        properties: {
          bookingCode: { type: 'string', description: 'Mã booking (vd BK_W8X6UE)' },
          roomNumber:  { type: 'string', description: 'Số phòng (fallback nếu không có bookingCode)' },
          customerName: { type: 'string', description: 'Tên khách (kèm roomNumber nếu cần)' },
        },
      },
    },
 
    {
      name: 'confirm_checkin',
      description: 'BƯỚC 2 — Thực hiện check-in thật (đổi status thành "checked_in", set actualCheckIn=now). CHỈ gọi sau khi user xác nhận rõ ràng. Internal only. confirmed=true là BẮT BUỘC.',
      parameters: {
        type: 'object',
        properties: {
          bookingCode: { type: 'string', description: 'Mã booking — BẮT BUỘC' },
          confirmed:   { type: 'boolean', description: 'BẮT BUỘC = true' },
          notes:       { type: 'string', description: 'Ghi chú thêm (tuỳ chọn)' },
        },
        required: ['bookingCode', 'confirmed'],
      },
    },
 
    {
      name: 'prepare_cancellation',
      description: 'BƯỚC 1 của HỦY booking — Preview thông tin booking sẽ bị hủy. CHỈ ADMIN được dùng. KHÔNG hủy thật, chỉ hiển thị cho user xem. Phải có bookingCode.',
      parameters: {
        type: 'object',
        properties: {
          bookingCode: { type: 'string', description: 'Mã booking cần hủy (BẮT BUỘC)' },
        },
        required: ['bookingCode'],
      },
    },
 
    {
      name: 'confirm_cancellation',
      description: 'BƯỚC 2 — Thực hiện HỦY booking thật (đổi status thành "cancelled", giải phóng phòng). CHỈ ADMIN. BẮT BUỘC: confirmed=true + reason (lý do hủy). KHÔNG có lý do = từ chối.',
      parameters: {
        type: 'object',
        properties: {
          bookingCode: { type: 'string', description: 'Mã booking — BẮT BUỘC' },
          reason:      { type: 'string', description: 'Lý do hủy — BẮT BUỘC, tối thiểu 5 ký tự (vd "Khách đổi ý", "Trùng booking", "Khách không tới")' },
          confirmed:   { type: 'boolean', description: 'BẮT BUỘC = true' },
        },
        required: ['bookingCode', 'reason', 'confirmed'],
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
      name: 'check_specific_room',
      description: 'Kiểm tra trạng thái + tình trạng trống của MỘT PHÒNG CỤ THỂ theo số phòng. Dùng cho mọi câu hỏi về 1 phòng cụ thể có số phòng như: "phòng 603 còn không", "phòng 603 còn phòng k", "phòng 201 trống không", "tình trạng phòng 305", "phòng 102 có ai đang ở", "check phòng X", "phòng X đang sao", "phòng 401 thuộc loại nào", "thông tin phòng X", "giá phòng X" (gọi tool này TRƯỚC để biết loại phòng, RỒI gọi get_price_policies với roomTypeName đó). Mọi câu có "phòng" + số → DÙNG TOOL NÀY. CHỈ Internal user (nhân viên).',
      parameters: {
        type: 'object',
        properties: {
          roomNumber: { type: 'string', description: 'Số phòng cần check (vd "603", "201", "305", "401")' },
          checkIn:    { type: 'string', description: 'ISO date/datetime (tuỳ chọn). Truyền khi user hỏi kèm thời gian "ngày mai", "tuần sau".' },
          checkOut:   { type: 'string', description: 'ISO date/datetime (tuỳ chọn).' },
        },
        required: ['roomNumber'],
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
      description: 'Lấy chính sách giá theo TÊN LOẠI PHÒNG (không phải số phòng). Dùng khi user hỏi giá theo LOẠI: "giá phòng deluxe", "bảng giá", "giá Standard City View". Nếu user hỏi giá theo SỐ PHÒNG (vd "giá phòng 401") → gọi check_specific_room TRƯỚC để lấy roomType, rồi mới gọi tool này.',
      parameters: {
        type: 'object',
        properties: {
          roomTypeName: { type: 'string', description: 'Tên loại phòng (vd "Standard City View Room", "Deluxe"). KHÔNG truyền số phòng.' },
          branchName: { type: 'string' },
        },
      },
    },

    {
      name: 'search_bookings',
      description: 'Tìm danh sách booking. Dùng khi hỏi "booking hôm nay", "khách check-in", "đặt phòng tuần này", "danh sách mã đặt phòng". Response trả về bookingCode (mã ngắn dễ đọc) + bookingId (full _id).',
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
      description: 'Chi tiết 1 booking. Tìm theo bookingCode (mã ngắn user gõ), customerName, roomNumber, hoặc bookingId (full _id). Response có bookingCode để hiển thị cho user.',
      parameters: {
        type: 'object',
        properties: {
          customerName: { type: 'string' },
          roomNumber: { type: 'string' },
          bookingCode: { type: 'string', description: 'Mã booking ngắn (vd "A3F8B2C1"). Tìm match cuối _id hoặc field bookingCode.' },
          bookingId: { type: 'string', description: 'Full MongoDB _id (24 ký tự hex)' },
        },
      },
    },

    {
      name: 'get_today_arrivals_departures',
      description: 'Khách check-in / check-out hôm nay. Dùng khi hỏi "ai check-in hôm nay", "ai trả phòng hôm nay", "mã đặt phòng hôm nay". Response trả về bookingCode để hiển thị.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'arrivals (check-in) hoặc departures (check-out) hoặc both' },
          branchName: { type: 'string' },
        },
      },
    },

    {
      name: 'calculate_late_checkout_fee',
      description: 'Tính phí TRẢ PHÒNG TRỄ cho 1 booking đã có. Dùng khi user hỏi "phí trả muộn", "trả phòng trễ", "kéo dài giờ ở", "muốn trả phòng lúc XX:XX". Cần bookingCode + giờ trả mới.',
      parameters: {
        type: 'object',
        properties: {
          bookingCode: { type: 'string', description: 'Mã booking, vd BK_W8X6UE (có thể chỉ có phần sau prefix)' },
          newCheckoutTime: { type: 'string', description: 'Giờ trả mới HH:mm (vd "14:00") - giờ trên cùng ngày trả phòng. Nếu user nói giờ khác ngày, hỏi lại.' },
        },
        required: ['bookingCode', 'newCheckoutTime'],
      },
    },

    {
      name: 'prepare_booking_confirmation',
      description: 'BƯỚC 1 của đặt phòng. Tạo bản XÁC NHẬN (KHÔNG tạo booking thật) để user review. CHỈ Internal user. Có 2 cách chọn phòng: (A) Theo SỐ PHÒNG cụ thể — truyền roomNumber; (B) Theo LOẠI PHÒNG — truyền roomTypeName, tool tự tìm phòng trống đầu tiên cùng loại. Ưu tiên roomNumber nếu được cung cấp.',
      parameters: {
        type: 'object',
        properties: {
          customerName:  { type: 'string', description: 'Tên khách (bắt buộc)' },
          customerPhone: { type: 'string', description: 'SĐT khách (bắt buộc)' },
          checkIn:       { type: 'string', description: 'ISO datetime, vd "2026-05-14T14:00:00"' },
          checkOut:      { type: 'string', description: 'ISO datetime, vd "2026-05-15T12:00:00"' },
          roomNumber:    { type: 'string', description: 'Số phòng cụ thể (vd "201", "305"). Dùng khi user chỉ định "đặt phòng 201", "đặt phòng số 305". Ưu tiên hơn roomTypeName nếu cả 2 đều có.' },
          roomTypeName:  { type: 'string', description: 'Tên loại phòng (vd "Standard City View Room"). Dùng khi user chỉ chọn loại không chọn phòng cụ thể.' },
          adults:        { type: 'number', description: 'Số người lớn (mặc định 2)' },
          children:      { type: 'number', description: 'Số trẻ em (mặc định 0)' },
          priceType:     { type: 'string', description: '"day", "night" hoặc "hour" (mặc định "day")' },
          notes:         { type: 'string', description: 'Ghi chú (tuỳ chọn)' },
        },
        required: ['customerName', 'customerPhone', 'checkIn', 'checkOut'],
      },
    },

    {
      name: 'create_booking',
      description: 'BƯỚC 2 của đặt phòng — TẠO BOOKING THẬT trên hệ thống PMS. CHỈ Internal. CHỈ gọi sau khi: (1) đã gọi prepare_booking_confirmation, (2) user đã xác nhận rõ ràng ("ok chốt", "đặt đi", "xác nhận", "đồng ý"). KHÔNG tự gọi tool này nếu user chưa xác nhận. Sau khi tạo, trả về bookingCode để hiển thị cho user.',
      parameters: {
        type: 'object',
        properties: {
          customerName:  { type: 'string' },
          customerPhone: { type: 'string' },
          checkIn:       { type: 'string', description: 'ISO datetime' },
          checkOut:      { type: 'string', description: 'ISO datetime' },
          roomNumber:    { type: 'string', description: 'Số phòng cụ thể nếu user chọn theo phòng' },
          roomTypeName:  { type: 'string', description: 'Loại phòng nếu chọn theo loại' },
          adults:        { type: 'number' },
          children:      { type: 'number' },
          priceType:     { type: 'string', description: '"day"/"night"/"hour" mặc định "day"' },
          notes:         { type: 'string' },
          confirmed:     { type: 'boolean', description: 'BẮT BUỘC = true. Flag bảo vệ để chắc chắn user đã confirm.' },
        },
        required: ['customerName', 'customerPhone', 'checkIn', 'checkOut', 'confirmed'],
      },
    },

    // ════════════════════════════════════════
    // ⭐ KPI + PHÂN TÍCH KINH DOANH (Internal only)
    // ════════════════════════════════════════
    {
      name: 'get_business_kpi',
      description: 'Lấy KPI kinh doanh khách sạn: Occupancy (công suất), ADR (giá phòng TB), RevPAR, ALOS, repeat rate, cancel rate. Dùng khi user hỏi "KPI tháng này", "công suất khách sạn", "RevPAR", "doanh thu kèm chỉ số". Internal only.',
      parameters: {
        type: 'object',
        properties: {
          fromDate: { type: 'string', description: 'YYYY-MM-DD. Nếu thiếu → đầu tháng hiện tại' },
          toDate:   { type: 'string', description: 'YYYY-MM-DD. Nếu thiếu → hôm nay' },
          branchName: { type: 'string', description: 'Tên chi nhánh (Admin có thể truyền, Manager/Staff tự lọc theo branch của họ)' },
        },
      },
    },

    {
      name: 'analyze_revenue_trend',
      description: 'Phân tích xu hướng doanh thu trong N tháng gần đây. Trả về data từng tháng + insights so sánh. Dùng khi user hỏi "xu hướng doanh thu", "so sánh các tháng", "trend 6 tháng". Internal only.',
      parameters: {
        type: 'object',
        properties: {
          months: { type: 'number', description: 'Số tháng quay lui (mặc định 6, tối đa 12)' },
          branchName: { type: 'string' },
        },
      },
    },

    {
      name: 'analyze_room_performance',
      description: 'Phân tích hiệu quả từng loại phòng: loại nào hot, loại nào ế, doanh thu / công suất từng loại. Dùng khi user hỏi "loại phòng nào bán chạy", "phòng nào ế", "phân tích từng loại phòng". Internal only.',
      parameters: {
        type: 'object',
        properties: {
          fromDate: { type: 'string', description: 'YYYY-MM-DD (mặc định đầu tháng)' },
          toDate:   { type: 'string', description: 'YYYY-MM-DD (mặc định hôm nay)' },
          branchName: { type: 'string' },
        },
      },
    },

    {
      name: 'analyze_weekday_pattern',
      description: 'Phân tích pattern theo ngày tuần: thứ mấy đông, thứ mấy vắng. Dùng khi user hỏi "ngày nào đông khách", "cuối tuần vs đầu tuần", "phân bố theo ngày". Internal only.',
      parameters: {
        type: 'object',
        properties: {
          fromDate: { type: 'string' },
          toDate:   { type: 'string' },
          branchName: { type: 'string' },
        },
      },
    },

    {
      name: 'get_strategy_recommendations',
      description: 'Tổng hợp phân tích + đề xuất CHIẾN LƯỢC kinh doanh cụ thể. Dùng khi user hỏi "đề xuất chiến lược", "tháng này lỗ sao khắc phục", "làm sao tăng doanh thu", "gợi ý cải thiện". Tool sẽ tự gọi các phân tích KPI + room performance + weekday pattern và đưa ra recommendation. Internal only.',
      parameters: {
        type: 'object',
        properties: {
          fromDate: { type: 'string' },
          toDate:   { type: 'string' },
          branchName: { type: 'string' },
        },
      },
    },

    // ════════════════════════════════════════
    // ⭐ KPI + LƯƠNG NHÂN VIÊN (Internal only)
    // ════════════════════════════════════════
    {
      name: 'get_my_salary',
      description: 'Xem lương cá nhân của user đang chat HOẶC của nhân viên khác (chỉ Admin/Manager). Trigger: "lương em tháng này", "lương của em", "lương Nguyễn Phi Linh tháng này", "lương nhân viên X". Mặc định = bản thân. Admin/Manager truyền employeeName để tìm theo tên, hoặc targetUserId nếu có ID. Internal only.',
      parameters: {
        type: 'object',
        properties: {
          year:  { type: 'number', description: 'Năm (mặc định năm hiện tại)' },
          month: { type: 'number', description: 'Tháng 1-12 (mặc định tháng hiện tại)' },
          targetUserId: { type: 'string', description: 'Mongo ObjectId của user cần xem (chỉ Admin/Manager). Bỏ qua nếu xem bản thân.' },
          employeeName: { type: 'string', description: 'Tên nhân viên cần xem (chỉ Admin/Manager). Vd: "Nguyễn Phi Linh", "Linh", "Phi Linh". Tool sẽ tự search trong DB. Bỏ qua nếu xem bản thân.' },
        },
      },
    },

    {
      name: 'get_my_kpi',
      description: 'Xem chi tiết KPI realtime của BẢN THÂN hoặc nhân viên khác (Admin/Manager): doanh thu hiện tại, target, % đạt, tiers thưởng, số ngày còn lại. Trigger: "KPI em đạt bao nhiêu", "% KPI tháng này", "KPI của Linh". Internal only. ⚠️ Đối với Admin (không có KPI cá nhân) → KHÔNG gọi tool này nếu user hỏi "KPI của tôi/em".',
      parameters: {
        type: 'object',
        properties: {
          year:  { type: 'number' },
          month: { type: 'number' },
          targetUserId: { type: 'string', description: 'Admin/Manager xem KPI của user khác' },
          employeeName: { type: 'string', description: 'Tên nhân viên (Admin/Manager). Vd: "Nguyễn Phi Linh"' },
        },
      },
    },

    {
      name: 'get_salary_history',
      description: 'Lịch sử lương N tháng gần đây của bản thân hoặc nhân viên khác. Trigger: "lương 3 tháng vừa rồi", "lịch sử lương Linh", "lương các tháng trước". Internal only.',
      parameters: {
        type: 'object',
        properties: {
          months: { type: 'number', description: 'Số tháng quay lui (1-12, mặc định 6)' },
          targetUserId: { type: 'string', description: 'Admin/Manager xem của user khác' },
          employeeName: { type: 'string', description: 'Tên nhân viên (Admin/Manager)' },
        },
      },
    },

    {
      name: 'get_branch_kpi_overview',
      description: 'Xem tổng quan KPI toàn chi nhánh: % đạt KPI, danh sách nhân viên + KPI từng người. Dùng khi user hỏi "KPI cả branch", "tình hình nhân viên branch", "ai đạt KPI cao nhất branch", "tổng doanh thu nhân viên". CHỈ Admin/Manager.',
      parameters: {
        type: 'object',
        properties: {
          year:  { type: 'number' },
          month: { type: 'number' },
          branchName: { type: 'string', description: 'Tên branch (Manager tự lọc theo branch của mình, không cần truyền)' },
        },
      },
    },

    {
      name: 'get_branch_kpi_config',
      description: 'Xem CẤU HÌNH KPI MỤC TIÊU của chi nhánh: target doanh thu tháng, % thưởng cơ bản cho từng role, các tier vượt mức, và doanh thu thực tế hiện tại của branch. Dùng khi user hỏi "KPI mục tiêu chi nhánh", "target chi nhánh tháng này", "doanh thu mục tiêu", "KPI tháng này của chi nhánh bao nhiêu", "chi nhánh cần đạt bao nhiêu". CHỈ Admin/Manager.',
      parameters: {
        type: 'object',
        properties: {
          branchName: { type: 'string', description: 'Tên chi nhánh (Admin chỉ định, Manager tự lọc)' },
        },
      },
    },

    {
      name: 'get_top_employees',
      description: 'Xếp hạng top nhân viên theo doanh thu, % KPI hoặc lương. Dùng khi user hỏi "top 5 nhân viên", "nhân viên bán giỏi nhất", "ai có lương cao nhất tháng này", "xếp hạng KPI nhân viên". CHỈ Admin/Manager.',
      parameters: {
        type: 'object',
        properties: {
          year:  { type: 'number' },
          month: { type: 'number' },
          branchName: { type: 'string' },
          limit: { type: 'number', description: 'Số nhân viên hiển thị (1-20, mặc định 5)' },
          sortBy: { type: 'string', description: '"revenue" (doanh thu), "kpi" (% KPI), "salary" (lương). Mặc định "revenue".' },
        },
      },
    },

    {
      name: 'get_kpi_improvement_suggestions',
      description: 'Đề xuất chiến lược để CẢI THIỆN KPI cá nhân (hoặc user khác). Dùng khi user hỏi "làm sao em đạt KPI", "em cần làm gì để vượt target", "gợi ý đạt KPI", "tháng này em làm sao kịp KPI". Tool tự phân tích % hiện tại + số ngày còn lại và đưa ra gợi ý hành động cụ thể. Internal only.',
      parameters: {
        type: 'object',
        properties: {
          year:  { type: 'number' },
          month: { type: 'number' },
          targetUserId: { type: 'string', description: 'Admin/Manager: gợi ý cho user khác' },
        },
      },
    },

    // ⭐ NEW 14/05/2026: Lương ứng + Phạt — granular
    {
      name: 'get_my_advances',
      description: 'Chi tiết các lần ỨNG LƯƠNG trong tháng + tổng số tiền đã ứng. Của bản thân HOẶC nhân viên khác (Admin/Manager). Trigger: "em đã ứng bao nhiêu", "lương ứng tháng này", "Linh đã ứng bao nhiêu". Internal only.',
      parameters: {
        type: 'object',
        properties: {
          year:  { type: 'number', description: 'Năm (mặc định: hiện tại)' },
          month: { type: 'number', description: 'Tháng (mặc định: hiện tại)' },
          targetUserId: { type: 'string', description: 'Admin/Manager xem của user khác' },
          employeeName: { type: 'string', description: 'Tên nhân viên (Admin/Manager)' },
        },
      },
    },
    {
      name: 'get_my_penalties',
      description: 'Chi tiết các khoản PHẠT trong tháng + tổng tiền phạt + breakdown theo type/severity. Của bản thân HOẶC nhân viên khác (Admin/Manager). Trigger: "em bị phạt bao nhiêu", "Linh bị phạt mấy lần", "lý do em bị trừ tiền". Internal only.',
      parameters: {
        type: 'object',
        properties: {
          year:  { type: 'number', description: 'Năm (mặc định: hiện tại)' },
          month: { type: 'number', description: 'Tháng (mặc định: hiện tại)' },
          targetUserId: { type: 'string', description: 'Admin/Manager xem của user khác' },
          employeeName: { type: 'string', description: 'Tên nhân viên (Admin/Manager)' },
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

    // ════════════════════════════════════════════════════════════
    // ⭐ NEW 14/05/2026: TOOLS BỔ SUNG — Customer, Amenity, PaymentMethod, User
    // ════════════════════════════════════════════════════════════

    // ── CUSTOMER (4 tools) ────────────────────────────────────────
    {
      name: 'find_customers',
      description: 'Tìm khách hàng trong DB theo tên, SĐT, hoặc email. Dùng khi user hỏi "khách Nguyễn Văn A đã từng ở chưa", "tra số 090...", "khách hàng tên X". CHỈ internal. Hỗ trợ search partial.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Tên / SĐT / email cần tìm (search partial, case-insensitive)' },
          limit: { type: 'number', description: 'Số kết quả tối đa (mặc định 10, tối đa 20)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_customer_detail',
      description: 'Chi tiết 1 khách hàng + LỊCH SỬ booking (5 gần nhất). CHỈ internal. Tìm theo customerId hoặc phone. Trả về tổng số booking, tổng chi tiêu, ngày booking gần nhất.',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'string', description: 'Mongo _id của khách hàng' },
          phone:      { type: 'string', description: 'SĐT khách hàng (exact match)' },
        },
      },
    },
    {
      name: 'get_top_customers',
      description: 'Top khách VIP — sắp xếp theo tổng chi tiêu hoặc số booking trong khoảng thời gian. Dùng khi user hỏi "khách thân thiết", "VIP", "top spender", "khách quay lại nhiều nhất". CHỈ Admin/Manager.',
      parameters: {
        type: 'object',
        properties: {
          sortBy: { type: 'string', description: 'Sắp xếp theo: "spending" (tổng chi tiêu, mặc định) hoặc "bookings" (số booking)' },
          limit:  { type: 'number', description: 'Top N (mặc định 10, tối đa 30)' },
          days:   { type: 'number', description: 'Khoảng thời gian xét (số ngày gần đây, mặc định 90)' },
        },
      },
    },
    {
      name: 'get_customer_stats',
      description: 'Thống kê tổng quát khách hàng: tổng số khách trong DB, khách mới tháng này, repeat rate (% khách quay lại). CHỈ Admin/Manager.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Khoảng "khách mới" (mặc định 30 ngày)' },
        },
      },
    },

    // ── AMENITY (1 tool) ──────────────────────────────────────────
    {
      name: 'list_amenities',
      description: 'Liệt kê tiện nghi (amenities) đang active trong hệ thống, group theo category. Dùng khi user hỏi "khách sạn có wifi không", "có máy lạnh", "tiện nghi phòng Deluxe có gì", "danh sách tiện nghi". Cả internal + external dùng được.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Lọc theo danh mục (vd "Phòng ngủ", "Phòng tắm", "Tiện ích", "Không gian", "Dịch vụ"). Bỏ qua = lấy tất cả.' },
        },
      },
    },

    // ── PAYMENT METHOD (1 tool) ──────────────────────────────────
    {
      name: 'list_payment_methods',
      description: 'Danh sách phương thức thanh toán active (tiền mặt, chuyển khoản, thẻ, ví điện tử...). Dùng khi user hỏi "có nhận chuyển khoản không", "thanh toán bằng gì", "có quẹt thẻ không". Cả internal + external.',
      parameters: { type: 'object', properties: {} },
    },

    // ── USER / STAFF (2 tools — Admin/Manager only) ──────────────
    {
      name: 'find_users',
      description: 'Tìm nhân viên trong hệ thống theo tên, username, role, branch. CHỈ Admin/Manager. Dùng khi user hỏi "có những lễ tân nào ở chi nhánh X", "danh sách nhân viên role Receptionist", "tìm staff Nguyễn".',
      parameters: {
        type: 'object',
        properties: {
          query:      { type: 'string', description: 'Tên hoặc username cần tìm (partial)' },
          role:       { type: 'string', description: 'Lọc theo role: Admin / Manager / Receptionist / Staff' },
          branchName: { type: 'string', description: 'Lọc theo tên chi nhánh' },
          isActive:   { type: 'boolean', description: 'Lọc trạng thái: true = đang hoạt động, false = đã khoá' },
          limit:      { type: 'number', description: 'Tối đa kết quả (mặc định 20)' },
        },
      },
    },
    {
      name: 'get_user_stats',
      description: 'Thống kê tổng quát nhân viên: tổng số, breakdown theo role, theo branch, số đang active vs khoá. CHỈ Admin/Manager.',
      parameters: { type: 'object', properties: {} },
    },

    // ⭐ NEW 14/05/2026: Tools cho module Thu/Chi + Ca trực + Đối soát
    {
      name: 'get_current_shift',
      description: 'Xem ca trực đang mở của bản thân: tiền mặt đã thu, tiền chuyển khoản, tổng giao dịch, tiền dự kiến cuối ca. Trigger: "Em đang trực ca nào", "Ca em đang mở", "Em thu được bao nhiêu", "Tổng tiền ca em hôm nay", "Tiền mặt em đang giữ". Internal only.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'get_today_cash_flow',
      description: 'Tổng quan dòng tiền hôm nay của chi nhánh: tổng thu, tổng chi, theo từng phương thức (tiền mặt/CK/thẻ). Trigger: "Hôm nay thu được bao nhiêu", "Doanh thu hôm nay", "Hôm nay chi bao nhiêu", "Tiền mặt hôm nay", "Tổng thu chi ngày X". Admin/Manager/Receptionist xem được.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Ngày cần xem (YYYY-MM-DD, mặc định hôm nay)' },
          branchName: { type: 'string', description: 'Tên chi nhánh (Admin tuỳ chọn)' },
        },
      },
    },
    {
      name: 'find_cash_discrepancy',
      description: 'Tìm các ca có chênh lệch tiền (cash hoặc bank) trong khoảng thời gian. Trigger: "Có ca nào thiếu tiền không", "Ca nào chênh lệch tháng này", "Ai làm thiếu tiền", "Có sai sót tiền không". CHỈ Admin/Manager.',
      parameters: {
        type: 'object',
        properties: {
          fromDate: { type: 'string', description: 'YYYY-MM-DD (mặc định đầu tháng)' },
          toDate: { type: 'string', description: 'YYYY-MM-DD (mặc định hôm nay)' },
          minDifference: { type: 'number', description: 'Chỉ tìm ca chênh lệch lớn hơn (vnd, mặc định 0 = tìm tất cả)' },
          branchName: { type: 'string', description: 'Admin tuỳ chọn' },
        },
      },
    },
    {
      name: 'get_reconciliation_status',
      description: 'Xem trạng thái đối soát tháng/kỳ: đã đối soát chưa, có chênh lệch không, số tiền chênh lệch. Trigger: "Tháng này đã đối soát chưa", "Đối soát tháng X thế nào", "Có chênh lệch không". CHỈ Admin/Manager.',
      parameters: {
        type: 'object',
        properties: {
          year:  { type: 'number' },
          month: { type: 'number' },
          branchName: { type: 'string' },
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
    // ⭐ External: chỉ thấy "còn phòng hay không", không có chi tiết
    if (!ctx.isInternal) {
      return {
        error: 'external_not_allowed',
        message: 'Khách hàng vui lòng cho em biết ngày nhận & trả phòng để em kiểm tra phòng trống cho ạ.',
      };
    }
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
    let ci = new Date(checkIn);
    let co = new Date(checkOut);

    // ⭐ FIX: Nếu user chỉ truyền NGÀY (không có giờ), tự gán giờ CHUẨN của khách sạn
    //   Vd: "2026-05-14" → 2026-05-14 14:00 (giờ check-in chuẩn)
    //        "2026-05-15" → 2026-05-15 12:00 (giờ check-out chuẩn)
    //   Tránh tình huống AI bịa "Nhận phòng sớm X giờ" vì Date('2026-05-14') = 00:00.
    const branchForTime = branchId
      ? await Branch.findById(branchId).lean()
      : await Branch.findOne().lean();
    const ciTimeStr = branchForTime?.checkInTime || '14:00';
    const coTimeStr = branchForTime?.checkOutTime || '12:00';

    const isOnlyDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
    const setTime = (date, hhmm) => {
      const [h, m] = String(hhmm).split(':').map(Number);
      const d = new Date(date);
      d.setHours(h || 14, m || 0, 0, 0);
      return d;
    };
    if (isOnlyDate(checkIn)) ci = setTime(checkIn + 'T00:00:00', ciTimeStr);
    if (isOnlyDate(checkOut)) co = setTime(checkOut + 'T00:00:00', coTimeStr);

    // Nếu user truyền datetime nhưng giờ = 00:00 → cũng coi là không có giờ, gán chuẩn
    if (!isOnlyDate(checkIn) && ci.getHours() === 0 && ci.getMinutes() === 0) {
      ci = setTime(ci, ciTimeStr);
    }
    if (!isOnlyDate(checkOut) && co.getHours() === 0 && co.getMinutes() === 0) {
      co = setTime(co, coTimeStr);
    }

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
      .populate('typeId', 'name maxAdults maxChildren maxOccupancy beds area')
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
          maxOccupancy: type?.maxOccupancy ?? ((type?.maxAdults ?? 2) + (type?.maxChildren ?? 0)),
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

    // ⭐ Helper: lấy sức chứa thực sự của 1 type
    //   Ưu tiên maxOccupancy (số người tối đa, đã bao gồm extra slots)
    //   Fallback maxAdults + maxChildren (data cũ chưa migrate)
    const effectiveCap = (type) => {
      if (type?.maxOccupancy && type.maxOccupancy > 0) return type.maxOccupancy;
      return (type?.maxAdults || 0) + (type?.maxChildren || 0);
    };

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
            const cap = effectiveCap(g.type);
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
        const usedIdx = usedRoomsByType[tid] || 0;
        usedRoomsByType[tid] = usedIdx + 1;

        // ⭐ Gán số phòng cụ thể (nếu Internal)
        const assignedRoom = ctx.isInternal
          ? chosen.group.rooms[usedIdx]?.number || null
          : null;

        groupAllocations.push({
          groupInfo: grp,
          type: chosen.group.type,
          price: chosen.price,
          availableCount: chosen.group.rooms.length,
          roomNumber: assignedRoom,        // ⭐ MỚI
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

            const cap = effectiveCap(g.type);
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

          // ⭐ Lấy số phòng từ pool còn lại sau khi groupAllocations đã chiếm
          const tid = String(r.group.type._id);
          const startIdx = usedRoomsByType[tid] || 0;
          const remainingRoomNumbers = ctx.isInternal
            ? r.group.rooms.slice(startIdx, startIdx + r.roomsNeeded).map(rm => rm.number)
            : [];

          remainingAllocations.push({
            type: r.group.type,
            quantity: r.roomsNeeded,
            availableCount: r.group.rooms.length,
            distribution: r.dist,
            prices: r.prices,
            totalAmount: r.total,
            note: breakdown ? `Giá phòng khác nhau (${breakdown})` : null,
            roomNumbers: remainingRoomNumbers,        // ⭐ MỚI
          });
        } else {
          remainingOk = false;
        }
      }

      // Bước 3: build recommendation từ groups + remaining
      if (allGroupsOk && remainingOk) {
        const rooms = [];
        const allRoomNumbers = [];        // ⭐ Tổng hợp số phòng cho cả option

        // Mỗi group → 1 room entry
        for (const alloc of groupAllocations) {
          if (alloc.roomNumber) allRoomNumbers.push(alloc.roomNumber);
          rooms.push({
            typeName: alloc.type.name,
            maxAdults: alloc.type.maxAdults,
            maxChildren: alloc.type.maxChildren,
            beds: alloc.type.beds || 1,
            maxOccupancy: alloc.type.maxOccupancy || ((alloc.type.maxAdults||0) + (alloc.type.maxChildren||0)),
            area: alloc.type.area ? `${alloc.type.area}m²` : null,
            quantity: 1,
            availableCount: alloc.availableCount,
            roomNumbers: alloc.roomNumber ? [alloc.roomNumber] : [],   // ⭐ MỚI
            assignAdults: alloc.groupInfo.adults,
            assignChildren: alloc.groupInfo.children,
            groupLabel: alloc.roomNumber
              ? `👨‍👩‍👧 ${alloc.groupInfo.name} — Phòng ${alloc.roomNumber} (${alloc.groupInfo.adults} NL + ${alloc.groupInfo.children} TE)`
              : `👨‍👩‍👧 ${alloc.groupInfo.name} (${alloc.groupInfo.adults} NL + ${alloc.groupInfo.children} TE)`,
            ...alloc.price,
            totalForQuantity: alloc.price.totalAmount,
            totalForQuantityFormatted: fmt(alloc.price.totalAmount),
          });
        }

        // Remaining → 1 entry với nhiều phòng cùng loại
        for (const rem of remainingAllocations) {
          if (rem.roomNumbers) allRoomNumbers.push(...rem.roomNumbers);

          // ⭐ Build chi tiết từng phòng — gắn số phòng thật nếu có
          const roomBreakdown = rem.distribution.map((d, i) => ({
            label: rem.roomNumbers?.[i]
              ? `Phòng ${rem.roomNumbers[i]}`
              : `Phòng ${i + 1}`,
            roomNumber: rem.roomNumbers?.[i] || null,
            adults: d.adults,
            children: d.children,
            price: rem.prices[i]?.totalAmountFormatted || fmt(rem.prices[i]?.totalAmount || 0),
          }));

          rooms.push({
            typeName: rem.type.name,
            maxAdults: rem.type.maxAdults,
            maxChildren: rem.type.maxChildren,
            beds: rem.type.beds || 1,
            maxOccupancy: rem.type.maxOccupancy || ((rem.type.maxAdults||0) + (rem.type.maxChildren||0)),
            area: rem.type.area ? `${rem.type.area}m²` : null,
            quantity: rem.quantity,
            availableCount: rem.availableCount,
            roomNumbers: rem.roomNumbers || [],          // ⭐ MỚI
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
          optionSummary: `${totalRooms} phòng cho ${validGroups.length} nhóm + đoàn còn lại`,
          rooms,
          roomNumbers: allRoomNumbers,        // ⭐ MỚI
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
        const cap = effectiveCap(g.type);
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
      // ⭐ Lấy số phòng cụ thể (chỉ Internal được thấy)
      const roomNumbers = ctx.isInternal
        ? cand.group.rooms.slice(0, 1).map(r => r.number)
        : [];
      recommendations.push({
        optionLabel: labelMap[idx],                         // ⭐ Chỉ "⭐ Đề xuất tốt nhất" / "Tuỳ chọn 2"
        optionSummary: `1 phòng ${cand.group.type.name}`,   // ⭐ NEW: subtitle hiển thị dưới label
        rooms: [{
          typeName: cand.group.type.name,
          maxAdults: cand.group.type.maxAdults,
          maxChildren: cand.group.type.maxChildren,
          beds: cand.group.type.beds || 1,
          maxOccupancy: cand.group.type.maxOccupancy || ((cand.group.type.maxAdults||0) + (cand.group.type.maxChildren||0)),
          area: cand.group.type.area ? `${cand.group.type.area}m²` : null,
          quantity: 1,
          availableCount: cand.group.rooms.length,
          roomNumbers,                                       // ⭐ MỚI: ["201"] (chỉ Internal)
          assignAdults: adults,
          assignChildren: children,
          ...cand.price,
          totalForQuantity: cand.price.totalAmount,
          totalForQuantityFormatted: fmt(cand.price.totalAmount),
        }],
        roomNumbers,                                          // ⭐ MỚI: ở level option
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
      //   ⭐ MỚI: dùng `typeMaxOccupancy` làm cap thật sự (số người tối đa cho phép)
      //          `typeMaxAdults` chỉ dùng để check max NL/phòng (constraint cứng)
      const packIntoType = (typeMaxAdults, typeMaxChildren, typeMaxOccupancy, availableRooms) => {
        // ⭐ Cap = số người tối đa cho phép (đã bao gồm extra slots)
        const cap = typeMaxOccupancy && typeMaxOccupancy > 0
          ? typeMaxOccupancy
          : (typeMaxAdults + typeMaxChildren);
        if (cap <= 0) return null;

        // Tính số phòng tối thiểu cần (theo tổng người)
        const roomsNeededByTotal = Math.ceil(totalGuests / cap);
        // Cũng tính theo NL — chỉ cap theo maxOccupancy (không tách NL/TE riêng nữa, vì khách lớn nằm chung cũng ổn)
        const roomsNeeded = roomsNeededByTotal;

        if (roomsNeeded > availableRooms) return null;
        if (roomsNeeded < 2) return null;  // Đã có option A xử lý

        // Phân bổ khách đều
        const distribution = [];
        let remainingAdults = adults;
        let remainingChildren = children;
        for (let i = 0; i < roomsNeeded; i++) {
          const roomsLeft = roomsNeeded - i;
          // Số NL cho phòng này (ưu tiên dồn NL trước)
          const aThisRoom = Math.min(
            cap,                                   // không vượt maxOccupancy
            Math.ceil(remainingAdults / roomsLeft)
          );
          // Số TE cho phòng này: cho đầy slot còn lại của phòng
          const slotsLeft = cap - aThisRoom;
          const cThisRoom = Math.min(
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
            effectiveCap(g.type),                    // ⭐ MỚI: dùng maxOccupancy
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

        // ⭐ Lấy danh sách số phòng cụ thể được gán (chỉ Internal)
        const roomNumbers = ctx.isInternal
          ? cand.group.rooms.slice(0, q).map(r => r.number)
          : [];

        // ⭐ Build chi tiết từng phòng — gắn roomNumber nếu có
        const roomBreakdown = cand.packed.distribution.map((d, i) => ({
          label: roomNumbers[i]
            ? `Phòng ${roomNumbers[i]}`               // ⭐ Hiển thị số phòng thật
            : `Phòng ${i + 1}`,
          roomNumber: roomNumbers[i] || null,         // ⭐ Field riêng
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
          optionLabel: labelMap[idx],                              // ⭐ Chỉ "⭐ Đề xuất tốt nhất" / "Tuỳ chọn 2"
          optionSummary: `${q} phòng ${cand.group.type.name}`,     // ⭐ Subtitle riêng
          rooms: [{
            typeName: cand.group.type.name,
            maxAdults: cand.group.type.maxAdults,
            maxChildren: cand.group.type.maxChildren,
          beds: cand.group.type.beds || 1,
          maxOccupancy: cand.group.type.maxOccupancy || ((cand.group.type.maxAdults||0) + (cand.group.type.maxChildren||0)),
            area: cand.group.type.area ? `${cand.group.type.area}m²` : null,
            quantity: q,
            availableCount: cand.group.rooms.length,
            roomNumbers,                                            // ⭐ MỚI
            roomBreakdown,
            ...cand.firstPrice,
            totalForQuantity: cand.totalPrice,
            totalForQuantityFormatted: fmt(cand.totalPrice),
            note,
          }],
          roomNumbers,                                              // ⭐ MỚI: ở level option
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
            const cap = effectiveCap(g.type);
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
            // Build summary từng loại: vd "2 phòng Superior + 1 phòng Standard"
            const summaryParts = mixedRoomDetails.map(r => `${r.quantity} phòng ${r.typeName}`);
            recommendations.push({
              optionLabel: '⭐ Đề xuất kết hợp nhiều loại phòng',
              optionSummary: summaryParts.join(' + '),
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
      beds: g.type.beds || 1,
      maxOccupancy: effectiveCap(g.type),
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

  // ── 2b. Kiểm tra 1 phòng cụ thể (Internal only) ──
  async check_specific_room({ roomNumber, checkIn, checkOut }) {
    if (!ctx.isInternal) {
      return {
        error: 'external_not_allowed',
        message: 'Thông tin chi tiết phòng chỉ dành cho nhân viên ạ.',
      };
    }
    if (!roomNumber?.toString().trim()) return { error: 'Thiếu số phòng' };

    const numClean = String(roomNumber).trim();
    const roomFilter = { number: numClean };
    if (ctx.userBranchId && ctx.role !== 'Admin') {
      roomFilter.branchId = ctx.userBranchId;
    }

    const room = await Room.findOne(roomFilter)
      .populate('typeId', 'name maxAdults maxChildren maxOccupancy beds area')
      .populate('branchId', 'name')
      .lean();

    if (!room) {
      return {
        notFound: true,
        roomNumber: numClean,
        message: `Không tìm thấy phòng số ${numClean}`,
      };
    }

    const status = room.roomStatus;
    const statusLabel = {
      active: 'Đang hoạt động',
      inactive: 'Tạm ngưng',
      maintenance: 'Đang bảo trì',
    }[status] || status;

    // Booking hiện tại của phòng (nếu có)
    let currentBookingInfo = null;
    if (room.currentBookingId) {
      const cb = await Booking.findById(room.currentBookingId)
        .select('customerName customerPhone checkIn checkOut status bookingCode')
        .lean();
      if (cb) {
        currentBookingInfo = {
          customerName: cb.customerName,
          status: cb.status,
          checkIn: cb.checkIn,
          checkOut: cb.checkOut,
          bookingCode: cb.bookingCode || `BK_${String(cb._id).slice(-6).toUpperCase()}`,
        };
      }
    }

    // Nếu user truyền khoảng thời gian → check conflict
    let availabilityCheck = null;
    if (checkIn && checkOut) {
      let ci = new Date(checkIn);
      let co = new Date(checkOut);
      if (!isNaN(ci.getTime()) && !isNaN(co.getTime())) {
        // Tự gán giờ chuẩn nếu chỉ có ngày
        const branch = room.branchId;
        const ciTimeStr = branch?.checkInTime || '14:00';
        const coTimeStr = branch?.checkOutTime || '12:00';
        const isOnlyDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
        const setTime = (d, hhmm) => {
          const [h, m] = String(hhmm).split(':').map(Number);
          const dt = new Date(d);
          dt.setHours(h || 14, m || 0, 0, 0);
          return dt;
        };
        if (isOnlyDate(checkIn)) ci = setTime(checkIn + 'T00:00:00', ciTimeStr);
        if (isOnlyDate(checkOut)) co = setTime(checkOut + 'T00:00:00', coTimeStr);

        const conflicts = await Booking.find({
          $or: [{ roomId: room._id }, { 'rooms.roomId': room._id }],
          status: { $in: ['confirmed', 'reserved', 'checked_in'] },
          checkIn: { $lt: co },
          checkOut: { $gt: ci },
        })
          .select('customerName checkIn checkOut status bookingCode')
          .lean();

        availabilityCheck = {
          requestedCheckIn: ci,
          requestedCheckOut: co,
          isAvailable: conflicts.length === 0 && status === 'active',
          conflicts: conflicts.map(c => ({
            customerName: c.customerName,
            checkIn: c.checkIn,
            checkOut: c.checkOut,
            status: c.status,
            bookingCode: c.bookingCode || `BK_${String(c._id).slice(-6).toUpperCase()}`,
          })),
        };
      }
    }

    // ⭐ Kèm chính sách giá của loại phòng này (để user hỏi giá khỏi phải gọi 2 tool)
    //   CHỈ hiển thị loại giá đang ENABLED và có giá > 0
    //   (tránh AI bịa "giá đêm 200.000đ" khi khách sạn không bán theo đêm)
    let pricePolicy = null;
    if (room.typeId?._id) {
      const policy = await PricePolicy.findOne({
        roomTypeId: room.typeId._id,
        branchId: room.branchId?._id || room.branchId,
        isActive: true,
      }).lean();
      if (policy) {
        const hasDay   = policy.dayEnabled   && policy.dayPrice   > 0;
        const hasNight = policy.nightEnabled && policy.nightPrice > 0;
        const hasHour  = policy.hourEnabled  && policy.hourPrice  > 0;

        pricePolicy = {
          name: policy.name,
          // ⭐ CHỈ set giá khi enabled — nếu không thì null (AI sẽ bỏ qua)
          dayPrice:   hasDay   ? policy.dayPrice   : null,
          dayPriceFormatted:   hasDay   ? fmt(policy.dayPrice)   : null,
          nightPrice: hasNight ? policy.nightPrice : null,
          nightPriceFormatted: hasNight ? fmt(policy.nightPrice) : null,
          hourPrice:  hasHour  ? policy.hourPrice  : null,
          hourPriceFormatted:  hasHour  ? fmt(policy.hourPrice)  : null,
          // ⭐ Liệt kê các loại giá enabled (để AI biết khách sạn bán theo cách nào)
          availableTypes: [
            hasDay   && 'day',
            hasNight && 'night',
            hasHour  && 'hour',
          ].filter(Boolean),
        };
      }
    }

    // ⭐ Kèm giờ chuẩn + chính sách phụ thu của chi nhánh
    let branchPolicy = null;
    const branchFull = room.branchId?._id
      ? await Branch.findById(room.branchId._id).lean()
      : await Branch.findById(room.branchId).lean();
    if (branchFull) {
      const tolerance = branchFull.toleranceMinutes ?? 30;
      const hourThreshold = branchFull.hourToDayThreshold ?? 6;
      const ciTime = branchFull.checkInTime  || '14:00';
      const coTime = branchFull.checkOutTime || '12:00';

      // ⭐ Build mô tả phụ thu dựa trên giá có sẵn (không bịa giá giờ nếu không enabled)
      const hourPriceStr = pricePolicy?.hourPriceFormatted
        ? `theo giá giờ (${pricePolicy.hourPriceFormatted}/giờ)`
        : 'theo giá phụ thu của khách sạn';

      branchPolicy = {
        checkInTime:  ciTime,
        checkOutTime: coTime,
        toleranceMinutes: tolerance,
        hourToDayThreshold: hourThreshold,
        dayEquivalentHours: branchFull.dayEquivalentHours ?? 24,
        surchargeRules: {
          earlyCheckIn: `Nhận phòng sớm trước ${ciTime}: miễn phí trong ${tolerance} phút, sau đó tính ${hourPriceStr}. Nếu sớm trên ${hourThreshold} giờ → tính nguyên 1 ngày.`,
          lateCheckOut: `Trả phòng muộn sau ${coTime}: miễn phí trong ${tolerance} phút, sau đó tính ${hourPriceStr}. Nếu trễ trên ${hourThreshold} giờ → tính nguyên 1 ngày.`,
          extraGuest: `Vượt sức chứa tiêu chuẩn (>${room.typeId?.maxAdults || 2} NL hoặc >${room.typeId?.maxChildren || 0} TE) → tính phụ thu theo chính sách giá.`,
        },
      };
    }

    return {
      roomNumber: room.number,
      roomType: room.typeId?.name || '—',
      capacity: `${room.typeId?.maxAdults || 2} NL + ${room.typeId?.maxChildren || 0} TE`,
      beds: room.typeId?.beds || 1,                              // ⭐ MỚI
      maxOccupancy: room.typeId?.maxOccupancy                   // ⭐ MỚI
        || ((room.typeId?.maxAdults || 0) + (room.typeId?.maxChildren || 0)),
      area: room.typeId?.area ? `${room.typeId.area}m²` : null,
      branch: room.branchId?.name || null,
      status,
      statusLabel,
      currentGuest: room.currentGuestName || null,
      currentBooking: currentBookingInfo,
      availabilityCheck,
      pricePolicy,            // ⭐ giá phòng
      branchPolicy,           // ⭐ NEW: giờ chuẩn + phụ thu
      _hint: 'Hiển thị thông tin phòng đầy đủ: số phòng, loại, sức chứa, diện tích, trạng thái. NẾU pricePolicy có → hiển thị giá NGÀY/ĐÊM/GIỜ. NẾU branchPolicy có → hiển thị giờ check-in/check-out chuẩn + tóm tắt phụ thu (CI sớm, CO muộn). Nếu availabilityCheck.isAvailable=true → "Phòng còn trống". Nếu có conflicts → liệt kê khách đang giữ.',
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
    // ⭐ External user: KHÔNG cho tra cứu danh sách booking
    if (!ctx.isInternal) {
      return {
        error: 'external_not_allowed',
        message: 'Khách hàng không thể tra cứu danh sách booking. Anh/chị vui lòng liên hệ lễ tân hoặc cho biết mã đặt phòng cụ thể (BK_XXXXXX) để em tra giúp ạ.',
      };
    }

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
      .select('_id bookingCode customerName customerPhone roomNumber roomType checkIn checkOut status totalAmount paymentStatus nights groupName isGroup branchId')
      .sort({ checkIn: -1 })
      .limit(Math.min(limit, 50))
      .lean();

    // ⭐ FIX 14/05/2026: Format datetime VN timezone (UTC+7) trước khi trả
    const fmtVN = (d) => {
      if (!d) return null;
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return null;
      return dt.toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
        hour12: false,
      });
    };

    return {
      scope: branchId ? 'Theo chi nhánh' : 'Tất cả chi nhánh',
      count: bookings.length,
      bookings: bookings.map(b => ({
        bookingCode: b.bookingCode || `BK_${String(b._id).slice(-6).toUpperCase()}`,
        bookingId: String(b._id),
        customer: b.customerName,
        phone: b.customerPhone,
        room: b.roomNumber,
        roomType: b.roomType,
        branch: b.branchId?.name,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        // ⭐ NEW: dùng các field này để hiển thị cho user
        checkInFormatted:  fmtVN(b.checkIn),
        checkOutFormatted: fmtVN(b.checkOut),
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
  async get_booking_detail({ customerName, roomNumber, bookingId, bookingCode }) {
    if (!customerName && !roomNumber && !bookingId && !bookingCode) {
      return { error: 'Cần ít nhất 1 trong: customerName, roomNumber, bookingId, bookingCode' };
    }

    const q = {};
    if (bookingId && mongoose.Types.ObjectId.isValid(bookingId)) q._id = bookingId;

    // ⭐ Tra cứu theo bookingCode (format DB: BK_XXXXXX)
    //   User có thể gõ:
    //     - "BK_W8X6UE" (full)
    //     - "W8X6UE" (chỉ phần ngẫu nhiên)
    //     - "bk_w8x6ue" (lowercase) → auto convert
    if (bookingCode && !q._id) {
      const raw = String(bookingCode).trim().toUpperCase();
      // Nếu user gõ chỉ phần sau "BK_", auto thêm prefix
      const withPrefix = raw.startsWith('BK_') ? raw : `BK_${raw}`;
      const withoutPrefix = raw.replace(/^BK_/, '');

      q.$or = [
        { bookingCode: raw },              // exact: BK_W8X6UE
        { bookingCode: withPrefix },        // thêm prefix nếu thiếu: BK_W8X6UE
        // partial match: vẫn match được khi user gõ ngắn
        { bookingCode: new RegExp(withoutPrefix + '$', 'i') },
      ];
    }

    if (customerName) q.customerName = new RegExp(customerName, 'i');
    if (roomNumber) {
      q.$or = [
        ...(q.$or || []),
        { roomNumber: String(roomNumber) },
        { 'rooms.roomNumber': String(roomNumber) },
      ];
    }
    if (!q._id && !q.$or) {
      q.status = { $in: ['confirmed', 'reserved', 'checked_in', 'checked_out'] };
    }

    // Non-admin: chỉ thấy booking của branch mình
    if (ctx.role !== 'Admin' && ctx.userBranchId) {
      q.branchId = ctx.userBranchId;
    }

    const b = await Booking.findOne(q)
      .populate('branchId', 'name')
      .sort({ createdAt: -1 })
      .lean();

    if (!b) return { error: 'Không tìm thấy booking phù hợp' };

    // ⭐ FIX 14/05/2026: Format datetime ở VN timezone (UTC+7) trước khi trả về tool.
    //   Trước đây: trả Date object ISO raw → AI tự render bằng toLocaleString JS server,
    //   nhưng node default UTC → kết quả lệch 7h so với giờ user mong đợi.
    //   Giải pháp: format sẵn ở VN timezone, AI chỉ việc hiển thị y nguyên.
    const fmtVN = (d) => {
      if (!d) return null;
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return null;
      // Asia/Ho_Chi_Minh — luôn UTC+7, không daylight saving
      return dt.toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
        hour12: false,
      });
    };

    return {
      // ⭐ MÃ ĐẶT PHÒNG để AI hiển thị cho user
      bookingCode: b.bookingCode || `BK_${String(b._id).slice(-6).toUpperCase()}`,
      bookingId: String(b._id),
      customer: b.customerName,
      phone: b.customerPhone,
      branch: b.branchId?.name,
      room: b.roomNumber,
      roomType: b.roomType,
      isGroup: b.isGroup,
      groupName: b.groupName,
      roomCount: b.isGroup ? (b.rooms?.length || 0) : 1,
      // ⭐ KEEP raw ISO để FE cần tính toán có thể dùng
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      actualCheckIn: b.actualCheckIn,
      actualCheckOut: b.actualCheckOut,
      // ⭐ NEW: Field *Formatted để AI hiển thị TRỰC TIẾP cho user (không tự convert)
      checkInFormatted:       fmtVN(b.checkIn),
      checkOutFormatted:      fmtVN(b.checkOut),
      actualCheckInFormatted:  fmtVN(b.actualCheckIn),
      actualCheckOutFormatted: fmtVN(b.actualCheckOut),
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
        checkInFormatted:  fmtVN(sr.checkIn),
        checkOutFormatted: fmtVN(sr.checkOut),
      })) : undefined,
    };
  },

  // ── 7. Check-in / check-out hôm nay ──
  async get_today_arrivals_departures({ type = 'both', branchName }) {
    // ⭐ External user: KHÔNG cho xem
    if (!ctx.isInternal) {
      return {
        error: 'external_not_allowed',
        message: 'Khách hàng không xem được thông tin nội bộ này ạ.',
      };
    }

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
        .select('_id bookingCode customerName customerPhone roomNumber checkIn status')
        .sort({ checkIn: 1 })
        .lean();

      result.arrivals = {
        count: arrivals.length,
        list: arrivals.map(b => ({
          // ⭐ Mã đặt phòng
          bookingCode: b.bookingCode || `BK_${String(b._id).slice(-6).toUpperCase()}`,
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
        .select('_id bookingCode customerName customerPhone roomNumber checkOut actualCheckOut status totalAmount')
        .sort({ checkOut: 1 })
        .lean();

      result.departures = {
        count: departures.length,
        list: departures.map(b => ({
          // ⭐ Mã đặt phòng
          bookingCode: b.bookingCode || `BK_${String(b._id).slice(-6).toUpperCase()}`,
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

  // ── 7b. Tính phí trả phòng trễ ──
  async calculate_late_checkout_fee({ bookingCode, newCheckoutTime }) {
    if (!bookingCode || !newCheckoutTime) {
      return { error: 'Cần bookingCode + newCheckoutTime (HH:mm)' };
    }

    // Parse "14:00" → { hour: 14, minute: 0 }
    const timeMatch = String(newCheckoutTime).match(/^(\d{1,2}):(\d{1,2})$/);
    if (!timeMatch) {
      return { error: 'Giờ không hợp lệ. Format: HH:mm (vd "14:00")' };
    }
    const newHour = parseInt(timeMatch[1], 10);
    const newMinute = parseInt(timeMatch[2], 10);
    if (newHour < 0 || newHour > 23 || newMinute < 0 || newMinute > 59) {
      return { error: 'Giờ không hợp lệ' };
    }

    // Tìm booking
    const raw = String(bookingCode).trim().toUpperCase();
    const withPrefix = raw.startsWith('BK_') ? raw : `BK_${raw}`;
    const withoutPrefix = raw.replace(/^BK_/, '');

    const findQuery = {
      $or: [
        { bookingCode: raw },
        { bookingCode: withPrefix },
        { bookingCode: new RegExp(withoutPrefix + '$', 'i') },
      ],
      status: { $in: ['confirmed', 'reserved', 'checked_in'] },
    };
    if (!ctx.isInternal) {
      // External: không cho query booking khác, cần thêm bước xác minh SĐT (skip ở đây)
      return {
        error: 'external_not_allowed',
        message: 'Để tính phí trả phòng trễ, anh/chị vui lòng liên hệ lễ tân hoặc đăng nhập tài khoản nội bộ ạ.',
      };
    }
    if (ctx.role !== 'Admin' && ctx.userBranchId) {
      findQuery.branchId = ctx.userBranchId;
    }

    const booking = await Booking.findOne(findQuery)
      .populate('branchId', 'name checkOutTime toleranceMinutes hourToDayThreshold dayEquivalentHours')
      .lean();

    if (!booking) {
      return { error: 'Không tìm thấy booking với mã ' + raw };
    }

    // Lấy giờ trả chuẩn
    const standardCO = new Date(booking.checkOut);

    // Build giờ trả mới — cùng ngày với standardCO
    const newCO = new Date(standardCO);
    newCO.setHours(newHour, newMinute, 0, 0);

    // Nếu newCO < standardCO → user muốn trả SỚM HƠN, không phải trễ
    if (newCO.getTime() <= standardCO.getTime()) {
      return {
        bookingCode: booking.bookingCode || `BK_${String(booking._id).slice(-6).toUpperCase()}`,
        standardCheckOut: standardCO,
        newCheckOut: newCO,
        isEarlier: true,
        message: 'Giờ trả mới sớm hơn hoặc bằng giờ chuẩn, không phát sinh phí trả trễ.',
      };
    }

    // Tính chênh lệch giờ
    const diffMs = newCO.getTime() - standardCO.getTime();
    const diffHours = diffMs / (60 * 60 * 1000);
    const diffMinutes = Math.round(diffMs / 60000);

    // Lấy policy giá theo loại phòng
    let hourPrice = 0;
    let dayPrice = 0;
    let policyName = '';

    if (booking.roomId) {
      const room = await Room.findById(booking.roomId).lean();
      if (room?.typeId) {
        const policy = await PricePolicy.findOne({
          roomTypeId: room.typeId,
          branchId: booking.branchId?._id || booking.branchId,
          isActive: true,
        })
          .sort({ displayOrder: 1 })
          .lean();
        if (policy) {
          hourPrice = policy.hourPrice || 0;
          dayPrice = policy.dayPrice || 0;
          policyName = policy.name;
        }
      }
    }

    // Logic tính phí trả trễ (theo branch config)
    const branch = booking.branchId;
    const tolerance = branch?.toleranceMinutes || 30;        // miễn phí trong khoảng dung sai
    const hourThreshold = branch?.hourToDayThreshold || 6;   // nếu trễ > X giờ → tính nguyên ngày
    const dayEquivHours = branch?.dayEquivalentHours || 24;

    let fee = 0;
    let calcMethod = '';
    const effectiveLateMinutes = Math.max(0, diffMinutes - tolerance);
    const effectiveLateHours = effectiveLateMinutes / 60;

    if (effectiveLateMinutes <= 0) {
      fee = 0;
      calcMethod = `Trễ ${diffMinutes} phút (trong dung sai ${tolerance} phút) — miễn phí`;
    } else if (effectiveLateHours > hourThreshold) {
      // Trễ quá nhiều → tính nguyên 1 ngày
      fee = dayPrice;
      calcMethod = `Trễ ${effectiveLateHours.toFixed(1)} giờ (> ngưỡng ${hourThreshold} giờ) — tính phí 1 ngày`;
    } else {
      // Tính theo giờ
      fee = Math.ceil(effectiveLateHours) * hourPrice;
      calcMethod = `Trễ ${effectiveLateHours.toFixed(1)} giờ × ${hourPrice}đ/giờ`;
    }

    return {
      bookingCode: booking.bookingCode || `BK_${String(booking._id).slice(-6).toUpperCase()}`,
      customer: booking.customerName,
      roomNumber: ctx.isInternal ? booking.roomNumber : undefined,
      roomType: booking.roomType,
      standardCheckOut: standardCO,
      standardCheckOutFormatted: standardCO.toLocaleString('vi-VN', { hour12: false }),
      newCheckOut: newCO,
      newCheckOutFormatted: newCO.toLocaleString('vi-VN', { hour12: false }),
      lateHours: Number(diffHours.toFixed(2)),
      lateMinutes: diffMinutes,
      toleranceMinutes: tolerance,
      effectiveLateMinutes,
      hourPrice,
      hourPriceFormatted: fmt(hourPrice),
      dayPrice,
      dayPriceFormatted: fmt(dayPrice),
      policyName,
      fee,
      feeFormatted: fmt(fee),
      calcMethod,
      currentTotal: fmt(booking.totalAmount || 0),
      newTotal: fmt((booking.totalAmount || 0) + fee),
      _hint: 'Hiển thị cho user: giờ chuẩn, giờ mới, số giờ trễ, cách tính, phí phụ thu, tổng mới. Đề xuất "anh/chị có muốn em ghi nhận để báo lễ tân không?"',
    };
  },

  // ════════════════════════════════════════════════════
  // ── 7c. AI TỰ ĐẶT PHÒNG — 2 BƯỚC ──
  // ════════════════════════════════════════════════════
  //   BƯỚC 1: prepare_booking_confirmation — preview, KHÔNG tạo
  //   BƯỚC 2: create_booking — tạo thật (chỉ khi confirmed=true)
  // ════════════════════════════════════════════════════

  async prepare_booking_confirmation({
    customerName, customerPhone, checkIn, checkOut,
    roomNumber, roomTypeName, adults = 2, children = 0,
    priceType = 'day', notes = '',
  }) {
    if (!ctx.isInternal) {
      return {
        error: 'external_not_allowed',
        message: 'Khách hàng không thể đặt phòng trực tiếp qua chat ạ. Anh/chị vui lòng để lại SĐT, lễ tân sẽ liên hệ chốt giúp ạ.',
      };
    }

    // Validate input
    if (!customerName?.trim()) return { error: 'Thiếu tên khách' };
    if (!customerPhone?.trim()) return { error: 'Thiếu SĐT' };
    if (!checkIn || !checkOut) return { error: 'Thiếu ngày check-in/check-out' };
    if (!roomNumber?.toString().trim() && !roomTypeName?.trim()) {
      return { error: 'Cần ít nhất 1: roomNumber HOẶC roomTypeName' };
    }

    let ci = new Date(checkIn);
    let co = new Date(checkOut);
    if (isNaN(ci.getTime()) || isNaN(co.getTime())) {
      return { error: 'Ngày không hợp lệ (cần ISO format)' };
    }

    // Tìm branchId trước (để lấy giờ chuẩn nếu cần)
    let branchId = ctx.userBranchId;
    if (!branchId && ctx.role === 'Admin') {
      const firstBranch = await Branch.findOne().lean();
      branchId = firstBranch?._id;
    }
    if (!branchId) {
      return { error: 'Không xác định được chi nhánh' };
    }

    // ⭐ FIX: Tự gán giờ chuẩn của khách sạn nếu user chỉ truyền NGÀY (không giờ)
    //   Tránh AI bịa "Nhận phòng sớm X giờ" khi parse "2026-05-14" → 00:00
    const branchForTime = await Branch.findById(branchId).lean();
    const ciTimeStr = branchForTime?.checkInTime || '14:00';
    const coTimeStr = branchForTime?.checkOutTime || '12:00';
    const isOnlyDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
    const setTime = (date, hhmm) => {
      const [h, m] = String(hhmm).split(':').map(Number);
      const d = new Date(date);
      d.setHours(h || 14, m || 0, 0, 0);
      return d;
    };
    if (isOnlyDate(checkIn)) ci = setTime(checkIn + 'T00:00:00', ciTimeStr);
    if (isOnlyDate(checkOut)) co = setTime(checkOut + 'T00:00:00', coTimeStr);
    if (!isOnlyDate(checkIn) && ci.getHours() === 0 && ci.getMinutes() === 0) ci = setTime(ci, ciTimeStr);
    if (!isOnlyDate(checkOut) && co.getHours() === 0 && co.getMinutes() === 0) co = setTime(co, coTimeStr);

    if (co <= ci) return { error: 'Check-out phải sau check-in' };

    let availableRoom = null;
    let roomType = null;

    // ═══════════════════════════════════════════════
    // CÁCH A: User chỉ định SỐ PHÒNG cụ thể
    // ═══════════════════════════════════════════════
    if (roomNumber?.toString().trim()) {
      const numClean = String(roomNumber).trim();
      const room = await Room.findOne({
        number: numClean,
        branchId,
      }).populate('typeId').lean();

      if (!room) {
        return {
          error: 'room_not_found',
          message: `Không tìm thấy phòng số "${numClean}" tại chi nhánh này ạ.`,
        };
      }
      if (room.roomStatus === 'maintenance') {
        return {
          error: 'room_under_maintenance',
          message: `Phòng ${numClean} đang bảo trì ạ. Anh/chị chọn phòng khác giúp em nhé?`,
        };
      }
      if (room.roomStatus === 'inactive') {
        return {
          error: 'room_inactive',
          message: `Phòng ${numClean} hiện không hoạt động. Anh/chị chọn phòng khác giúp em ạ.`,
        };
      }

      // Check conflict
      const conflict = await Booking.findOne({
        $or: [{ roomId: room._id }, { 'rooms.roomId': room._id }],
        status: { $in: ['confirmed', 'reserved', 'checked_in'] },
        checkIn: { $lt: co },
        checkOut: { $gt: ci },
      }).select('customerName checkIn checkOut status').lean();

      if (conflict) {
        return {
          error: 'room_busy',
          message: `Phòng ${numClean} đã có khách ${conflict.customerName} đặt từ ${new Date(conflict.checkIn).toLocaleString('vi-VN')} đến ${new Date(conflict.checkOut).toLocaleString('vi-VN')}. Anh/chị chọn phòng khác hoặc đổi giờ nhé?`,
          conflict: {
            customer: conflict.customerName,
            checkIn: conflict.checkIn,
            checkOut: conflict.checkOut,
          },
        };
      }

      availableRoom = room;
      roomType = room.typeId;
    }
    // ═══════════════════════════════════════════════
    // CÁCH B: User chỉ chọn LOẠI PHÒNG
    // ═══════════════════════════════════════════════
    else {
      const typeNameNorm = roomTypeName.trim().toLowerCase().replace(/\s+/g, ' ');
      const allTypes = await RoomType.find({}).lean();
      roomType = allTypes.find(t => {
        const dbName = String(t.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
        return dbName === typeNameNorm;
      });
      if (!roomType) {
        roomType = allTypes.find(t => {
          const dbName = String(t.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
          return dbName.includes(typeNameNorm) || typeNameNorm.includes(dbName);
        });
      }
      if (!roomType) {
        return {
          error: 'room_type_not_found',
          message: `Không tìm thấy loại phòng "${roomTypeName}". Các loại phòng hiện có: ${allTypes.map(t => t.name).join(', ')}`,
          availableTypes: allTypes.map(t => t.name),
        };
      }

      // Tìm 1 phòng trống cùng loại
      const roomsOfType = await Room.find({
        typeId: roomType._id,
        branchId,
        roomStatus: 'active',
      }).populate('typeId').lean();

      if (roomsOfType.length === 0) {
        return {
          error: 'no_rooms_of_type',
          message: `Hiện chưa có phòng loại "${roomType.name}" tại chi nhánh này ạ.`,
        };
      }

      for (const room of roomsOfType) {
        const conflict = await Booking.findOne({
          $or: [{ roomId: room._id }, { 'rooms.roomId': room._id }],
          status: { $in: ['confirmed', 'reserved', 'checked_in'] },
          checkIn: { $lt: co },
          checkOut: { $gt: ci },
        }).lean();
        if (!conflict) {
          availableRoom = room;
          break;
        }
      }

      if (!availableRoom) {
        return {
          error: 'all_rooms_busy',
          message: `Toàn bộ phòng loại "${roomType.name}" đã được đặt trong khoảng thời gian này ạ. Anh/chị thử chọn loại khác hoặc đổi ngày.`,
        };
      }
    }

    // ═══════════════════════════════════════════════
    // Tính giá
    // ═══════════════════════════════════════════════
    const branch = await Branch.findById(branchId).lean();
    const policy = await PricePolicy.findOne({
      roomTypeId: roomType._id,
      branchId,
      isActive: true,
    }).lean();

    const priceResult = calculatePrice({
      checkIn: ci,
      checkOut: co,
      priceType,
      policy,
      branch,
      adults,
      children,
      maxAdults: roomType.maxAdults || roomType.capacity || 2,
      maxChildren: roomType.maxChildren || 0,
      maxOccupancy: roomType.maxOccupancy || ((roomType.maxAdults || roomType.capacity || 2) + (roomType.maxChildren || 0)),
    });

    if (priceResult.error) {
      return {
        error: 'price_calc_error',
        message: priceResult.error.message || 'Không tính được giá',
      };
    }

    const nights = priceResult.nights;
    const roomAmount = priceResult.roomAmount;

    const formatDateTime = (d) => new Date(d).toLocaleString('vi-VN', { hour12: false });

    return {
      _previewOnly: true,
      _selectionMode: roomNumber ? 'by_room_number' : 'by_room_type',
      summary: {
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        roomNumber: availableRoom.number,
        roomType: roomType.name,
        capacity: `${roomType.maxAdults || roomType.capacity || 2} NL + ${roomType.maxChildren || 0} TE`,
        area: roomType.area ? `${roomType.area}m²` : null,
        checkIn: ci,
        checkInFormatted: formatDateTime(ci),
        checkOut: co,
        checkOutFormatted: formatDateTime(co),
        nights,
        adults,
        children,
        priceType: priceResult.finalPriceType,
        roomAmount,
        roomAmountFormatted: fmt(roomAmount),
        breakdown: priceResult.breakdown,
        totalAmount: roomAmount,
        totalAmountFormatted: fmt(roomAmount),
        branch: branch?.name,
        notes: notes?.trim() || null,
      },
      _hint: 'ĐÂY LÀ PREVIEW. HIỂN THỊ cho user toàn bộ thông tin trong summary để xác nhận. SAU ĐÓ phải hỏi: "Anh/chị xác nhận chốt đặt phòng nhé?". CHỈ gọi create_booking khi user trả lời rõ ràng "ok", "chốt", "đặt đi", "xác nhận", "đồng ý".',
    };
  },

  async create_booking({
    customerName, customerPhone, checkIn, checkOut,
    roomNumber, roomTypeName, adults = 2, children = 0,
    priceType = 'day', notes = '',
    confirmed = false,
  }) {
    // ═══════════════════════════════════
    // GUARD 1: Internal only
    // ═══════════════════════════════════
    if (!ctx.isInternal) {
      return {
        error: 'external_not_allowed',
        message: 'Khách hàng không thể đặt phòng trực tiếp qua chat ạ.',
      };
    }

    // ═══════════════════════════════════
    // GUARD 2: Bắt buộc confirmed=true
    // ═══════════════════════════════════
    if (!confirmed) {
      return {
        error: 'not_confirmed',
        message: 'Cần user xác nhận rõ ràng trước khi tạo booking. Hãy gọi prepare_booking_confirmation trước, hỏi user xác nhận, rồi mới gọi create_booking với confirmed=true.',
      };
    }

    // ═══════════════════════════════════
    // Validate
    // ═══════════════════════════════════
    if (!customerName?.trim() || !customerPhone?.trim() || !checkIn || !checkOut) {
      return { error: 'Thiếu thông tin bắt buộc' };
    }
    if (!roomNumber?.toString().trim() && !roomTypeName?.trim()) {
      return { error: 'Cần ít nhất 1: roomNumber HOẶC roomTypeName' };
    }

    let ci = new Date(checkIn);
    let co = new Date(checkOut);
    if (isNaN(ci.getTime()) || isNaN(co.getTime())) return { error: 'Ngày không hợp lệ' };

    // ═══════════════════════════════════
    // Tìm branchId (cần trước để lấy giờ chuẩn)
    // ═══════════════════════════════════
    let branchId = ctx.userBranchId;
    if (!branchId && ctx.role === 'Admin') {
      const firstBranch = await Branch.findOne();
      branchId = firstBranch?._id;
    }
    if (!branchId) return { error: 'no_branch', message: 'Không xác định được chi nhánh' };

    // ⭐ FIX: Tự gán giờ chuẩn nếu user chỉ truyền NGÀY (không giờ)
    const branchForTime = await Branch.findById(branchId).lean();
    const ciTimeStr = branchForTime?.checkInTime || '14:00';
    const coTimeStr = branchForTime?.checkOutTime || '12:00';
    const isOnlyDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
    const setTime = (date, hhmm) => {
      const [h, m] = String(hhmm).split(':').map(Number);
      const d = new Date(date);
      d.setHours(h || 14, m || 0, 0, 0);
      return d;
    };
    if (isOnlyDate(checkIn)) ci = setTime(checkIn + 'T00:00:00', ciTimeStr);
    if (isOnlyDate(checkOut)) co = setTime(checkOut + 'T00:00:00', coTimeStr);
    if (!isOnlyDate(checkIn) && ci.getHours() === 0 && ci.getMinutes() === 0) ci = setTime(ci, ciTimeStr);
    if (!isOnlyDate(checkOut) && co.getHours() === 0 && co.getMinutes() === 0) co = setTime(co, coTimeStr);

    if (co <= ci) return { error: 'Check-out phải sau check-in' };

    const now = new Date();
    const tolerance = 60 * 1000;
    if (ci.getTime() < now.getTime() - tolerance) {
      return {
        error: 'INVALID_PAST_CHECKIN',
        message: `Không thể đặt phòng với giờ nhận phòng (${ci.toLocaleString('vi-VN')}) đã qua ạ.`,
      };
    }
    if (co.getTime() < now.getTime() - tolerance) {
      return {
        error: 'INVALID_PAST_CHECKOUT',
        message: `Không thể đặt phòng với giờ trả phòng (${co.toLocaleString('vi-VN')}) đã qua ạ.`,
      };
    }

    let availableRoom = null;
    let roomType = null;

    // ═══════════════════════════════════
    // CÁCH A: User chỉ định SỐ PHÒNG
    // ═══════════════════════════════════
    if (roomNumber?.toString().trim()) {
      const numClean = String(roomNumber).trim();
      const room = await Room.findOne({
        number: numClean,
        branchId,
      }).populate('typeId');

      if (!room) {
        return { error: 'room_not_found', message: `Không tìm thấy phòng số "${numClean}"` };
      }
      if (room.roomStatus !== 'active') {
        return {
          error: 'room_unavailable',
          message: `Phòng ${numClean} hiện không khả dụng (${room.roomStatus}).`,
        };
      }

      // Re-check conflict (RACE CONDITION protection)
      const conflict = await Booking.findOne({
        $or: [{ roomId: room._id }, { 'rooms.roomId': room._id }],
        status: { $in: ['confirmed', 'reserved', 'checked_in'] },
        checkIn: { $lt: co },
        checkOut: { $gt: ci },
      });
      if (conflict) {
        return {
          error: 'room_busy',
          message: `Phòng ${numClean} vừa bị đặt mất. Anh/chị thử lại với phòng khác ạ.`,
        };
      }

      availableRoom = room;
      roomType = room.typeId;
    }
    // ═══════════════════════════════════
    // CÁCH B: User chỉ chọn LOẠI PHÒNG — tự tìm phòng trống
    // ═══════════════════════════════════
    else {
      const typeNameNorm2 = roomTypeName.trim().toLowerCase().replace(/\s+/g, ' ');
      const allTypes2 = await RoomType.find({});
      roomType = allTypes2.find(t => {
        const dbName = String(t.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
        return dbName === typeNameNorm2;
      });
      if (!roomType) {
        roomType = allTypes2.find(t => {
          const dbName = String(t.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
          return dbName.includes(typeNameNorm2) || typeNameNorm2.includes(dbName);
        });
      }
      if (!roomType) {
        return { error: 'room_type_not_found', message: `Không tìm thấy loại phòng "${roomTypeName}"` };
      }

      const roomsOfType = await Room.find({
        typeId: roomType._id,
        branchId,
        roomStatus: 'active',
      }).populate('typeId');

      for (const room of roomsOfType) {
        const conflict = await Booking.findOne({
          $or: [{ roomId: room._id }, { 'rooms.roomId': room._id }],
          status: { $in: ['confirmed', 'reserved', 'checked_in'] },
          checkIn: { $lt: co },
          checkOut: { $gt: ci },
        });
        if (!conflict) {
          availableRoom = room;
          break;
        }
      }

      if (!availableRoom) {
        return {
          error: 'all_rooms_busy',
          message: `Phòng loại "${roomType.name}" vừa bị đặt hết. Anh/chị thử lại với loại khác ạ.`,
        };
      }
    }

    // ═══════════════════════════════════
    // Tính giá
    // ═══════════════════════════════════
    const branch = await Branch.findById(branchId);
    const policy = await PricePolicy.findOne({
      roomTypeId: roomType._id,
      branchId,
      isActive: true,
    });

    const priceResult = calculatePrice({
      checkIn: ci,
      checkOut: co,
      priceType,
      policy,
      branch,
      adults,
      children,
      maxAdults: roomType.maxAdults || roomType.capacity || 2,
      maxChildren: roomType.maxChildren || 0,
      maxOccupancy: roomType.maxOccupancy || ((roomType.maxAdults || roomType.capacity || 2) + (roomType.maxChildren || 0)),
    });

    if (priceResult.error) {
      return { error: 'price_calc_error', message: priceResult.error.message };
    }

    const roomAmount = priceResult.roomAmount;
    const totalAmount = roomAmount;     // discount=0 mặc định cho AI booking

    // ═══════════════════════════════════
    // Tạo/tìm Customer (theo phone)
    // ═══════════════════════════════════
    const phoneClean = customerPhone.trim();
    let customer = await Customer.findOne({ phone: phoneClean });
    if (!customer) {
      customer = await Customer.create({
        name: customerName.trim(),
        phone: phoneClean,
      });
    }

    // ═══════════════════════════════════
    // Tạo Booking — copy theo controller create()
    // ═══════════════════════════════════
    let booking;
    try {
      booking = await Booking.create({
        customerId: customer._id,
        customerName: customerName.trim(),
        customerPhone: phoneClean,
        roomId: availableRoom._id,
        roomNumber: availableRoom.number,
        roomType: availableRoom.typeName || roomType.name,
        branchId,
        checkIn: ci,
        checkOut: co,
        nights: priceResult.nights,
        priceType: priceResult.finalPriceType,
        adults,
        children,
        notes: notes?.trim() || `[AI Chat] Tạo bởi ${ctx.role}`,
        source: 'AI Chat',           // ⭐ Đánh dấu nguồn để track
        discount: 0,
        discountPercent: 0,
        discountAmount: 0,
        isFreeRoom: false,
        roomAmount,
        totalAmount,
        servicesAmount: 0,
        priceBreakdown: priceResult.breakdown,
        policyId: policy?._id ?? null,
        policyName: policy?.name ?? '',
        policySnapshot: policy ? buildPolicySnapshot(policy, roomType.capacity ?? null) : null,
        status: 'reserved',           // ⭐ Mặc định đặt trước (không tự check-in)
        actualCheckIn: null,
      });
    } catch (e) {
      console.error('[create_booking] error:', e);
      return {
        error: 'db_error',
        message: 'Không tạo được booking: ' + e.message,
      };
    }

    // Update Room
    try {
      await Room.findByIdAndUpdate(availableRoom._id, {
        currentBookingId: booking._id,
        currentGuestName: customerName.trim(),
      });
    } catch (e) {
      console.warn('[create_booking] update room failed (non-fatal):', e.message);
    }

    // Audit log
    try {
      await logAction({
        entityType: 'Booking',
        entityId: booking._id,
        action: 'create',
        description: `[AI Chat] Tạo đặt phòng ${availableRoom.number} cho ${customerName}`,
        user: { id: ctx.userId, role: ctx.role, _id: ctx.userId },
        branchId,
        metadata: {
          source: 'AI Chat',
          roomNumber: availableRoom.number,
          customerName,
          checkIn: ci,
          checkOut: co,
          totalAmount,
          createdByAI: true,
        },
      });
    } catch (e) {
      console.warn('[create_booking] audit log failed (non-fatal):', e.message);
    }

    // ═══════════════════════════════════
    // Trả kết quả thành công
    // ═══════════════════════════════════
    const finalBookingCode = booking.bookingCode || `BK_${String(booking._id).slice(-6).toUpperCase()}`;
    return {
      success: true,
      bookingCode: finalBookingCode,
      bookingId: String(booking._id),
      customerName,
      customerPhone: phoneClean,
      roomNumber: availableRoom.number,
      roomType: roomType.name,
      checkIn: ci,
      checkInFormatted: ci.toLocaleString('vi-VN', { hour12: false }),
      checkOut: co,
      checkOutFormatted: co.toLocaleString('vi-VN', { hour12: false }),
      nights: priceResult.nights,
      adults,
      children,
      totalAmount,
      totalAmountFormatted: fmt(totalAmount),
      status: 'reserved',
      branch: branch?.name,
      _hint: 'BOOKING ĐÃ TẠO THÀNH CÔNG. Hiển thị bookingCode + thông tin cho user với tone vui mừng. Kết thúc bằng "Anh/chị cần em hỗ trợ thêm gì không ạ?"',
    };
  },
  // ════════════════════════════════════════════════════════════
// PHẦN B — HANDLERS (thêm vào makeHandlers, sau 'create_booking')
// ════════════════════════════════════════════════════════════
 
  // ── 7d. PREPARE CHECKIN — Preview, không check-in thật ──
  async prepare_checkin({ bookingCode, roomNumber, customerName }) {
    if (!ctx.isInternal) {
      return {
        error: 'external_not_allowed',
        message: 'Khách hàng không thể tự check-in qua chat ạ.',
      };
    }
 
    // Tìm booking
    let booking = null;
    if (bookingCode) {
      const raw = String(bookingCode).trim().toUpperCase();
      const withPrefix = raw.startsWith('BK_') ? raw : `BK_${raw}`;
      const withoutPrefix = raw.replace(/^BK_/, '');
      const q = {
        $or: [
          { bookingCode: raw },
          { bookingCode: withPrefix },
          { bookingCode: new RegExp(withoutPrefix + '$', 'i') },
        ],
      };
      if (ctx.role !== 'Admin' && ctx.userBranchId) {
        q.branchId = ctx.userBranchId;
      }
      booking = await Booking.findOne(q)
        .populate('branchId', 'name')
        .populate('roomId', 'number typeId')
        .lean();
    } else if (roomNumber) {
      // Fallback: tìm theo số phòng + tên khách
      const numClean = String(roomNumber).trim();
      const q = {
        roomNumber: numClean,
        status: { $in: ['reserved', 'confirmed'] },
      };
      if (customerName) {
        q.customerName = new RegExp(customerName.trim(), 'i');
      }
      if (ctx.role !== 'Admin' && ctx.userBranchId) {
        q.branchId = ctx.userBranchId;
      }
      booking = await Booking.findOne(q)
        .populate('branchId', 'name')
        .populate('roomId', 'number typeId')
        .sort({ checkIn: 1 })
        .lean();
    }
 
    if (!booking) {
      return {
        error: 'not_found',
        message: `Không tìm thấy booking phù hợp${bookingCode ? ` với mã ${bookingCode}` : ''}.`,
      };
    }
 
    // Check status
    if (booking.status === 'checked_in') {
      return {
        error: 'already_checked_in',
        message: `Booking ${booking.bookingCode || ''} đã check-in rồi ạ (lúc ${new Date(booking.actualCheckIn).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })}).`,
      };
    }
    if (booking.status === 'checked_out') {
      return {
        error: 'already_checked_out',
        message: `Booking ${booking.bookingCode || ''} đã check-out rồi ạ.`,
      };
    }
    if (booking.status === 'cancelled') {
      return {
        error: 'cancelled',
        message: `Booking ${booking.bookingCode || ''} đã bị hủy ạ.`,
      };
    }
    if (!['reserved', 'confirmed'].includes(booking.status)) {
      return {
        error: 'invalid_status',
        message: `Booking đang ở trạng thái "${booking.status}" — không thể check-in.`,
      };
    }
 
    // Tính chênh lệch giờ check-in
    const now = new Date();
    const scheduledCI = new Date(booking.checkIn);
    const diffMs = now.getTime() - scheduledCI.getTime();
    const diffMinutes = Math.round(diffMs / 60000);
    const diffHours = (diffMinutes / 60).toFixed(1);
 
    let timingNote = '';
    let isEarly = false;
    if (diffMinutes < -15) {
      isEarly = true;
      const earlyHours = Math.abs(diffMinutes / 60).toFixed(1);
      timingNote = `Khách đến sớm hơn ${earlyHours} giờ so với giờ chuẩn.`;
    } else if (diffMinutes > 60) {
      timingNote = `Khách đến trễ ${diffHours} giờ so với giờ đặt.`;
    } else {
      timingNote = 'Khách đến đúng giờ.';
    }
 
    const fmtVN = (d) => new Date(d).toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
 
    return {
      _previewOnly: true,
      summary: {
        bookingCode: booking.bookingCode || `BK_${String(booking._id).slice(-6).toUpperCase()}`,
        customerName: booking.customerName,
        customerPhone: booking.customerPhone,
        roomNumber: booking.roomNumber,
        roomType: booking.roomType,
        adults: booking.adults,
        children: booking.children,
        nights: booking.nights,
        scheduledCheckIn: booking.checkIn,
        scheduledCheckInFormatted: fmtVN(booking.checkIn),
        actualCheckInTime: now,
        actualCheckInFormatted: fmtVN(now),
        timingNote,
        isEarly,
        diffMinutes,
        totalAmount: booking.totalAmount,
        totalAmountFormatted: fmt(booking.totalAmount || 0),
        currentStatus: booking.status,
        branch: booking.branchId?.name,
      },
      _hint: 'ĐÂY LÀ PREVIEW. Hiển thị thông tin cho user xác nhận. Nếu isEarly=true → nhắc admin về CI sớm có thể phụ thu (xem chính sách). PHẢI hỏi "Anh/chị xác nhận check-in giúp em nhé?" trước khi gọi confirm_checkin.',
    };
  },
 
  // ── 7e. CONFIRM CHECKIN — Thực hiện check-in thật ──
  async confirm_checkin({ bookingCode, confirmed, notes }) {
    if (!ctx.isInternal) {
      return { error: 'external_not_allowed', message: 'Khách hàng không thể check-in qua chat.' };
    }
    if (!confirmed) {
      return {
        error: 'not_confirmed',
        message: 'Phải gọi prepare_checkin trước + user xác nhận, rồi mới gọi confirm_checkin với confirmed=true.',
      };
    }
    if (!bookingCode) {
      return { error: 'missing_code', message: 'Thiếu bookingCode' };
    }
 
    const raw = String(bookingCode).trim().toUpperCase();
    const withPrefix = raw.startsWith('BK_') ? raw : `BK_${raw}`;
    const withoutPrefix = raw.replace(/^BK_/, '');
    const q = {
      $or: [
        { bookingCode: raw },
        { bookingCode: withPrefix },
        { bookingCode: new RegExp(withoutPrefix + '$', 'i') },
      ],
    };
    if (ctx.role !== 'Admin' && ctx.userBranchId) {
      q.branchId = ctx.userBranchId;
    }
 
    const booking = await Booking.findOne(q);
    if (!booking) {
      return { error: 'not_found', message: `Không tìm thấy booking ${bookingCode}` };
    }
    if (booking.status === 'checked_in') {
      return { error: 'already_checked_in', message: 'Booking đã check-in rồi.' };
    }
    if (!['reserved', 'confirmed'].includes(booking.status)) {
      return { error: 'invalid_status', message: `Booking trạng thái "${booking.status}" không thể check-in.` };
    }
 
    // Thực hiện check-in
    const now = new Date();
    try {
      booking.status = 'checked_in';
      booking.actualCheckIn = now;
      if (notes?.trim()) {
        booking.notes = (booking.notes || '') + `\n[AI Chat CI ${now.toLocaleString('vi-VN')}] ${notes.trim()}`;
      }
      await booking.save();
 
      // Update Room.currentBookingId nếu chưa có
      if (booking.roomId) {
        await Room.findByIdAndUpdate(booking.roomId, {
          currentBookingId: booking._id,
          currentGuestName: booking.customerName,
        });
      }
 
      // Audit log
      try {
        await logAction({
          entityType: 'Booking',
          entityId: booking._id,
          action: 'check_in',
          description: `[AI Chat] Check-in ${booking.roomNumber} cho ${booking.customerName}`,
          user: { id: ctx.userId, role: ctx.role, _id: ctx.userId },
          branchId: booking.branchId,
          metadata: {
            source: 'AI Chat',
            bookingCode: booking.bookingCode,
            roomNumber: booking.roomNumber,
            customerName: booking.customerName,
            actualCheckIn: now,
            createdByAI: true,
          },
        });
      } catch (e) {
        console.warn('[confirm_checkin] audit log failed:', e.message);
      }
 
      const fmtVN = (d) => new Date(d).toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
 
      return {
        success: true,
        bookingCode: booking.bookingCode || `BK_${String(booking._id).slice(-6).toUpperCase()}`,
        customerName: booking.customerName,
        roomNumber: booking.roomNumber,
        actualCheckIn: now,
        actualCheckInFormatted: fmtVN(now),
        status: 'checked_in',
        _hint: 'CHECK-IN THÀNH CÔNG. Hiển thị tone vui mừng kèm thông tin. Kết thúc "Anh/chị cần em hỗ trợ thêm gì không ạ?"',
      };
    } catch (err) {
      console.error('[confirm_checkin] error:', err);
      return { error: 'db_error', message: 'Không check-in được: ' + err.message };
    }
  },
 
  // ── 7f. PREPARE CANCELLATION — Preview hủy phòng (Admin only) ──
  async prepare_cancellation({ bookingCode }) {
    // ⭐ CHỈ ADMIN
    if (ctx.role !== 'Admin') {
      return {
        error: 'forbidden',
        message: 'Hủy phòng chỉ dành cho Admin ạ. Anh/chị liên hệ Admin để xử lý.',
      };
    }
    if (!bookingCode) {
      return { error: 'missing_code', message: 'Cần bookingCode' };
    }
 
    const raw = String(bookingCode).trim().toUpperCase();
    const withPrefix = raw.startsWith('BK_') ? raw : `BK_${raw}`;
    const withoutPrefix = raw.replace(/^BK_/, '');
    const q = {
      $or: [
        { bookingCode: raw },
        { bookingCode: withPrefix },
        { bookingCode: new RegExp(withoutPrefix + '$', 'i') },
      ],
    };
 
    const booking = await Booking.findOne(q)
      .populate('branchId', 'name')
      .lean();
 
    if (!booking) {
      return { error: 'not_found', message: `Không tìm thấy booking ${bookingCode}` };
    }
    if (booking.status === 'cancelled') {
      return { error: 'already_cancelled', message: 'Booking này đã bị hủy rồi.' };
    }
    if (booking.status === 'checked_out') {
      return {
        error: 'already_checked_out',
        message: 'Booking đã check-out, không thể hủy. Nếu cần hoàn tiền, liên hệ kế toán ạ.',
      };
    }
    if (booking.status === 'checked_in') {
      return {
        error: 'currently_checked_in',
        message: 'Khách đang ở phòng — không thể hủy. Phải check-out trước rồi mới xử lý hoàn tiền ạ.',
      };
    }
 
    // Tính thông tin: có phụ thu hủy không, đã thanh toán bao nhiêu
    const now = new Date();
    const scheduledCI = new Date(booking.checkIn);
    const hoursToCI = (scheduledCI.getTime() - now.getTime()) / 3600000;
 
    const fmtVN = (d) => new Date(d).toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
 
    return {
      _previewOnly: true,
      summary: {
        bookingCode: booking.bookingCode || `BK_${String(booking._id).slice(-6).toUpperCase()}`,
        customerName: booking.customerName,
        customerPhone: booking.customerPhone,
        roomNumber: booking.roomNumber,
        roomType: booking.roomType,
        scheduledCheckIn: booking.checkIn,
        scheduledCheckInFormatted: fmtVN(booking.checkIn),
        scheduledCheckOut: booking.checkOut,
        scheduledCheckOutFormatted: fmtVN(booking.checkOut),
        nights: booking.nights,
        totalAmount: booking.totalAmount,
        totalAmountFormatted: fmt(booking.totalAmount || 0),
        paidAmount: booking.paidAmount || 0,
        paidAmountFormatted: fmt(booking.paidAmount || 0),
        currentStatus: booking.status,
        hoursToCheckIn: Math.round(hoursToCI * 10) / 10,
        branch: booking.branchId?.name,
      },
      _hint: `ĐÂY LÀ PREVIEW HỦY PHÒNG. Hiển thị đầy đủ thông tin cho admin xem. Lưu ý:
- Nếu paidAmount > 0 → nhắc "khách đã thanh toán {paidAmount}, cần xử lý hoàn tiền"
- Nếu hoursToCheckIn < 24 → nhắc "còn dưới 24h tới giờ check-in"
PHẢI HỎI: "Anh xác nhận hủy booking này không? Vui lòng cho em biết LÝ DO hủy ạ." Đợi user trả lời rồi mới gọi confirm_cancellation.`,
    };
  },
 
  // ── 7g. CONFIRM CANCELLATION — Hủy thật (Admin only) ──
  async confirm_cancellation({ bookingCode, reason, confirmed }) {
    // ⭐ CHỈ ADMIN
    if (ctx.role !== 'Admin') {
      return {
        error: 'forbidden',
        message: 'Hủy phòng chỉ dành cho Admin ạ.',
      };
    }
    if (!confirmed) {
      return {
        error: 'not_confirmed',
        message: 'Phải gọi prepare_cancellation trước + user xác nhận + cung cấp lý do.',
      };
    }
    if (!bookingCode) {
      return { error: 'missing_code', message: 'Thiếu bookingCode' };
    }
    // ⭐ Bắt buộc lý do, tối thiểu 5 ký tự
    if (!reason || String(reason).trim().length < 5) {
      return {
        error: 'reason_required',
        message: 'Phải có lý do hủy (tối thiểu 5 ký tự). Vd: "Khách đổi ý", "Trùng booking", "Khách không tới".',
      };
    }
 
    const raw = String(bookingCode).trim().toUpperCase();
    const withPrefix = raw.startsWith('BK_') ? raw : `BK_${raw}`;
    const withoutPrefix = raw.replace(/^BK_/, '');
    const q = {
      $or: [
        { bookingCode: raw },
        { bookingCode: withPrefix },
        { bookingCode: new RegExp(withoutPrefix + '$', 'i') },
      ],
    };
 
    const booking = await Booking.findOne(q);
    if (!booking) {
      return { error: 'not_found', message: `Không tìm thấy booking ${bookingCode}` };
    }
    if (booking.status === 'cancelled') {
      return { error: 'already_cancelled', message: 'Booking đã bị hủy rồi.' };
    }
    if (booking.status === 'checked_out') {
      return { error: 'already_checked_out', message: 'Booking đã check-out, không thể hủy.' };
    }
    if (booking.status === 'checked_in') {
      return { error: 'currently_checked_in', message: 'Khách đang ở phòng — phải check-out trước.' };
    }
 
    // Thực hiện hủy
    const now = new Date();
    const reasonClean = String(reason).trim();
    try {
      booking.status = 'cancelled';
      booking.cancelledAt = now;
      booking.cancelledReason = reasonClean;
      booking.cancelledBy = ctx.userId || null;
      booking.notes = (booking.notes || '') + `\n[AI Chat HỦY ${now.toLocaleString('vi-VN')}] Lý do: ${reasonClean}`;
      await booking.save();
 
      // Giải phóng phòng
      if (booking.roomId) {
        await Room.findByIdAndUpdate(booking.roomId, {
          currentBookingId: null,
          currentGuestName: null,
        });
      }
 
      // Audit log
      try {
        await logAction({
          entityType: 'Booking',
          entityId: booking._id,
          action: 'cancel',
          description: `[AI Chat] Hủy booking ${booking.bookingCode} — ${reasonClean}`,
          user: { id: ctx.userId, role: ctx.role, _id: ctx.userId },
          branchId: booking.branchId,
          metadata: {
            source: 'AI Chat',
            bookingCode: booking.bookingCode,
            roomNumber: booking.roomNumber,
            customerName: booking.customerName,
            reason: reasonClean,
            cancelledAt: now,
            createdByAI: true,
          },
        });
      } catch (e) {
        console.warn('[confirm_cancellation] audit log failed:', e.message);
      }
 
      return {
        success: true,
        bookingCode: booking.bookingCode || `BK_${String(booking._id).slice(-6).toUpperCase()}`,
        customerName: booking.customerName,
        roomNumber: booking.roomNumber,
        cancelledAt: now,
        cancelledAtFormatted: new Date(now).toLocaleString('vi-VN', {
          timeZone: 'Asia/Ho_Chi_Minh',
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: false,
        }),
        reason: reasonClean,
        paidAmount: booking.paidAmount || 0,
        paidAmountFormatted: fmt(booking.paidAmount || 0),
        _hint: 'HỦY THÀNH CÔNG. Hiển thị thông báo: phòng đã giải phóng, lý do hủy. Nếu paidAmount > 0 → nhắc "khách đã thanh toán X, cần xử lý hoàn tiền với kế toán".',
      };
    } catch (err) {
      console.error('[confirm_cancellation] error:', err);
      return { error: 'db_error', message: 'Không hủy được: ' + err.message };
    }
  },
 

  // ════════════════════════════════════════════════════
  // ⭐ KPI + PHÂN TÍCH KINH DOANH (gọi module riêng)
  // ════════════════════════════════════════════════════
  async get_business_kpi(args) {
    return businessAnalytics.getBusinessKPI({ ...args, ctx });
  },

  async analyze_revenue_trend(args) {
    const months = Math.min(12, Math.max(1, args.months || 6));
    return businessAnalytics.analyzeRevenueTrend({ ...args, months, ctx });
  },

  async analyze_room_performance(args) {
    return businessAnalytics.analyzeRoomPerformance({ ...args, ctx });
  },

  async analyze_weekday_pattern(args) {
    return businessAnalytics.analyzeWeekdayPattern({ ...args, ctx });
  },

  async get_strategy_recommendations(args) {
    return businessAnalytics.getStrategyRecommendations({ ...args, ctx });
  },

  // ════════════════════════════════════════════════════
  // ⭐ KPI + LƯƠNG (gọi module riêng)
  // ════════════════════════════════════════════════════
  async get_my_salary(args) {
    return salaryAnalytics.getMySalary({ ...args, ctx });
  },

  async get_my_kpi(args) {
    return salaryAnalytics.getMyKPI({ ...args, ctx });
  },

  async get_salary_history(args) {
    return salaryAnalytics.getSalaryHistory({ ...args, ctx });
  },

  async get_branch_kpi_overview(args) {
    return salaryAnalytics.getBranchKPIOverview({ ...args, ctx });
  },

  async get_branch_kpi_config(args) {
    return salaryAnalytics.getBranchKpiConfig({ ...args, ctx });
  },

  async get_top_employees(args) {
    return salaryAnalytics.getTopEmployees({ ...args, ctx });
  },

  async get_kpi_improvement_suggestions(args) {
    return salaryAnalytics.getKPIImprovementSuggestions({ ...args, ctx });
  },

  // ⭐ NEW 14/05/2026: Lương ứng + phạt (chi tiết)
  async get_my_advances(args) {
    return salaryAnalytics.getMyAdvances({ ...args, ctx });
  },

  async get_my_penalties(args) {
    return salaryAnalytics.getMyPenalties({ ...args, ctx });
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
    // ⭐ External: chặn
    if (!ctx.isInternal) {
      return { error: 'external_not_allowed', message: 'Thông tin này chỉ dành cho nhân viên ạ.' };
    }

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
    // ⭐ External: chặn
    if (!ctx.isInternal) {
      return { error: 'external_not_allowed', message: 'Thông tin này chỉ dành cho nhân viên ạ.' };
    }

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
    // ⭐ External: chặn
    if (!ctx.isInternal) {
      return { error: 'external_not_allowed', message: 'Thông tin này chỉ dành cho nhân viên ạ.' };
    }

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
    // ⭐ External: chặn
    if (!ctx.isInternal) {
      return { error: 'external_not_allowed', message: 'Thông tin này chỉ dành cho nhân viên ạ.' };
    }

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

  // ════════════════════════════════════════════════════════════
  // ⭐ NEW 14/05/2026: HANDLERS BỔ SUNG — Customer, Amenity, PaymentMethod, User
  // ════════════════════════════════════════════════════════════

  // ── CUSTOMER (4 handlers) ─────────────────────────────────────
  async find_customers({ query, limit = 10 }) {
    if (!ctx.isInternal) {
      return { error: 'external_not_allowed', message: 'Khách hàng không xem được dữ liệu này ạ.' };
    }
    if (!query || query.trim().length < 2) {
      return { error: 'Cần ít nhất 2 ký tự để search' };
    }
    const lim = Math.min(+limit || 10, 20);
    const customers = await Customer.find({
      $or: [
        { name:  { $regex: query, $options: 'i' } },
        { phone: { $regex: query, $options: 'i' } },
        { email: { $regex: query, $options: 'i' } },
      ],
    })
      .select('_id name phone email idCard nationality notes createdAt')
      .sort({ createdAt: -1 })
      .limit(lim)
      .lean();

    return {
      count: customers.length,
      query,
      customers: customers.map(c => ({
        customerId: String(c._id),
        name:        c.name,
        phone:       c.phone,
        email:       c.email || null,
        idCard:      c.idCard || null,
        nationality: c.nationality || null,
        notes:       c.notes || null,
        createdAt:   c.createdAt,
      })),
    };
  },

  async get_customer_detail({ customerId, phone }) {
    if (!ctx.isInternal) {
      return { error: 'external_not_allowed', message: 'Khách hàng không xem được dữ liệu này ạ.' };
    }
    if (!customerId && !phone) {
      return { error: 'Cần customerId hoặc phone' };
    }

    let customer;
    if (customerId && mongoose.Types.ObjectId.isValid(customerId)) {
      customer = await Customer.findById(customerId).lean();
    }
    if (!customer && phone) {
      customer = await Customer.findOne({ phone: String(phone).trim() }).lean();
    }
    if (!customer) return { error: 'Không tìm thấy khách hàng' };

    // ⭐ Lấy lịch sử booking — match qua customerPhone (Booking lưu phone snapshot)
    const bookingFilter = { customerPhone: customer.phone };
    if (ctx.role !== 'Admin' && ctx.userBranchId) {
      bookingFilter.branchId = ctx.userBranchId;
    }

    const recentBookings = await Booking.find(bookingFilter)
      .select('_id bookingCode roomNumber roomType checkIn checkOut status totalAmount nights branchId')
      .populate('branchId', 'name')
      .sort({ checkIn: -1 })
      .limit(5)
      .lean();

    // Aggregate tổng thống kê
    const allBookings = await Booking.find({
      ...bookingFilter,
      status: { $in: ['checked_in', 'checked_out', 'confirmed', 'reserved'] },
    })
      .select('totalAmount status nights')
      .lean();

    const totalBookings  = allBookings.length;
    const totalSpending  = allBookings
      .filter(b => b.status === 'checked_out')
      .reduce((sum, b) => sum + (b.totalAmount || 0), 0);
    const totalNights    = allBookings
      .filter(b => b.status === 'checked_out')
      .reduce((sum, b) => sum + (b.nights || 0), 0);
    const completedCount = allBookings.filter(b => b.status === 'checked_out').length;
    const cancelledCount = await Booking.countDocuments({ ...bookingFilter, status: 'cancelled' });

    const fmtVN = (d) => {
      if (!d) return null;
      return new Date(d).toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
        hour12: false,
      });
    };

    return {
      customerId:  String(customer._id),
      name:        customer.name,
      phone:       customer.phone,
      email:       customer.email || null,
      idCard:      customer.idCard || null,
      nationality: customer.nationality || null,
      notes:       customer.notes || null,
      createdAt:   customer.createdAt,
      stats: {
        totalBookings,
        completedBookings: completedCount,
        cancelledBookings: cancelledCount,
        totalSpending,
        totalSpendingFormatted: fmt(totalSpending),
        totalNights,
        isRepeat: completedCount >= 2,        // Đánh dấu khách quay lại
        isVIP:    totalSpending >= 5_000_000,  // VIP nếu chi tiêu > 5tr
      },
      recentBookings: recentBookings.map(b => ({
        bookingCode: b.bookingCode || `BK_${String(b._id).slice(-6).toUpperCase()}`,
        bookingId:   String(b._id),
        room:        b.roomNumber,
        roomType:    b.roomType,
        branch:      b.branchId?.name,
        checkIn:     b.checkIn,
        checkOut:    b.checkOut,
        checkInFormatted:  fmtVN(b.checkIn),
        checkOutFormatted: fmtVN(b.checkOut),
        status:      b.status,
        nights:      b.nights,
        totalAmount: b.totalAmount,
        totalFormatted: fmt(b.totalAmount || 0),
      })),
    };
  },

  async get_top_customers({ sortBy = 'spending', limit = 10, days = 90 }) {
    // ⭐ Chỉ Admin/Manager (analytics permission)
    if (!ctx.isInternal || (ctx.role !== 'Admin' && ctx.role !== 'Manager')) {
      return {
        error: 'forbidden',
        message: 'Tính năng top khách hàng chỉ dành cho Admin/Manager ạ.',
      };
    }

    const lim = Math.min(+limit || 10, 30);
    const since = new Date();
    since.setDate(since.getDate() - (+days || 90));

    const matchStage = {
      status: 'checked_out',
      checkOut: { $gte: since },
    };
    if (ctx.role !== 'Admin' && ctx.userBranchId) {
      matchStage.branchId = new mongoose.Types.ObjectId(ctx.userBranchId);
    }

    const sortField = sortBy === 'bookings' ? 'bookingCount' : 'totalSpent';

    const top = await Booking.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id:           '$customerPhone',
          customerName:  { $last: '$customerName' },
          customerPhone: { $last: '$customerPhone' },
          totalSpent:    { $sum: '$totalAmount' },
          bookingCount:  { $sum: 1 },
          totalNights:   { $sum: '$nights' },
          lastBooking:   { $max: '$checkOut' },
        },
      },
      { $match: { _id: { $ne: null } } },        // Loại booking không có phone
      { $sort: { [sortField]: -1 } },
      { $limit: lim },
    ]);

    return {
      sortBy,
      period: `${days} ngày gần đây`,
      count:  top.length,
      customers: top.map((c, i) => ({
        rank:          i + 1,
        name:          c.customerName || '(không tên)',
        phone:         c.customerPhone,
        totalSpent:    c.totalSpent,
        totalSpentFormatted: fmt(c.totalSpent || 0),
        bookingCount:  c.bookingCount,
        totalNights:   c.totalNights,
        lastBooking:   c.lastBooking,
      })),
    };
  },

  async get_customer_stats({ days = 30 }) {
    if (!ctx.isInternal || (ctx.role !== 'Admin' && ctx.role !== 'Manager')) {
      return {
        error: 'forbidden',
        message: 'Thống kê khách hàng chỉ dành cho Admin/Manager ạ.',
      };
    }

    const since = new Date();
    since.setDate(since.getDate() - (+days || 30));

    const totalCustomers = await Customer.countDocuments({});
    const newCustomers   = await Customer.countDocuments({ createdAt: { $gte: since } });

    // Repeat rate: % khách có >= 2 booking
    const bookingFilter = { status: 'checked_out' };
    if (ctx.role !== 'Admin' && ctx.userBranchId) {
      bookingFilter.branchId = new mongoose.Types.ObjectId(ctx.userBranchId);
    }
    const customerBookingCounts = await Booking.aggregate([
      { $match: bookingFilter },
      { $group: { _id: '$customerPhone', count: { $sum: 1 } } },
      { $match: { _id: { $ne: null } } },
    ]);
    const totalWithBookings = customerBookingCounts.length;
    const repeatCustomers   = customerBookingCounts.filter(c => c.count >= 2).length;
    const repeatRate        = totalWithBookings > 0
      ? Math.round((repeatCustomers / totalWithBookings) * 100)
      : 0;

    return {
      totalCustomers,
      newCustomers,
      newCustomersPeriod:  `${days} ngày gần đây`,
      repeatCustomers,
      totalWithBookings,
      repeatRate,
      repeatRateFormatted: `${repeatRate}%`,
    };
  },

  // ── AMENITY (1 handler) ───────────────────────────────────────
  async list_amenities({ category }) {
    const filter = { isActive: true };
    if (category) filter.category = category;

    const list = await Amenity.find(filter)
      .select('name category icon description')
      .sort({ category: 1, name: 1 })
      .lean();

    // Group theo category cho dễ hiển thị
    const grouped = list.reduce((acc, a) => {
      const cat = a.category || 'Khác';
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push({
        name:        a.name,
        icon:        a.icon || '⭐',
        description: a.description || null,
      });
      return acc;
    }, {});

    return {
      total:      list.length,
      categories: Object.keys(grouped),
      grouped,
      // Flat list cũng tiện
      amenities: list.map(a => ({
        name:        a.name,
        category:    a.category,
        icon:        a.icon || '⭐',
        description: a.description || null,
      })),
    };
  },

  // ── PAYMENT METHOD (1 handler) ────────────────────────────────
  async list_payment_methods() {
    const list = await PaymentMethod.find({ isActive: true })
      .select('name type description icon')
      .sort({ name: 1 })
      .lean();

    return {
      count: list.length,
      methods: list.map(m => ({
        name:        m.name,
        type:        m.type,
        icon:        m.icon || '💳',
        description: m.description || null,
      })),
    };
  },

  async prepare_procedure({ title, positions, category, description, steps, branchName } = {}) {
  // ⭐ CHỈ ADMIN
  if (ctx.role !== 'Admin') {
    return { error: 'forbidden', message: 'Chỉ Admin mới được tạo quy trình mới qua chat ạ.' };
  }
 
  const VALID = ['Admin', 'Manager', 'Receptionist', 'Staff'];
 
  // ─── Validate title ───
  if (!title || !String(title).trim()) {
    return { error: 'missing_title', message: 'Thiếu tên quy trình. Hãy hỏi admin tên quy trình.' };
  }
 
  // ─── Validate positions (BẮT BUỘC) ───
  const posArr = Array.isArray(positions)
    ? positions.map(p => String(p).trim()).filter(Boolean)
    : (positions ? [String(positions).trim()] : []);
  if (posArr.length === 0) {
    return {
      error: 'missing_positions',
      message: 'Chưa biết quy trình áp dụng cho vị trí nào. PHẢI HỎI admin: quy trình này dành cho vị trí nào (Lễ tân/Receptionist, Buồng phòng/Staff, Manager, Admin)? — rồi mới gọi lại tool.',
    };
  }
  const invalid = posArr.filter(p => !VALID.includes(p));
  if (invalid.length > 0) {
    return {
      error: 'invalid_positions',
      message: `Vị trí không hợp lệ: ${invalid.join(', ')}. Chỉ chấp nhận: ${VALID.join(', ')}. (Lễ tân→Receptionist, Buồng phòng/Nhân viên→Staff, Quản lý→Manager). Hãy map lại rồi gọi lại tool.`,
    };
  }
 
  // ─── Normalize steps ───
  const stepsArr = Array.isArray(steps)
    ? steps.map((s, i) => ({
        order: i + 1,
        title: String(s?.title || '').trim().slice(0, 200),
        content: String(s?.content || '').trim().slice(0, 5000),
      })).filter(s => s.title.length > 0)
    : [];
 
  // ─── Resolve branch ───
  let branchId = ctx.userBranchId;
  if (branchName) {
    const bId = await resolveBranchId(ctx, branchName);
    if (bId) branchId = bId;
  }
  if (!branchId) {
    const firstBranch = await Branch.findOne().select('_id name').lean();
    branchId = firstBranch?._id;
  }
  if (!branchId) {
    return { error: 'no_branch', message: 'Không xác định được chi nhánh để tạo quy trình.' };
  }
  const branchDoc = await Branch.findById(branchId).select('name').lean();
 
  const cat = ['checklist', 'sop'].includes(category) ? category : 'sop';
 
  return {
    _previewOnly: true,
    summary: {
      title: String(title).trim(),
      positions: posArr,
      category: cat,
      categoryLabel: cat === 'checklist' ? 'Danh sách kiểm tra' : 'Quy trình chuẩn (SOP)',
      description: String(description || '').trim() || null,
      branch: branchDoc?.name || null,
      stepCount: stepsArr.length,
      steps: stepsArr.map(s => ({ step: s.order, title: s.title, content: s.content || null })),
    },
    _hint: 'ĐÂY LÀ PREVIEW — CHƯA tạo. Hiển thị đầy đủ cho admin duyệt: tên, vị trí áp dụng, loại, các bước. SAU ĐÓ hỏi rõ "Anh duyệt tạo quy trình này chứ ạ?". CHỈ gọi confirm_create_procedure (confirmed=true) khi admin trả lời "ok/duyệt/tạo đi/đồng ý". Truyền lại y nguyên thông tin đã preview.',
  };
},
 
async confirm_create_procedure({ title, positions, category, description, steps, branchName, confirmed = false } = {}) {
  // ⭐ CHỈ ADMIN
  if (ctx.role !== 'Admin') {
    return { error: 'forbidden', message: 'Chỉ Admin mới được tạo quy trình mới ạ.' };
  }
  // ⭐ Bắt buộc confirmed
  if (!confirmed) {
    return {
      error: 'not_confirmed',
      message: 'Cần admin duyệt rõ ràng. Hãy gọi prepare_procedure trước, để admin duyệt, rồi mới gọi confirm_create_procedure với confirmed=true.',
    };
  }
 
  const VALID = ['Admin', 'Manager', 'Receptionist', 'Staff'];
 
  // ─── Validate (lặp lại để bảo vệ — không tin tưởng AI truyền đúng) ───
  if (!title || !String(title).trim()) {
    return { error: 'missing_title', message: 'Thiếu tên quy trình.' };
  }
  const posArr = Array.isArray(positions)
    ? positions.map(p => String(p).trim()).filter(Boolean)
    : (positions ? [String(positions).trim()] : []);
  if (posArr.length === 0) {
    return { error: 'missing_positions', message: 'Thiếu vị trí áp dụng (positions).' };
  }
  const invalid = posArr.filter(p => !VALID.includes(p));
  if (invalid.length > 0) {
    return { error: 'invalid_positions', message: `Vị trí không hợp lệ: ${invalid.join(', ')}.` };
  }
 
  const stepsArr = Array.isArray(steps)
    ? steps.map((s, i) => ({
        order: i + 1,
        title: String(s?.title || '').trim().slice(0, 200),
        content: String(s?.content || '').trim().slice(0, 5000),
        imageUrl: '',
      })).filter(s => s.title.length > 0)
    : [];
 
  // ─── Resolve branch ───
  let branchId = ctx.userBranchId;
  if (branchName) {
    const bId = await resolveBranchId(ctx, branchName);
    if (bId) branchId = bId;
  }
  if (!branchId) {
    const firstBranch = await Branch.findOne().select('_id').lean();
    branchId = firstBranch?._id;
  }
  if (!branchId) {
    return { error: 'no_branch', message: 'Không xác định được chi nhánh.' };
  }
 
  const cat = ['checklist', 'sop'].includes(category) ? category : 'sop';
 
  // ─── Tạo thật ───
  let procedure;
  try {
    procedure = await Procedure.create({
      branchId,
      title: String(title).trim(),
      positions: posArr,
      category: cat,
      description: String(description || '').trim(),
      steps: stepsArr,
      status: 'active',
      createdBy: ctx.userId || null,
      updatedBy: ctx.userId || null,
    });
  } catch (e) {
    console.error('[confirm_create_procedure] error:', e);
    return { error: 'db_error', message: 'Không tạo được quy trình: ' + e.message };
  }
 
  // ─── Audit log (non-fatal) ───
  try {
    await logAction({
      entityType: 'Procedure',
      entityId: procedure._id,
      action: 'create',
      description: `[AI Chat] Tạo quy trình "${procedure.title}"`,
      user: { id: ctx.userId, role: ctx.role, _id: ctx.userId },
      branchId,
      metadata: {
        source: 'AI Chat',
        title: procedure.title,
        positions: posArr,
        category: cat,
        stepCount: stepsArr.length,
        createdByAI: true,
      },
    });
  } catch (e) {
    console.warn('[confirm_create_procedure] audit log failed (non-fatal):', e.message);
  }
 
  const branchDoc = await Branch.findById(branchId).select('name').lean();
 
  return {
    success: true,
    procedureId: String(procedure._id),
    title: procedure.title,
    positions: posArr,
    category: cat,
    categoryLabel: cat === 'checklist' ? 'Danh sách kiểm tra' : 'Quy trình chuẩn (SOP)',
    stepCount: stepsArr.length,
    branch: branchDoc?.name || null,
    _hint: 'TẠO QUY TRÌNH THÀNH CÔNG. Báo admin với tone vui mừng: đã thêm quy trình vào hệ thống, áp dụng cho các vị trí nào, gồm mấy bước. Kết thúc "Anh cần em hỗ trợ thêm gì không ạ?".',
  };
},
 

  // ── USER / STAFF (2 handlers) ─────────────────────────────────
  async find_users({ query, role, branchName, isActive, limit = 20 }) {
    // ⭐ Chỉ Admin/Manager xem được nhân viên khác
    if (!ctx.isInternal || (ctx.role !== 'Admin' && ctx.role !== 'Manager')) {
      return {
        error: 'forbidden',
        message: 'Tìm kiếm nhân viên chỉ dành cho Admin/Manager ạ.',
      };
    }

    const filter = {};
    if (query) {
      filter.$or = [
        { fullName: { $regex: query, $options: 'i' } },
        { username: { $regex: query, $options: 'i' } },
        { email:    { $regex: query, $options: 'i' } },
      ];
    }
    if (role) filter.role = role;
    if (isActive !== undefined) filter.isActive = isActive;

    // Manager: chỉ thấy nhân viên cùng branch
    if (ctx.role === 'Manager' && ctx.userBranchId) {
      filter.branchId = ctx.userBranchId;
    }
    // Filter theo branchName
    if (branchName) {
      const br = await Branch.findOne({
        $or: [
          { name:      { $regex: branchName, $options: 'i' } },
          { shortName: { $regex: branchName, $options: 'i' } },
        ],
      }).select('_id name').lean();
      if (br) filter.branchId = br._id;
    }

    const lim = Math.min(+limit || 20, 50);
    const users = await User.find(filter)
      .select('_id username fullName email phone role branchId branchName isActive createdAt')
      .populate('branchId', 'name')
      .sort({ role: 1, fullName: 1 })
      .limit(lim)
      .lean();

    return {
      count: users.length,
      users: users.map(u => ({
        userId:    String(u._id),
        username:  u.username,
        fullName:  u.fullName,
        email:     u.email,
        phone:     u.phone || null,
        role:      u.role,
        branch:    u.branchId?.name || u.branchName || null,
        isActive:  u.isActive,
        createdAt: u.createdAt,
      })),
    };
  },

  async get_user_stats() {
    if (!ctx.isInternal || (ctx.role !== 'Admin' && ctx.role !== 'Manager')) {
      return {
        error: 'forbidden',
        message: 'Thống kê nhân viên chỉ dành cho Admin/Manager ạ.',
      };
    }

    const filter = {};
    if (ctx.role === 'Manager' && ctx.userBranchId) {
      filter.branchId = ctx.userBranchId;
    }

    const all = await User.find(filter)
      .select('role branchId branchName isActive')
      .populate('branchId', 'name')
      .lean();

    // Breakdown theo role
    const byRole = all.reduce((acc, u) => {
      acc[u.role] = (acc[u.role] || 0) + 1;
      return acc;
    }, {});

    // Breakdown theo branch
    const byBranch = all.reduce((acc, u) => {
      const branchName = u.branchId?.name || u.branchName || 'Chưa gán';
      acc[branchName] = (acc[branchName] || 0) + 1;
      return acc;
    }, {});

    const activeCount   = all.filter(u => u.isActive).length;
    const inactiveCount = all.filter(u => !u.isActive).length;

    return {
      total:    all.length,
      active:   activeCount,
      inactive: inactiveCount,
      byRole,
      byBranch,
      scope:    ctx.role === 'Manager' ? 'Trong chi nhánh của em' : 'Toàn hệ thống',
    };
  },

  // ⭐ NEW 14/05/2026: Handlers cho 4 tools mới — Thu/Chi + Ca trực + Đối soát
  // ───────────────────────────────────────────────────────────────────

  // Tool: get_current_shift
  async get_current_shift() {
    if (!ctx.isInternal) {
      return { error: 'internal_only', message: 'Tính năng này chỉ dành cho nhân viên ạ.' };
    }
    try {
      const Shift = require('../models/Shift');
      const shift = await Shift.findOne({ user: ctx.userId, status: 'open' })
        .populate('user', 'fullName')
        .populate('branchId', 'name')
        .lean();

      if (!shift) {
        return {
          hasOpenShift: false,
          message: 'Em chưa mở ca nào ạ. Em có thể mở ca mới trong menu "Kế toán → Bàn giao ca".',
        };
      }

      const summary = await Shift.computeShiftSummary(shift._id);
      const expectedCash = (shift.openingCash || 0) + (summary.cashIn || 0) - (summary.cashOut || 0);
      const expectedBank = (shift.openingBankBalance || 0) + (summary.transferIn || 0) + (summary.cardIn || 0) - (summary.transferOut || 0) - (summary.cardOut || 0);

      const openedAt = new Date(shift.openedAt);
      const now = new Date();
      const hoursOpen = Math.floor((now - openedAt) / 3600000);
      const minutesOpen = Math.floor(((now - openedAt) % 3600000) / 60000);

      return {
        hasOpenShift: true,
        shiftCode: shift.shiftCode,
        label: shift.label || '',
        openedAt: shift.openedAt,
        openedAtFormatted: openedAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
        duration: `${hoursOpen}h ${minutesOpen}p`,
        branchName: shift.branchId?.name,
        openingCash: shift.openingCash,
        openingCashFormatted: (shift.openingCash || 0).toLocaleString('vi-VN') + 'đ',
        openingBank: shift.openingBankBalance,
        openingBankFormatted: (shift.openingBankBalance || 0).toLocaleString('vi-VN') + 'đ',
        summary: {
          cashIn: summary.cashIn,
          cashInFormatted: (summary.cashIn || 0).toLocaleString('vi-VN') + 'đ',
          transferIn: summary.transferIn,
          transferInFormatted: (summary.transferIn || 0).toLocaleString('vi-VN') + 'đ',
          cardIn: summary.cardIn,
          cardInFormatted: (summary.cardIn || 0).toLocaleString('vi-VN') + 'đ',
          cashOut: summary.cashOut,
          cashOutFormatted: (summary.cashOut || 0).toLocaleString('vi-VN') + 'đ',
          totalIn: (summary.cashIn || 0) + (summary.transferIn || 0) + (summary.cardIn || 0),
          totalInFormatted: ((summary.cashIn || 0) + (summary.transferIn || 0) + (summary.cardIn || 0)).toLocaleString('vi-VN') + 'đ',
          transactionCount: summary.transactionCount,
        },
        expectedCash,
        expectedCashFormatted: expectedCash.toLocaleString('vi-VN') + 'đ',
        expectedBank,
        expectedBankFormatted: expectedBank.toLocaleString('vi-VN') + 'đ',
      };
    } catch (err) {
      console.error('[get_current_shift]', err);
      return { error: err.message };
    }
  },

  // Tool: get_today_cash_flow
  async get_today_cash_flow({ date, branchName } = {}) {
    if (!ctx.isInternal) {
      return { error: 'internal_only', message: 'Tính năng này chỉ dành cho nhân viên ạ.' };
    }
    try {
      const Transaction = require('../models/Transaction');
      const mongoose = require('mongoose');

      // Resolve date
      const d = date ? new Date(date) : new Date();
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

      // Resolve branch
      let bId = ctx.userBranchId;
      if (ctx.role === 'Admin' && branchName) {
        const Branch = require('../models/Branch');
        const br = await Branch.findOne({
          $or: [
            { name: { $regex: branchName, $options: 'i' } },
            { shortName: { $regex: branchName, $options: 'i' } },
          ],
        }).select('_id').lean();
        if (br) bId = br._id;
      }

      const match = { occurredOn: { $gte: start, $lte: end } };
      if (bId && mongoose.Types.ObjectId.isValid(bId)) {
        match.branchId = new mongoose.Types.ObjectId(bId);
      }

      const agg = await Transaction.aggregate([
        { $match: match },
        { $group: {
          _id: { type: '$type', paymentMethod: '$paymentMethod' },
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        }},
      ]);

      const result = {
        date: d.toLocaleDateString('vi-VN'),
        cashIn: 0, transferIn: 0, cardIn: 0, otherIn: 0,
        cashOut: 0, transferOut: 0, cardOut: 0, otherOut: 0,
        totalIn: 0, totalOut: 0, netCashFlow: 0,
        transactionCount: 0,
      };

      for (const row of agg) {
        const { type, paymentMethod } = row._id;
        const pm = ['cash', 'transfer', 'card'].includes(paymentMethod) ? paymentMethod : 'other';
        const key = type === 'income' ? `${pm}In` : `${pm}Out`;
        result[key] = row.total;
        if (type === 'income') result.totalIn += row.total;
        else result.totalOut += row.total;
        result.transactionCount += row.count;
      }
      result.netCashFlow = result.totalIn - result.totalOut;

      return {
        ...result,
        cashInFormatted: result.cashIn.toLocaleString('vi-VN') + 'đ',
        transferInFormatted: result.transferIn.toLocaleString('vi-VN') + 'đ',
        cardInFormatted: result.cardIn.toLocaleString('vi-VN') + 'đ',
        cashOutFormatted: result.cashOut.toLocaleString('vi-VN') + 'đ',
        totalInFormatted: result.totalIn.toLocaleString('vi-VN') + 'đ',
        totalOutFormatted: result.totalOut.toLocaleString('vi-VN') + 'đ',
        netCashFlowFormatted: result.netCashFlow.toLocaleString('vi-VN') + 'đ',
      };
    } catch (err) {
      console.error('[get_today_cash_flow]', err);
      return { error: err.message };
    }
  },

  // Tool: find_cash_discrepancy
  async find_cash_discrepancy({ fromDate, toDate, minDifference = 0, branchName } = {}) {
    if (!ctx.isInternal) {
      return { error: 'internal_only', message: 'Tính năng này chỉ dành cho nhân viên ạ.' };
    }
    if (ctx.role !== 'Admin' && ctx.role !== 'Manager') {
      return { error: 'forbidden', message: 'Chỉ Admin/Manager mới xem được ạ.' };
    }
    try {
      const Shift = require('../models/Shift');
      const mongoose = require('mongoose');

      const filter = {
        status: { $in: ['closed', 'handed_over', 'disputed'] },
        $or: [
          { cashDifference: { $ne: 0 } },
          { bankDifference: { $ne: 0 } },
        ],
      };

      if (ctx.role === 'Manager') {
        filter.branchId = ctx.userBranchId;
      } else if (ctx.role === 'Admin' && branchName) {
        const Branch = require('../models/Branch');
        const br = await Branch.findOne({
          $or: [
            { name: { $regex: branchName, $options: 'i' } },
            { shortName: { $regex: branchName, $options: 'i' } },
          ],
        }).select('_id').lean();
        if (br) filter.branchId = br._id;
      }

      const now = new Date();
      const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
      filter.openedAt = {
        $gte: fromDate ? new Date(fromDate) : defaultFrom,
        $lte: toDate ? new Date(toDate) : now,
      };

      const shifts = await Shift.find(filter)
        .populate('user', 'fullName')
        .populate('branchId', 'name')
        .sort({ openedAt: -1 })
        .limit(20)
        .lean();

      const filtered = minDifference > 0
        ? shifts.filter(s => Math.abs(s.cashDifference || 0) >= minDifference || Math.abs(s.bankDifference || 0) >= minDifference)
        : shifts;

      const totalCashDiff = filtered.reduce((s, x) => s + (x.cashDifference || 0), 0);
      const totalBankDiff = filtered.reduce((s, x) => s + (x.bankDifference || 0), 0);

      return {
        count: filtered.length,
        totalCashDifference: totalCashDiff,
        totalCashDifferenceFormatted: (totalCashDiff > 0 ? '+' : '') + totalCashDiff.toLocaleString('vi-VN') + 'đ',
        totalBankDifference: totalBankDiff,
        totalBankDifferenceFormatted: (totalBankDiff > 0 ? '+' : '') + totalBankDiff.toLocaleString('vi-VN') + 'đ',
        shifts: filtered.map(s => ({
          shiftCode: s.shiftCode,
          label: s.label || '',
          userName: s.user?.fullName,
          branchName: s.branchId?.name,
          openedAt: s.openedAt,
          openedAtFormatted: new Date(s.openedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
          cashDifference: s.cashDifference,
          cashDifferenceFormatted: (s.cashDifference > 0 ? '+' : '') + (s.cashDifference || 0).toLocaleString('vi-VN') + 'đ',
          bankDifference: s.bankDifference,
          bankDifferenceFormatted: (s.bankDifference > 0 ? '+' : '') + (s.bankDifference || 0).toLocaleString('vi-VN') + 'đ',
          status: s.status,
        })),
      };
    } catch (err) {
      console.error('[find_cash_discrepancy]', err);
      return { error: err.message };
    }
  },

  // Tool: get_reconciliation_status
  async get_reconciliation_status({ year, month, branchName } = {}) {
    if (!ctx.isInternal) {
      return { error: 'internal_only', message: 'Tính năng này chỉ dành cho nhân viên ạ.' };
    }
    if (ctx.role !== 'Admin' && ctx.role !== 'Manager') {
      return { error: 'forbidden', message: 'Chỉ Admin/Manager mới xem được ạ.' };
    }
    try {
      const Reconciliation = require('../models/Reconciliation');
      const now = new Date();
      const y = parseInt(year, 10) || now.getFullYear();
      const m = parseInt(month, 10) || (now.getMonth() + 1);

      let bId = ctx.userBranchId;
      if (ctx.role === 'Admin' && branchName) {
        const Branch = require('../models/Branch');
        const br = await Branch.findOne({
          $or: [
            { name: { $regex: branchName, $options: 'i' } },
            { shortName: { $regex: branchName, $options: 'i' } },
          ],
        }).select('_id name').lean();
        if (br) bId = br._id;
      }

      const start = new Date(y, m - 1, 1);
      const end = new Date(y, m, 1);

      const recs = await Reconciliation.find({
        branchId: bId,
        fromDate: { $gte: start, $lt: end },
      })
        .populate('branchId', 'name')
        .populate('createdBy', 'fullName')
        .populate('approvedBy', 'fullName')
        .sort({ fromDate: 1 })
        .lean();

      const counts = recs.reduce((acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      }, {});
      const totalDiff = recs.reduce((s, r) => s + (r.totalDifference || 0), 0);

      return {
        year: y, month: m,
        period: `Tháng ${m}/${y}`,
        total: recs.length,
        counts,
        totalDifference: totalDiff,
        totalDifferenceFormatted: (totalDiff > 0 ? '+' : '') + totalDiff.toLocaleString('vi-VN') + 'đ',
        reconciliations: recs.map(r => ({
          code: r.reconciliationCode,
          label: r.label,
          period: r.period,
          status: r.status,
          totalDifference: r.totalDifference,
          totalDifferenceFormatted: (r.totalDifference > 0 ? '+' : '') + (r.totalDifference || 0).toLocaleString('vi-VN') + 'đ',
          shiftCount: r.shiftCount,
          createdBy: r.createdBy?.fullName,
          approvedBy: r.approvedBy?.fullName,
          fromDate: r.fromDate,
          toDate: r.toDate,
        })),
      };
    } catch (err) {
      console.error('[get_reconciliation_status]', err);
      return { error: err.message };
    }
  },
});


// ============================================================
// MAIN ENDPOINT
// ============================================================
router.post('/message', async (req, res) => {
  try {
    // ⭐ OPTIONAL AUTH — parse JWT nếu có, không bắt buộc
    //   Chat endpoint cần hỗ trợ cả internal (nhân viên) lẫn external (khách)
    //   Internal có JWT → set req.user → lưu DB được
    //   External không có JWT → vẫn dùng được nhưng KHÔNG lưu DB
    if (!req.user) {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;
      if (token && process.env.JWT_SECRET) {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          // ⭐ Hỗ trợ nhiều format payload thường gặp
          req.user = {
            id: decoded.id || decoded._id || decoded.userId || decoded.sub,
            _id: decoded._id || decoded.id || decoded.userId,
            role: decoded.role,
            branchId: decoded.branchId,
            fullName: decoded.fullName || decoded.name,
            displayName: decoded.displayName,
            username: decoded.username,
            email: decoded.email,
          };
          console.log('[Chat] Parsed JWT - user:', req.user.id, req.user.role);
        } catch (e) {
          console.warn('[Chat] JWT verify failed (non-fatal):', e.message);
        }
      }
    }

    const {
      message,
      history = [],
      userRole,
      userBranchId,
      userName: bodyUserName,
      sessionId: clientSessionId,
      userId: bodyUserId,         // ⭐ FE gửi userId trong body làm fallback cho JWT
    } = req.body;

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
      // ⭐ Ưu tiên JWT (đáng tin), fallback body (cho app nội bộ khi JWT chưa hoàn thiện)
      //   Validate là ObjectId hợp lệ để tránh inject string lung tung vào DB
      userId: req.user?.id
        || req.user?._id
        || (bodyUserId && /^[0-9a-fA-F]{24}$/.test(String(bodyUserId)) ? String(bodyUserId) : null),
      // ⭐ Tên user — ưu tiên từ JWT (đáng tin hơn body), fallback body
      userName: req.user?.fullName
        || req.user?.displayName
        || req.user?.name
        || req.user?.username
        || bodyUserName
        || '',
    };
    // ⭐ Phân loại internal/external
    const INTERNAL_ROLES = ['Admin', 'Manager', 'Receptionist', 'Staff'];
    ctx.isInternal = INTERNAL_ROLES.includes(ctx.role);
    ctx.userType = ctx.isInternal ? 'internal' : 'external';

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

    // ⭐ Build Gemini history — filter & validate sạch
    //   - Bỏ message rỗng / undefined text
    //   - Bỏ message quá dài (>10k chars) để tránh API reject
    //   - Đảm bảo turn xen kẽ: user → model → user → model
    //   - History phải BẮT ĐẦU bằng user, KẾT THÚC bằng model
    const cleanHistory = history
      .filter(h => {
        if (!h || !h.role) return false;
        if (h.role !== 'user' && h.role !== 'assistant') return false;
        const text = String(h.text || '').trim();
        if (!text || text.length === 0) return false;
        if (text.length > 10000) return false;     // Bỏ message quá dài
        return true;
      })
      .slice(-20)
      .map(h => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(h.text).trim().slice(0, 10000) }],
      }));

    // ⭐ Bỏ message đầu nếu là 'model' (Gemini yêu cầu history bắt đầu bằng user)
    while (cleanHistory.length && cleanHistory[0].role === 'model') {
      cleanHistory.shift();
    }

    // ⭐ Merge các turn liên tiếp cùng role (Gemini yêu cầu xen kẽ user/model)
    //   Vd: user → user → model → assistant_2 → user
    //   Sau merge: user(text1+text2) → model(text1+text2) → user
    const geminiHistory = [];
    for (const msg of cleanHistory) {
      const last = geminiHistory[geminiHistory.length - 1];
      if (last && last.role === msg.role) {
        // Cùng role → merge text
        last.parts[0].text = last.parts[0].text + '\n\n' + msg.parts[0].text;
      } else {
        geminiHistory.push(msg);
      }
    }

    // ⭐ Bỏ tin user CUỐI cùng nếu trùng với `message` đang gửi
    //   (tránh trùng lặp khi FE vô tình include msg user vừa gõ)
    if (geminiHistory.length > 0) {
      const lastMsg = geminiHistory[geminiHistory.length - 1];
      if (lastMsg.role === 'user' && lastMsg.parts[0].text === message.trim()) {
        console.warn('[Chat] History có duplicate user msg cuối — đã bỏ');
        geminiHistory.pop();
      }
    }

    console.log(`[Chat] History: ${geminiHistory.length} messages, last role=${geminiHistory[geminiHistory.length-1]?.role || 'none'}`);

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

    // ⭐ Helper tạo model — dùng IMPLICIT CACHE của Gemini 2.5
    //   Gemini 2.5 Flash tự động cache prefix prompt (min 1024 token)
    //   nếu request shares common prefix với request trước.
    //   Cost: cached tokens chỉ tính 25% giá gốc → tiết kiệm 75%.
    //
    //   ĐIỀU KIỆN cache hit:
    //   1. Prefix prompt giống nhau (đã tổ chức ở chatPromptBuilder)
    //   2. Tools giống nhau (giữ thứ tự ổn định)
    //   3. Trong vòng 3-5 phút sau request trước
    //
    //   KHÔNG dùng explicit cache vì:
    //   - SDK @google/generative-ai cũ không có genAI.caches.create()
    //   - Explicit cache yêu cầu min 32,768 token — prompt hiện tại nhỏ hơn
    function buildModel(modelName) {
      return genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
        tools,
        generationConfig: { temperature: 0.4, maxOutputTokens: 2000 },
        // ⭐ Tắt safety filters — chat khách sạn không cần block,
        //   tránh tình huống Gemini trả rỗng do FALSE POSITIVE
        //   (vd "trả phòng ngày mốt" bị nhận nhầm là content nguy hiểm)
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ],
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
          const fallbackModel = buildModel(modelName);
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

            // ⭐ Bad request 400 — thường do history có vấn đề (vd image cũ, parts rỗng)
            const isBadRequest =
              err.message?.includes('400') ||
              err.message?.includes('INVALID_ARGUMENT') ||
              err.status === 400;

            // ⭐ FULL error log để biết bug chính xác
            console.error(`[Chat] ${modelName} attempt ${retry + 1} ERROR:`);
            console.error(`  Message: ${err.message}`);
            console.error(`  Status: ${err.status || 'N/A'}`);
            console.error(`  StatusText: ${err.statusText || 'N/A'}`);
            if (err.errorDetails) console.error(`  Details:`, err.errorDetails);

            if (isQuotaError) break;
            if (isBadRequest) {
              // Bad request: thử fallback model có thể không cùng vấn đề
              console.warn(`[Chat] Bad request 400 — try fallback model`);
              break;
            }
            if (!isRetryable) throw err;
            if (retry === 0) await new Promise(r => setTimeout(r, 2000));
          }
        }
      }

      throw lastError || new Error('Tất cả model AI đều không khả dụng');
    }

    const model = buildModel(MODEL_FALLBACKS[0]);

    let chat = model.startChat({ history: geminiHistory });
    let { result, chat: activeChat, model: usedModel } = await sendWithFallback(message, chat);
    chat = activeChat;

    // ⭐ Log token usage để verify implicit cache đang hoạt động
    //   Nếu cachedContentTokenCount > 0 → cache hit, đang tiết kiệm 75% phần đó
    //   Nếu = 0 sau vài request → cache miss, cần check prefix có ổn định không
    try {
      const usage = result?.response?.usageMetadata;
      if (usage) {
        const cached = usage.cachedContentTokenCount || 0;
        const total = usage.promptTokenCount || 0;
        const cacheRate = total > 0 ? ((cached / total) * 100).toFixed(0) : 0;
        console.log(`[Chat] Tokens: prompt=${total}, cached=${cached} (${cacheRate}%), output=${usage.candidatesTokenCount || 0}, model=${usedModel}`);
      }
    } catch (e) { /* ignore */ }

    let iterations = 0;
    const MAX_ITER = 5;                    // ⭐ Tier 1: cho phép câu hỏi phức tạp hơn
    const allToolCalls = [];               // ⭐ Track để lưu DB

    while (iterations < MAX_ITER) {
      const calls = result.response.functionCalls?.() || [];
      if (calls.length === 0) break;

      console.log(`[Chat] Iter ${iterations} (${usedModel}) - tools:`, calls.map(c => c.name).join(', '));

      const toolResults = await Promise.all(calls.map(async (call) => {
        const handler = handlers[call.name];
        if (!handler) {
          allToolCalls.push({ name: call.name, args: call.args, error: 'Unknown tool' });
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
          allToolCalls.push({ name: call.name, args: call.args, result: cached, durationMs: 0 });
          return { functionResponse: { name: call.name, response: cached } };
        }

        const t0 = Date.now();
        try {
          const data = await handler(call.args || {});
          setCachedTool(cacheKey, data);   // ⭐ Cache 60s
          const durationMs = Date.now() - t0;
          console.log(`[Chat] Tool ${call.name} OK:`, JSON.stringify(data).slice(0, 200));
          allToolCalls.push({ name: call.name, args: call.args, result: data, durationMs });
          return { functionResponse: { name: call.name, response: data } };
        } catch (err) {
          const durationMs = Date.now() - t0;
          console.error(`[Chat] Tool ${call.name} ERROR:`, err.message);
          allToolCalls.push({ name: call.name, args: call.args, error: err.message, durationMs });
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

    let replyText = result.response.text?.() || '';
    if (!replyText.trim()) {
      // ⭐ Log CHI TIẾT để debug khi response rỗng
      //   Có thể do: safety filter, recitation, no function calls, etc.
      console.warn('[Chat] Empty response from Gemini. User msg:', message.slice(0, 100));
      console.warn('[Chat] Last function calls:', result.response.functionCalls?.() || 'none');

      // ⭐ NEW: Log promptFeedback + finishReason để biết lý do block
      try {
        const candidates = result.response.candidates || [];
        if (candidates.length > 0) {
          console.warn('[Chat] Finish reason:', candidates[0].finishReason);
          console.warn('[Chat] Safety ratings:', JSON.stringify(candidates[0].safetyRatings || []));
        }
        const pf = result.response.promptFeedback;
        if (pf) {
          console.warn('[Chat] Prompt feedback:', JSON.stringify(pf));
        }
      } catch (e) {
        console.warn('[Chat] Cannot extract debug info:', e.message);
      }

      replyText = 'Dạ em chưa hiểu rõ câu hỏi của anh/chị ạ. Anh/chị có thể diễn đạt lại được không ạ?';
    }

    // ⭐ Sinh messageId để FE track + submit feedback sau này
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    // ⭐ SUGGESTIONS — sinh từ 2 nguồn rồi merge
    //   1. AI tự đề xuất qua block [SUGGESTIONS]...[/SUGGESTIONS] trong reply
    //   2. Mẫu chuẩn dựa trên tool gần nhất
    let cleanReply = replyText;
    let suggestions = [];
    try {
      const aiParsed = parseAiSuggestions(replyText);
      cleanReply = aiParsed.cleanReply;
      const standardSugs = buildStandardSuggestions(allToolCalls, ctx);
      suggestions = mergeSuggestions(aiParsed.suggestions, standardSugs, 5);
    } catch (e) {
      console.warn('[Chat] Build suggestions failed (non-fatal):', e.message);
    }

    // ⭐ Lưu vào DB
    //   ensureSession: AWAIT (cần dbSessionId trả về FE để link)
    //   saveUserMessage + saveAssistantMessage: fire-and-forget (không chặn response)
    const willPersist = !!(persistence && ctx.userId && ctx.isInternal);
    console.log(`[Chat] DB persist:`, {
      willPersist,
      hasPersistenceService: !!persistence,
      hasUserId: !!ctx.userId,
      isInternal: ctx.isInternal,
      userId: ctx.userId,
      role: ctx.role,
      clientSessionId,
    });

    let dbSessionId = null;        // ⭐ Trả về FE để map với session local

    if (willPersist) {
      try {
        console.log(`[Chat] DB ensureSession: userId=${ctx.userId}, sessionId=${clientSessionId}`);
        const session = await persistence.ensureSession({
          sessionId: clientSessionId,
          userId: ctx.userId,
          userName: ctx.userName,
          userRole: ctx.role,
          branchId: ctx.userBranchId,
          branchName: userBranchName,
          firstMessage: message,
        });
        dbSessionId = session?._id?.toString() || null;
        console.log(`[Chat] DB session:`, dbSessionId);

        if (session) {
          // Save messages BACKGROUND — không chặn response cho user
          (async () => {
            try {
              const userMsg = await persistence.saveUserMessage(session, { text: message });
              console.log(`[Chat] DB saved user msg:`, userMsg?._id?.toString());

              const usage = result?.response?.usageMetadata || {};
              const aiMsg = await persistence.saveAssistantMessage(session, {
                text: cleanReply,
                toolCalls: allToolCalls,
                tokensUsed: {
                  prompt: usage.promptTokenCount || 0,
                  cached: usage.cachedContentTokenCount || 0,
                  output: usage.candidatesTokenCount || 0,
                },
                modelUsed: usedModel,
                iterations,
                messageId,
              });
              console.log(`[Chat] DB saved AI msg:`, aiMsg?._id?.toString());
            } catch (err) {
              console.error('[Chat] ❌ Save messages FAILED:', err.message);
            }
          })();
        }
      } catch (err) {
        console.error('[Chat] ❌ ensureSession FAILED:', err.message);
        console.error(err.stack);
      }
    }

    res.json({
      reply: cleanReply,                // ⭐ Đã clean block [SUGGESTIONS]
      suggestions,                       // ⭐ Array buttons [{id, label, value}]
      messageId,                         // ⭐ FE dùng cho feedback
      dbSessionId,                       // ⭐ MongoDB _id của session — FE link với session local
      iterations,
      modelUsed: usedModel,
      scope: {
        role: ctx.role,
        branch: userBranchName || (ctx.role === 'Admin' ? 'Tất cả' : 'Chưa gán'),
      },
      // ⭐ NEW 14/05/2026: Báo cho FE biết tool nào đã chạy thành công
      //   để FE trigger reload các trang liên quan (sơ đồ phòng, dashboard...)
      dataChanged: (() => {
        // Map tên tool thật → loại action cho FE (RoomMapPage đọc field `types`)
        const TOOL_ACTION_MAP = {
          create_booking:        'create_booking',
          confirm_checkin:       'check_in_booking',
          confirm_cancellation:  'cancel_booking',
        };
 
        // Chỉ lấy tool đã chạy THÀNH CÔNG (không error + result.success !== false)
        const changedTools = allToolCalls.filter(t => {
          if (t.error) return false;
          if (!TOOL_ACTION_MAP[t.name]) return false;
          // prepare_* trả _previewOnly; các confirm/create trả success:true
          //   create_booking & confirm_* khi lỗi nghiệp vụ trả { error: '...' } (đã loại ở trên),
          //   khi thành công trả { success: true }. Chặn thêm trường hợp result.error.
          if (t.result?.error) return false;
          if (t.result?.success === false) return false;
          return true;
        });
 
        if (changedTools.length === 0) return null;
 
        // Tìm booking code từ tool vừa chạy (create / checkin / cancel đều trả bookingCode)
        const pickCode = (toolName) =>
          changedTools.find(t => t.name === toolName)?.result?.bookingCode ?? null;
 
        return {
          // FE đọc `types` để hiện toast tương ứng (đã map sang tên FE quen thuộc)
          types: [...new Set(changedTools.map(t => TOOL_ACTION_MAP[t.name]))],
          // createdBookingCode → chỉ set khi vừa ĐẶT PHÒNG MỚI (FE hiện toast "✨ AI vừa đặt phòng")
          createdBookingCode: pickCode('create_booking'),
          // bookingCode chung (cho check-in / hủy) — FE có thể dùng nếu cần
          bookingCode: pickCode('create_booking')
            || pickCode('confirm_checkin')
            || pickCode('confirm_cancellation'),
        };
      })(),
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
    contextCache: getCacheStats(),
  });
});

// ============================================================
// ⭐ NEW: Verify Gemini API key
//   - GET /api/chat/verify-key
//   - Gọi Google models.list để check key có hợp lệ không
//   - Trả về: { valid, tier, modelsAvailable, error?, latencyMs }
// ============================================================
router.get('/verify-key', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.json({
      valid: false,
      error: 'GEMINI_API_KEY chưa được cấu hình trong .env',
      suggestion: 'Thêm GEMINI_API_KEY=xxx vào file .env',
    });
  }

  const startTime = Date.now();

  try {
    // Gọi Google API list models
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    const latencyMs = Date.now() - startTime;
    const data = await response.json();

    // Key invalid
    if (!response.ok) {
      return res.json({
        valid: false,
        statusCode: response.status,
        error: data?.error?.message || `HTTP ${response.status}`,
        details: data?.error,
        latencyMs,
        suggestion: response.status === 400
          ? 'API key không đúng định dạng hoặc đã bị thu hồi. Kiểm tra lại tại https://aistudio.google.com/app/apikey'
          : response.status === 403
          ? 'API key không có quyền truy cập. Có thể chưa enable Generative Language API.'
          : 'Có lỗi khi gọi Google API. Vui lòng thử lại.',
      });
    }

    // Key OK
    const models = data?.models || [];
    const flashModels = models.filter(m => m.name?.includes('gemini-2.5'));
    const fallbackModels = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];
    const availableFallbacks = fallbackModels.filter(fb =>
      models.some(m => m.name?.endsWith(fb))
    );

    // Thử thêm 1 generateContent nhỏ để check quota
    let testCall = null;
    try {
      const testStart = Date.now();
      const testRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'OK' }] }],
            generationConfig: { maxOutputTokens: 5 },
          }),
        }
      );
      const testData = await testRes.json();
      const testLatency = Date.now() - testStart;

      if (testRes.ok) {
        testCall = {
          ok: true,
          model: 'gemini-2.5-flash',
          latencyMs: testLatency,
          tokensUsed: testData?.usageMetadata?.totalTokenCount || null,
        };
      } else {
        testCall = {
          ok: false,
          statusCode: testRes.status,
          error: testData?.error?.message,
          isQuotaError: testRes.status === 429,
          isOverloaded: testRes.status === 503,
        };
      }
    } catch (err) {
      testCall = { ok: false, error: err.message };
    }

    return res.json({
      valid: true,
      latencyMs,
      keyPreview: apiKey.slice(0, 6) + '...' + apiKey.slice(-4),
      totalModels: models.length,
      gemini25Models: flashModels.length,
      availableFallbacks,
      missingFallbacks: fallbackModels.filter(fb => !availableFallbacks.includes(fb)),
      testCall,
      message: testCall?.ok
        ? '✅ API key hợp lệ và còn quota'
        : testCall?.isQuotaError
        ? '⚠️ API key hợp lệ nhưng đã HẾT QUOTA'
        : testCall?.isOverloaded
        ? '⚠️ API key hợp lệ nhưng Google đang quá tải (503)'
        : '⚠️ API key hợp lệ nhưng có vấn đề khi test gọi model',
    });
  } catch (err) {
    return res.status(500).json({
      valid: false,
      error: err.message,
      latencyMs: Date.now() - startTime,
      suggestion: 'Có thể do mạng/firewall. Kiểm tra có thể access generativelanguage.googleapis.com không.',
    });
  }
});

module.exports = router;