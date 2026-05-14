// backend/src/services/chatSuggestions.js
// ============================================================
// Sinh "suggestion buttons" mẫu chuẩn dựa trên tool nào vừa chạy
// Đây là FALLBACK — AI cũng có thể tự đề xuất qua text trong reply
// FE merge cả 2 nguồn, dedupe theo `value`
//
// Format suggestion: { id, label, value }
//   - id: unique key cho React (vd "book_opt_1")
//   - label: text hiển thị trên button (cụ thể chi tiết)
//   - value: text gửi đi khi user nhấn (giống user gõ)
// ============================================================

const fmt = (n) => Number(n || 0).toLocaleString('vi-VN') + 'đ';

// ============================================================
// Sinh suggestions dựa trên tool gần nhất + kết quả của nó
// ============================================================
function buildStandardSuggestions(allToolCalls, ctx) {
  if (!allToolCalls || allToolCalls.length === 0) return [];

  // Lấy TOOL CALL CUỐI CÙNG (gần response nhất → relevant nhất)
  const lastCall = allToolCalls[allToolCalls.length - 1];
  if (!lastCall || lastCall.error || !lastCall.result) return [];

  const { name, result } = lastCall;

  // ── 1. Sau check_room_availability → các option đặt phòng ──
  if (name === 'check_room_availability') {
    const recs = result?.recommendations || [];
    if (recs.length === 0) return [];

    const suggestions = [];
    recs.slice(0, 3).forEach((rec, idx) => {
      // ⭐ Lấy typeName từ rooms[0] nếu không có ở level option
      const typeName = rec.rooms?.[0]?.typeName || `phương án ${idx + 1}`;
      const total = rec.grandTotalFormatted || fmt(rec.grandTotal || 0);
      const totalRooms = rec.totalRooms || rec.rooms?.[0]?.quantity || 1;

      // ⭐ Lấy số phòng cụ thể (Internal user)
      const roomNumbers = rec.roomNumbers || rec.rooms?.[0]?.roomNumbers || [];
      const hasRoomNumbers = roomNumbers.length > 0;

      let label;
      let value;
      if (hasRoomNumbers) {
        // Internal: hiển thị SỐ PHÒNG
        const roomStr = roomNumbers.join(' + ');
        label = `Đặt phòng ${roomStr} - ${total}`;
        value = `Đặt giúp em phòng ${roomStr} (${totalRooms} phòng ${typeName}, tổng ${total})`;
      } else {
        // External: chỉ hiển thị tên loại + số lượng
        label = `Đặt ${totalRooms} phòng ${typeName} - ${total}`;
        value = `Đặt giúp em tùy chọn ${idx + 1}: ${totalRooms} phòng ${typeName}, tổng ${total}`;
      }

      suggestions.push({
        id: `book_opt_${idx + 1}`,
        label,
        value,
      });
    });

    // Action phụ
    suggestions.push({
      id: 'view_images',
      label: 'Xem ảnh các phòng',
      value: 'Cho em xem ảnh các phòng đề xuất',
    });

    return suggestions;
  }

  // ── 2. Sau prepare_booking_confirmation → confirm hoặc hủy ──
  if (name === 'prepare_booking_confirmation') {
    if (result.error) return [];

    const customerName = result.customerName || result.customer?.name || 'khách';
    const roomNum = result.roomNumber || result.room?.number || '';
    const totalStr = result.totalAmountFormatted || fmt(result.totalAmount || 0);

    return [
      {
        id: 'confirm_booking',
        label: `✓ Xác nhận đặt phòng ${roomNum} - ${totalStr}`,
        value: `Xác nhận đặt phòng. Đồng ý tất cả thông tin.`,
      },
      {
        id: 'change_info',
        label: 'Đổi thông tin (ngày/phòng/khách)',
        value: 'Em muốn đổi thông tin đặt phòng',
      },
      {
        id: 'cancel_booking',
        label: '✗ Hủy không đặt nữa',
        value: 'Thôi không đặt nữa',
      },
    ];
  }

  // ── 3. Sau create_booking thành công → xem booking + đặt tiếp ──
  if (name === 'create_booking' && result.success) {
    const bookingCode = result.bookingCode || '';
    return [
      {
        id: 'view_booking',
        label: `Xem chi tiết ${bookingCode}`,
        value: `Cho em xem chi tiết booking ${bookingCode}`,
      },
      {
        id: 'book_more',
        label: 'Đặt thêm phòng nữa',
        value: 'Em muốn đặt thêm phòng',
      },
      {
        id: 'today_arrivals',
        label: 'Xem danh sách khách hôm nay',
        value: 'Cho em xem danh sách khách check-in hôm nay',
      },
    ];
  }

  // ── 4. Sau check_specific_room → đặt phòng hoặc xem khác ──
  if (name === 'check_specific_room' && !result.notFound) {
    const roomNum = result.roomNumber || '';
    const roomType = result.roomType || '';
    const isAvailable = result.availabilityCheck?.isAvailable !== false
      && result.status === 'active'
      && !result.currentGuest;

    const suggestions = [];
    if (isAvailable) {
      suggestions.push({
        id: 'book_this_room',
        label: `Đặt phòng ${roomNum} - ${roomType}`,
        value: `Em muốn đặt phòng ${roomNum}`,
      });
    }
    suggestions.push({
      id: 'view_room_image',
      label: `Xem ảnh phòng ${roomNum}`,
      value: `Cho em xem ảnh phòng ${roomNum}`,
    });
    suggestions.push({
      id: 'check_other_room',
      label: 'Tìm phòng khác phù hợp',
      value: 'Em muốn tìm phòng khác phù hợp',
    });
    return suggestions;
  }

  // ── 5. Sau get_my_kpi → gợi ý cải thiện + lịch sử ──
  if (name === 'get_my_kpi' && result.hasKpi !== false) {
    const status = result.status;
    const userName = result.userName || '';
    const suggestions = [];

    if (status === 'behind' || status === 'close') {
      suggestions.push({
        id: 'kpi_suggest',
        label: 'Gợi ý cách đạt KPI tháng này',
        value: 'Em làm sao để đạt KPI tháng này?',
      });
    }
    suggestions.push({
      id: 'salary_now',
      label: 'Xem lương tháng này',
      value: 'Cho em xem lương tháng này của em',
    });
    suggestions.push({
      id: 'salary_history',
      label: 'Lịch sử lương 6 tháng',
      value: 'Cho em xem lịch sử lương 6 tháng vừa rồi',
    });
    return suggestions;
  }

  // ── 6. Sau get_my_salary ──
  if (name === 'get_my_salary' && !result.error) {
    return [
      {
        id: 'kpi_detail',
        label: 'Chi tiết KPI tháng này',
        value: 'Cho em xem chi tiết KPI tháng này',
      },
      {
        id: 'kpi_suggest',
        label: 'Gợi ý cải thiện KPI',
        value: 'Em làm sao để đạt KPI cao hơn?',
      },
      {
        id: 'salary_history',
        label: 'Lịch sử lương 6 tháng',
        value: 'Cho em xem lịch sử lương 6 tháng vừa rồi',
      },
    ];
  }

  // ── 7. Sau get_branch_kpi_overview / get_top_employees ──
  if (name === 'get_branch_kpi_overview' && !result.error) {
    const bn = result.branchName || '';
    return [
      {
        id: 'top_revenue',
        label: 'Top 5 nhân viên doanh thu',
        value: `Cho em xem top 5 nhân viên doanh thu cao nhất ${bn}`,
      },
      {
        id: 'top_kpi',
        label: 'Top nhân viên % KPI',
        value: `Top nhân viên đạt % KPI cao nhất ${bn}`,
      },
      {
        id: 'branch_strategy',
        label: 'Đề xuất chiến lược tăng KPI branch',
        value: `Đề xuất chiến lược để tăng KPI ${bn}`,
      },
    ];
  }

  if (name === 'get_top_employees' && !result.error) {
    const top = result.top || [];
    if (top.length === 0) return [];
    return [
      {
        id: 'top_revenue',
        label: 'Xếp theo doanh thu',
        value: 'Cho em xem top nhân viên xếp theo doanh thu',
      },
      {
        id: 'top_kpi',
        label: 'Xếp theo % KPI',
        value: 'Cho em xem top nhân viên xếp theo % KPI đạt được',
      },
      {
        id: 'top_salary',
        label: 'Xếp theo lương',
        value: 'Cho em xem top nhân viên xếp theo lương cao nhất',
      },
    ];
  }

  // ── 8. Sau get_business_kpi → các phân tích khác ──
  if (name === 'get_business_kpi' && !result.error) {
    return [
      {
        id: 'revenue_trend',
        label: 'Phân tích xu hướng doanh thu',
        value: 'Phân tích xu hướng doanh thu tháng này',
      },
      {
        id: 'room_perf',
        label: 'Phân tích loại phòng nào bán chạy',
        value: 'Phân tích hiệu suất từng loại phòng',
      },
      {
        id: 'strategy',
        label: 'Đề xuất chiến lược cải thiện',
        value: 'Đề xuất chiến lược cải thiện kinh doanh',
      },
    ];
  }

  // ── 9. Sau search_bookings / get_today_arrivals_departures ──
  if (name === 'get_today_arrivals_departures' && !result.error) {
    return [
      {
        id: 'today_revenue',
        label: 'Doanh thu hôm nay',
        value: 'Doanh thu hôm nay bao nhiêu?',
      },
      {
        id: 'occupancy',
        label: 'Công suất phòng hôm nay',
        value: 'Công suất phòng hiện tại',
      },
      {
        id: 'rooms_overview',
        label: 'Tình hình phòng',
        value: 'Tổng quan tình hình phòng hôm nay',
      },
    ];
  }

  // ── 10. Sau get_kpi_improvement_suggestions → action liên quan ──
  if (name === 'get_kpi_improvement_suggestions' && !result.error) {
    return [
      {
        id: 'kpi_detail',
        label: 'Chi tiết KPI hiện tại',
        value: 'Cho em xem lại chi tiết KPI tháng này',
      },
      {
        id: 'top_employees',
        label: 'Xem top nhân viên (học hỏi)',
        value: 'Cho em xem top nhân viên có KPI cao nhất',
      },
    ];
  }

  // Mặc định: không có suggestion mẫu chuẩn
  return [];
}

// ============================================================
// Parse suggestions từ reply text (AI tự đề xuất)
// AI có thể đặt block trong reply như:
//   [SUGGESTIONS]
//   - Đặt 2 phòng Standard | Đặt giúp em option 1
//   - Xem ảnh phòng | Cho em xem ảnh
//   [/SUGGESTIONS]
//
// Format: "label | value" trên mỗi dòng
// ============================================================
function parseAiSuggestions(replyText) {
  if (!replyText) return { cleanReply: replyText, suggestions: [] };

  const match = replyText.match(/\[SUGGESTIONS\]([\s\S]*?)\[\/SUGGESTIONS\]/i);
  if (!match) return { cleanReply: replyText, suggestions: [] };

  const block = match[1].trim();
  const suggestions = [];

  block.split('\n').forEach((line, idx) => {
    const cleaned = line.trim().replace(/^[-•*]\s*/, '');
    if (!cleaned) return;

    const parts = cleaned.split('|').map(p => p.trim());
    const label = parts[0];
    const value = parts[1] || parts[0]; // Nếu không có value → dùng label làm value

    if (label && label.length > 0 && label.length < 100) {
      suggestions.push({
        id: `ai_${idx}`,
        label,
        value,
      });
    }
  });

  // Xóa block khỏi reply
  const cleanReply = replyText.replace(/\[SUGGESTIONS\][\s\S]*?\[\/SUGGESTIONS\]/i, '').trim();

  return { cleanReply, suggestions };
}

// ============================================================
// Merge suggestions: ưu tiên AI tự đề xuất, fallback mẫu chuẩn
// Dedupe theo `value`, giới hạn tối đa 5 buttons
// ============================================================
function mergeSuggestions(aiSuggestions, standardSuggestions, maxCount = 5) {
  const seen = new Set();
  const merged = [];

  // AI suggestions trước
  for (const s of aiSuggestions) {
    const key = s.value.toLowerCase().slice(0, 50);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(s);
    }
    if (merged.length >= maxCount) break;
  }

  // Bổ sung từ mẫu chuẩn nếu chưa đủ
  for (const s of standardSuggestions) {
    if (merged.length >= maxCount) break;
    const key = s.value.toLowerCase().slice(0, 50);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(s);
    }
  }

  return merged;
}

module.exports = {
  buildStandardSuggestions,
  parseAiSuggestions,
  mergeSuggestions,
};