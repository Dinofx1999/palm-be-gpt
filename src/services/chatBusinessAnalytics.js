// backend/src/services/chatBusinessAnalytics.js
// ============================================================
// Module phân tích kinh doanh cho AI Chat
//   - get_business_kpi:        KPI cơ bản (occupancy, ADR, RevPAR, doanh thu, ALOS)
//   - analyze_revenue_trend:   Xu hướng doanh thu 6-12 tháng
//   - analyze_room_performance: Phân tích loại phòng nào ế / hot
//   - get_strategy_recommendations: Tổng hợp + đề xuất chiến lược
// ============================================================

const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Room = require('../models/Room');
const RoomType = require('../models/RoomType');
const Branch = require('../models/Branch');
const Invoice = require('../models/Invoice');

const fmt = (n) => Number(n || 0).toLocaleString('vi-VN') + 'đ';
const fmtPct = (n) => `${Number(n || 0).toFixed(1)}%`;

// ============================================================
// Helper: parse khoảng thời gian từ input
// ============================================================
function parsePeriod(fromDate, toDate) {
  const from = fromDate ? new Date(fromDate) : new Date();
  if (!fromDate) from.setDate(1);   // Đầu tháng nếu không truyền
  from.setHours(0, 0, 0, 0);

  const to = toDate ? new Date(toDate) : new Date();
  to.setHours(23, 59, 59, 999);

  const daysInPeriod = Math.max(1, Math.ceil((to - from) / 86400000));
  return { from, to, daysInPeriod };
}

// ============================================================
// 1. KPI CƠ BẢN
// ============================================================
async function getBusinessKPI({ fromDate, toDate, branchName, ctx }) {
  if (!ctx?.isInternal) {
    return { error: 'external_not_allowed', message: 'Thông tin KPI chỉ dành cho nhân viên ạ.' };
  }

  const { from, to, daysInPeriod } = parsePeriod(fromDate, toDate);

  // Resolve branchId
  let branchId = null;
  let branchInfo = null;
  if (branchName) {
    const branch = await Branch.findOne({
      name: new RegExp(branchName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    }).lean();
    if (!branch) return { error: 'branch_not_found', message: `Không tìm thấy chi nhánh "${branchName}"` };
    branchId = branch._id;
    branchInfo = branch;
  } else if (ctx.role !== 'Admin' && ctx.userBranchId) {
    branchId = ctx.userBranchId;
    branchInfo = await Branch.findById(branchId).lean();
  }

  // ─── Đếm tổng số phòng có sẵn ───
  const roomFilter = { roomStatus: { $ne: 'inactive' } };
  if (branchId) roomFilter.branchId = branchId;
  const totalRooms = await Room.countDocuments(roomFilter);

  if (totalRooms === 0) {
    return { error: 'no_rooms', message: 'Chi nhánh chưa có phòng nào hoạt động.' };
  }

  // ─── Booking đã checkout trong period (để tính revenue thực) ───
  const bookingMatch = {
    status: 'checked_out',
    actualCheckOut: { $gte: from, $lte: to },
  };
  if (branchId) {
    bookingMatch.branchId = mongoose.Types.ObjectId.isValid(branchId)
      ? new mongoose.Types.ObjectId(branchId) : branchId;
  }

  const checkedOutBookings = await Booking.find(bookingMatch)
    .select('totalAmount roomAmount nights adults children customerId isGroup rooms')
    .lean();

  // ─── Tính KPI ───
  const totalRevenue = checkedOutBookings.reduce((s, b) => s + (b.totalAmount || 0), 0);
  const totalRoomRevenue = checkedOutBookings.reduce((s, b) => s + (b.roomAmount || 0), 0);

  // Tổng số đêm phòng đã bán (room-nights)
  let totalRoomNights = 0;
  let totalGuests = 0;
  for (const b of checkedOutBookings) {
    if (b.isGroup && Array.isArray(b.rooms)) {
      for (const sr of b.rooms) {
        if (sr.status === 'cancelled') continue;
        totalRoomNights += (sr.nights || b.nights || 1);
      }
    } else {
      totalRoomNights += (b.nights || 1);
    }
    totalGuests += (b.adults || 0) + (b.children || 0);
  }

  // Available room-nights = tổng phòng × số ngày trong period
  const availableRoomNights = totalRooms * daysInPeriod;

  // Occupancy rate (%)
  const occupancyRate = availableRoomNights > 0
    ? (totalRoomNights / availableRoomNights) * 100
    : 0;

  // ADR (Average Daily Rate) = doanh thu phòng / số phòng-đêm đã bán
  const adr = totalRoomNights > 0 ? totalRoomRevenue / totalRoomNights : 0;

  // RevPAR (Revenue Per Available Room) = doanh thu / tổng phòng-đêm có sẵn
  const revPar = availableRoomNights > 0 ? totalRoomRevenue / availableRoomNights : 0;

  // ALOS (Average Length Of Stay)
  const totalBookings = checkedOutBookings.length;
  const alos = totalBookings > 0 ? totalRoomNights / totalBookings : 0;

  // Repeat customers (khách quay lại)
  const uniqueCustomers = new Set(checkedOutBookings.map(b => String(b.customerId)).filter(Boolean));
  let repeatCount = 0;
  if (uniqueCustomers.size > 0) {
    const customerCounts = {};
    for (const b of checkedOutBookings) {
      const k = String(b.customerId);
      customerCounts[k] = (customerCounts[k] || 0) + 1;
    }
    repeatCount = Object.values(customerCounts).filter(c => c > 1).length;
  }
  const repeatRate = uniqueCustomers.size > 0 ? (repeatCount / uniqueCustomers.size) * 100 : 0;

  // Cancel rate
  const cancelledCount = await Booking.countDocuments({
    ...(branchId ? { branchId } : {}),
    status: 'cancelled',
    createdAt: { $gte: from, $lte: to },
  });
  const totalCreatedCount = await Booking.countDocuments({
    ...(branchId ? { branchId } : {}),
    createdAt: { $gte: from, $lte: to },
  });
  const cancelRate = totalCreatedCount > 0 ? (cancelledCount / totalCreatedCount) * 100 : 0;

  return {
    period: {
      from: from.toISOString().split('T')[0],
      to: to.toISOString().split('T')[0],
      days: daysInPeriod,
    },
    scope: branchInfo?.name || 'Tất cả chi nhánh',
    totalRooms,
    availableRoomNights,
    soldRoomNights: totalRoomNights,
    totalBookings,
    totalRevenue,
    totalRevenueFormatted: fmt(totalRevenue),
    totalRoomRevenue,
    totalRoomRevenueFormatted: fmt(totalRoomRevenue),
    kpis: {
      occupancyRate: Number(occupancyRate.toFixed(1)),
      occupancyRateFormatted: fmtPct(occupancyRate),
      adr: Math.round(adr),
      adrFormatted: fmt(adr),
      revPar: Math.round(revPar),
      revParFormatted: fmt(revPar),
      alos: Number(alos.toFixed(1)),
      alosFormatted: `${alos.toFixed(1)} đêm`,
      uniqueCustomers: uniqueCustomers.size,
      repeatCustomers: repeatCount,
      repeatRate: Number(repeatRate.toFixed(1)),
      repeatRateFormatted: fmtPct(repeatRate),
      cancelRate: Number(cancelRate.toFixed(1)),
      cancelRateFormatted: fmtPct(cancelRate),
      totalGuests,
    },
    _benchmark: {
      // Tham chiếu industry — khách sạn 2-star VN
      occupancyHealthy: 60,    // > 60% là tốt
      adrTarget: 500000,
      revParTarget: 300000,
      alosTarget: 1.5,
      repeatRateHealthy: 20,
      cancelRateMax: 15,
    },
  };
}

// ============================================================
// 2. TREND DOANH THU (so sánh các tháng/tuần)
// ============================================================
async function analyzeRevenueTrend({ months = 6, branchName, ctx }) {
  if (!ctx?.isInternal) {
    return { error: 'external_not_allowed', message: 'Thông tin này chỉ dành cho nhân viên ạ.' };
  }

  // Resolve branchId
  let branchId = null;
  let branchInfo = null;
  if (branchName) {
    const branch = await Branch.findOne({
      name: new RegExp(branchName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    }).lean();
    if (branch) {
      branchId = branch._id;
      branchInfo = branch;
    }
  } else if (ctx.role !== 'Admin' && ctx.userBranchId) {
    branchId = ctx.userBranchId;
    branchInfo = await Branch.findById(branchId).lean();
  }

  const now = new Date();
  const monthlyData = [];

  for (let i = months - 1; i >= 0; i--) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1, 0, 0, 0, 0);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59, 999);

    const match = {
      status: 'checked_out',
      actualCheckOut: { $gte: monthStart, $lte: monthEnd },
    };
    if (branchId) {
      match.branchId = mongoose.Types.ObjectId.isValid(branchId)
        ? new mongoose.Types.ObjectId(branchId) : branchId;
    }

    const bookings = await Booking.find(match)
      .select('totalAmount roomAmount nights isGroup rooms')
      .lean();

    const revenue = bookings.reduce((s, b) => s + (b.totalAmount || 0), 0);
    const roomNights = bookings.reduce((s, b) => {
      if (b.isGroup && Array.isArray(b.rooms)) {
        return s + b.rooms.filter(sr => sr.status !== 'cancelled')
          .reduce((ss, sr) => ss + (sr.nights || b.nights || 1), 0);
      }
      return s + (b.nights || 1);
    }, 0);

    const daysInMonth = Math.ceil((monthEnd - monthStart) / 86400000);

    const roomFilter = { roomStatus: { $ne: 'inactive' } };
    if (branchId) roomFilter.branchId = branchId;
    const totalRooms = await Room.countDocuments(roomFilter);
    const availableNights = totalRooms * daysInMonth;
    const occupancy = availableNights > 0 ? (roomNights / availableNights) * 100 : 0;
    const adr = roomNights > 0 ? revenue / roomNights : 0;

    monthlyData.push({
      label: `${String(monthStart.getMonth() + 1).padStart(2, '0')}/${monthStart.getFullYear()}`,
      month: monthStart.getMonth() + 1,
      year: monthStart.getFullYear(),
      revenue,
      revenueFormatted: fmt(revenue),
      bookings: bookings.length,
      roomNights,
      occupancy: Number(occupancy.toFixed(1)),
      occupancyFormatted: fmtPct(occupancy),
      adr: Math.round(adr),
      adrFormatted: fmt(adr),
    });
  }

  // Phân tích trend
  const insights = [];
  if (monthlyData.length >= 2) {
    const last = monthlyData[monthlyData.length - 1];
    const prev = monthlyData[monthlyData.length - 2];
    const revChange = prev.revenue > 0 ? ((last.revenue - prev.revenue) / prev.revenue) * 100 : 0;
    const occChange = last.occupancy - prev.occupancy;

    insights.push({
      type: revChange >= 5 ? 'positive' : (revChange <= -5 ? 'negative' : 'neutral'),
      label: `Doanh thu ${last.label} ${revChange >= 0 ? 'tăng' : 'giảm'} ${Math.abs(revChange).toFixed(1)}% so với ${prev.label}`,
      value: revChange,
    });
    insights.push({
      type: occChange >= 5 ? 'positive' : (occChange <= -5 ? 'negative' : 'neutral'),
      label: `Công suất phòng ${occChange >= 0 ? 'tăng' : 'giảm'} ${Math.abs(occChange).toFixed(1) }% (${prev.occupancyFormatted} → ${last.occupancyFormatted})`,
      value: occChange,
    });
  }

  if (monthlyData.length >= 3) {
    // Tháng cao nhất / thấp nhất
    const maxMonth = monthlyData.reduce((a, b) => a.revenue > b.revenue ? a : b);
    const minMonth = monthlyData.reduce((a, b) => a.revenue < b.revenue ? a : b);
    insights.push({
      type: 'info',
      label: `Tháng ${maxMonth.label} doanh thu cao nhất: ${maxMonth.revenueFormatted}`,
    });
    insights.push({
      type: 'info',
      label: `Tháng ${minMonth.label} thấp nhất: ${minMonth.revenueFormatted}`,
    });
  }

  return {
    scope: branchInfo?.name || 'Tất cả chi nhánh',
    months,
    monthlyData,
    insights,
  };
}

// ============================================================
// 3. PHÂN TÍCH LOẠI PHÒNG (loại nào hot, loại nào ế)
// ============================================================
async function analyzeRoomPerformance({ fromDate, toDate, branchName, ctx }) {
  if (!ctx?.isInternal) {
    return { error: 'external_not_allowed', message: 'Thông tin này chỉ dành cho nhân viên ạ.' };
  }

  const { from, to, daysInPeriod } = parsePeriod(fromDate, toDate);

  let branchId = null;
  let branchInfo = null;
  if (branchName) {
    const branch = await Branch.findOne({
      name: new RegExp(branchName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    }).lean();
    if (branch) { branchId = branch._id; branchInfo = branch; }
  } else if (ctx.role !== 'Admin' && ctx.userBranchId) {
    branchId = ctx.userBranchId;
    branchInfo = await Branch.findById(branchId).lean();
  }

  // Lấy tất cả room types có trong chi nhánh
  const allTypes = await RoomType.find({}).lean();

  const roomTypePerf = [];

  for (const type of allTypes) {
    // Số phòng của loại này
    const roomFilter = { typeId: type._id, roomStatus: { $ne: 'inactive' } };
    if (branchId) roomFilter.branchId = branchId;
    const roomsOfType = await Room.find(roomFilter).select('_id').lean();
    if (roomsOfType.length === 0) continue;
    const roomIds = roomsOfType.map(r => r._id);

    // Bookings đã checkout của loại này trong period
    const bookingMatch = {
      status: 'checked_out',
      actualCheckOut: { $gte: from, $lte: to },
      $or: [
        { roomId: { $in: roomIds } },
        { 'rooms.roomId': { $in: roomIds } },
      ],
    };
    if (branchId) {
      bookingMatch.branchId = mongoose.Types.ObjectId.isValid(branchId)
        ? new mongoose.Types.ObjectId(branchId) : branchId;
    }

    const bookings = await Booking.find(bookingMatch)
      .select('totalAmount roomAmount nights isGroup rooms roomId')
      .lean();

    let roomNightsSold = 0;
    let revenue = 0;
    for (const b of bookings) {
      if (b.isGroup && Array.isArray(b.rooms)) {
        for (const sr of b.rooms) {
          if (sr.status === 'cancelled') continue;
          if (roomIds.some(rid => String(rid) === String(sr.roomId?._id ?? sr.roomId))) {
            roomNightsSold += (sr.nights || b.nights || 1);
            revenue += (sr.roomAmount || 0);
          }
        }
      } else {
        roomNightsSold += (b.nights || 1);
        revenue += (b.totalAmount || 0);
      }
    }

    const availableNights = roomsOfType.length * daysInPeriod;
    const occupancy = availableNights > 0 ? (roomNightsSold / availableNights) * 100 : 0;
    const adr = roomNightsSold > 0 ? revenue / roomNightsSold : 0;

    roomTypePerf.push({
      typeName: type.name,
      totalRoomsOfType: roomsOfType.length,
      bookings: bookings.length,
      roomNightsSold,
      availableNights,
      revenue,
      revenueFormatted: fmt(revenue),
      occupancy: Number(occupancy.toFixed(1)),
      occupancyFormatted: fmtPct(occupancy),
      adr: Math.round(adr),
      adrFormatted: fmt(adr),
    });
  }

  // Sort theo doanh thu giảm dần
  roomTypePerf.sort((a, b) => b.revenue - a.revenue);

  // Phân loại
  const total = roomTypePerf.reduce((s, t) => s + t.revenue, 0);
  for (const t of roomTypePerf) {
    t.revenueShare = total > 0 ? Number(((t.revenue / total) * 100).toFixed(1)) : 0;
    t.revenueShareFormatted = fmtPct(t.revenueShare);
    if (t.occupancy >= 70) t.category = 'hot';        // Hot
    else if (t.occupancy >= 40) t.category = 'normal'; // Bình thường
    else t.category = 'slow';                          // Ế
  }

  return {
    period: {
      from: from.toISOString().split('T')[0],
      to: to.toISOString().split('T')[0],
      days: daysInPeriod,
    },
    scope: branchInfo?.name || 'Tất cả chi nhánh',
    roomTypes: roomTypePerf,
    totalRevenue: total,
    totalRevenueFormatted: fmt(total),
  };
}

// ============================================================
// 4. PHÂN TÍCH NGÀY TUẦN (thứ mấy ế, thứ mấy đông)
// ============================================================
async function analyzeWeekdayPattern({ fromDate, toDate, branchName, ctx }) {
  if (!ctx?.isInternal) {
    return { error: 'external_not_allowed', message: 'Thông tin này chỉ dành cho nhân viên ạ.' };
  }

  const { from, to } = parsePeriod(fromDate, toDate);

  let branchId = null;
  if (branchName) {
    const branch = await Branch.findOne({
      name: new RegExp(branchName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    }).lean();
    if (branch) branchId = branch._id;
  } else if (ctx.role !== 'Admin' && ctx.userBranchId) {
    branchId = ctx.userBranchId;
  }

  const match = {
    status: 'checked_out',
    actualCheckIn: { $gte: from, $lte: to },
  };
  if (branchId) {
    match.branchId = mongoose.Types.ObjectId.isValid(branchId)
      ? new mongoose.Types.ObjectId(branchId) : branchId;
  }

  const bookings = await Booking.find(match)
    .select('actualCheckIn totalAmount nights')
    .lean();

  // Weekday 0=CN, 1=T2, ..., 6=T7
  const weekdayNames = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
  const weekdayStats = Array.from({ length: 7 }, (_, i) => ({
    weekday: i,
    name: weekdayNames[i],
    bookings: 0,
    revenue: 0,
    roomNights: 0,
  }));

  for (const b of bookings) {
    const wd = new Date(b.actualCheckIn).getDay();
    weekdayStats[wd].bookings += 1;
    weekdayStats[wd].revenue += (b.totalAmount || 0);
    weekdayStats[wd].roomNights += (b.nights || 1);
  }

  weekdayStats.forEach(w => {
    w.revenueFormatted = fmt(w.revenue);
    w.avgRevenuePerBooking = w.bookings > 0 ? Math.round(w.revenue / w.bookings) : 0;
  });

  // Sort: thứ 2 đầu, CN cuối
  const sorted = [weekdayStats[1], weekdayStats[2], weekdayStats[3], weekdayStats[4], weekdayStats[5], weekdayStats[6], weekdayStats[0]];

  // Tìm peak / slow
  const peakDay = sorted.reduce((a, b) => a.bookings > b.bookings ? a : b);
  const slowDay = sorted.reduce((a, b) => a.bookings < b.bookings ? a : b);

  return {
    period: {
      from: from.toISOString().split('T')[0],
      to: to.toISOString().split('T')[0],
    },
    weekdayStats: sorted,
    peakDay: { name: peakDay.name, bookings: peakDay.bookings, revenue: peakDay.revenueFormatted },
    slowDay: { name: slowDay.name, bookings: slowDay.bookings, revenue: slowDay.revenueFormatted },
  };
}

// ============================================================
// 5. ĐỀ XUẤT CHIẾN LƯỢC — Tổng hợp các phân tích trên
// ============================================================
async function getStrategyRecommendations({ fromDate, toDate, branchName, ctx }) {
  if (!ctx?.isInternal) {
    return { error: 'external_not_allowed' };
  }

  // Gọi 3 phân tích
  const [kpi, performance, weekdayPattern] = await Promise.all([
    getBusinessKPI({ fromDate, toDate, branchName, ctx }),
    analyzeRoomPerformance({ fromDate, toDate, branchName, ctx }),
    analyzeWeekdayPattern({ fromDate, toDate, branchName, ctx }),
  ]);

  if (kpi.error) return kpi;

  const recommendations = [];

  // ─── Phân tích occupancy ───
  if (kpi.kpis.occupancyRate < 40) {
    recommendations.push({
      severity: 'high',
      category: 'occupancy',
      issue: `Công suất phòng thấp (${kpi.kpis.occupancyRateFormatted}, dưới mức 40%)`,
      actions: [
        'Triển khai khuyến mãi cuối tuần / mùa thấp điểm (giảm 10-20% giá phòng)',
        'Đẩy mạnh quảng cáo trên OTA (Agoda, Booking.com)',
        'Tạo gói combo dài ngày (ở 3 đêm tính tiền 2)',
        'Liên kết tour địa phương để thu hút khách du lịch',
      ],
    });
  } else if (kpi.kpis.occupancyRate < 60) {
    recommendations.push({
      severity: 'medium',
      category: 'occupancy',
      issue: `Công suất phòng ở mức trung bình (${kpi.kpis.occupancyRateFormatted})`,
      actions: [
        'Tăng cường marketing kênh online (Facebook, Zalo)',
        'Khuyến mãi early-bird (đặt sớm giảm giá)',
        'Hợp tác với doanh nghiệp địa phương cho khách công vụ',
      ],
    });
  } else if (kpi.kpis.occupancyRate >= 80) {
    recommendations.push({
      severity: 'positive',
      category: 'occupancy',
      issue: `Công suất rất tốt (${kpi.kpis.occupancyRateFormatted})`,
      actions: [
        'Xem xét tăng giá phòng 5-10% vào mùa cao điểm',
        'Tăng giá phòng cuối tuần để tối ưu doanh thu',
        'Giảm bớt khuyến mãi (vì khách đông sẵn)',
      ],
    });
  }

  // ─── Phân tích loại phòng ế ───
  if (!performance.error && performance.roomTypes) {
    const slowTypes = performance.roomTypes.filter(t => t.category === 'slow' && t.totalRoomsOfType > 0);
    if (slowTypes.length > 0) {
      recommendations.push({
        severity: 'high',
        category: 'room_type',
        issue: `${slowTypes.length} loại phòng ế: ${slowTypes.map(t => `${t.typeName} (${t.occupancyFormatted})`).join(', ')}`,
        actions: [
          `Giảm giá ${slowTypes[0].typeName} 10-15% trong 1 tháng để test`,
          `Đầu tư nâng cấp ảnh + mô tả loại phòng ế`,
          `Đóng gói combo (vd ${slowTypes[0].typeName} + ăn sáng + đón sân bay)`,
          'Đào tạo lễ tân ưu tiên upsell các loại phòng ế khi khách walk-in',
        ],
      });
    }
    const hotTypes = performance.roomTypes.filter(t => t.category === 'hot');
    if (hotTypes.length > 0) {
      recommendations.push({
        severity: 'positive',
        category: 'room_type',
        issue: `${hotTypes.length} loại phòng đắt khách: ${hotTypes.map(t => `${t.typeName} (${t.occupancyFormatted})`).join(', ')}`,
        actions: [
          `Cân nhắc tăng giá ${hotTypes[0].typeName} 5-10%`,
          'Đào tạo upsell từ phòng tiêu chuẩn lên loại hot',
          'Đầu tư nâng cấp loại phòng này (đang sinh lời)',
        ],
      });
    }
  }

  // ─── Phân tích ADR ───
  if (kpi.kpis.adr < kpi._benchmark.adrTarget * 0.8) {
    recommendations.push({
      severity: 'medium',
      category: 'pricing',
      issue: `ADR thấp (${kpi.kpis.adrFormatted}, dưới mức kỳ vọng ${fmt(kpi._benchmark.adrTarget)})`,
      actions: [
        'Xem xét giảm chiết khấu / promotion quá tay',
        'Áp dụng dynamic pricing theo ngày tuần',
        'Tăng giá cuối tuần và ngày lễ',
        'Upsell sang phòng cao cấp hơn khi check-in',
      ],
    });
  }

  // ─── Phân tích ALOS (thời gian ở TB) ───
  if (kpi.kpis.alos < 1.3) {
    recommendations.push({
      severity: 'medium',
      category: 'length_of_stay',
      issue: `Thời gian ở TB ngắn (${kpi.kpis.alosFormatted})`,
      actions: [
        'Khuyến mãi "ở 2 đêm tặng 1 đêm thứ 3 giảm 50%"',
        'Combo nghỉ dưỡng cuối tuần (T6-CN)',
        'Tặng dịch vụ extra cho khách ở dài (đón sân bay, giặt ủi)',
      ],
    });
  }

  // ─── Phân tích cancel rate ───
  if (kpi.kpis.cancelRate > 20) {
    recommendations.push({
      severity: 'high',
      category: 'cancellation',
      issue: `Tỉ lệ hủy cao (${kpi.kpis.cancelRateFormatted}, vượt mức 20%)`,
      actions: [
        'Yêu cầu đặt cọc 30% khi đặt phòng',
        'Tính phí hủy nếu hủy trong 48h trước check-in',
        'Tăng cường xác nhận booking qua email/Zalo',
        'Phân tích chi tiết: nhóm khách nào hay hủy?',
      ],
    });
  }

  // ─── Phân tích repeat rate ───
  if (kpi.kpis.repeatRate < 15) {
    recommendations.push({
      severity: 'medium',
      category: 'loyalty',
      issue: `Tỉ lệ khách quay lại thấp (${kpi.kpis.repeatRateFormatted})`,
      actions: [
        'Thiết kế chương trình tích điểm (ở 5 lần tặng 1 đêm miễn phí)',
        'Gửi voucher giảm giá cho khách cũ qua SMS/Zalo (sinh nhật, lễ)',
        'Thu thập feedback sau check-out, gửi cảm ơn cá nhân hoá',
        'Xây dựng quan hệ với khách: gửi SMS chúc Tết, lễ',
      ],
    });
  }

  // ─── Phân tích ngày tuần (nếu có data) ───
  if (!weekdayPattern.error && weekdayPattern.weekdayStats) {
    const slow = weekdayPattern.slowDay;
    const peak = weekdayPattern.peakDay;
    if (slow.bookings > 0 && peak.bookings > slow.bookings * 2) {
      recommendations.push({
        severity: 'medium',
        category: 'weekday_pricing',
        issue: `${slow.name} rất vắng (${slow.bookings} booking), trong khi ${peak.name} đông (${peak.bookings} booking)`,
        actions: [
          `Giảm giá 15-20% cho khách check-in ${slow.name}`,
          `Tăng giá nhẹ vào ${peak.name} để tối ưu doanh thu`,
          `Triển khai gói "Trải nghiệm trong tuần" giá ưu đãi`,
        ],
      });
    }
  }

  return {
    period: kpi.period,
    scope: kpi.scope,
    summary: {
      occupancyRate: kpi.kpis.occupancyRateFormatted,
      adr: kpi.kpis.adrFormatted,
      revPar: kpi.kpis.revParFormatted,
      revenue: kpi.totalRevenueFormatted,
    },
    recommendations,
    issueCount: recommendations.filter(r => r.severity === 'high').length,
    _hint: 'Hiển thị summary + danh sách recommendations. Mỗi recommendation có issue + 2-4 actions. Ưu tiên hiển thị các issue severity="high" trước.',
  };
}

module.exports = {
  getBusinessKPI,
  analyzeRevenueTrend,
  analyzeRoomPerformance,
  analyzeWeekdayPattern,
  getStrategyRecommendations,
};