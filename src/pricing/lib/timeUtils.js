'use strict'
/**
 * ════════════════════════════════════════════════════════════════════════════
 * timeUtils.js — Tiện ích thời gian/tiền, THUẦN (pure), KHÔNG side-effect.
 *
 * NGUYÊN TẮC TIMEZONE (tránh DST/timezone bug):
 *   - Toàn hệ thống làm việc theo MÚI GIỜ KHÁCH SẠN cố định (vd Asia/Ho_Chi_Minh,
 *     UTC+7, KHÔNG có DST). Mọi Date truyền vào engine PHẢI là epoch chuẩn (UTC ms).
 *   - "Giờ trong ngày" (vd 14:00 check-in) được diễn giải theo offset cố định của
 *     khách sạn (hotelUtcOffsetMinutes), KHÔNG dùng getHours() của server (phụ thuộc
 *     TZ server → bug). Đây là điểm sửa lỗi timezone cốt lõi.
 * ════════════════════════════════════════════════════════════════════════════
 */

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

/** Parse "HH:mm" -> số phút từ 00:00. Trả null nếu sai định dạng. */
function parseHHmm(str) {
  if (typeof str !== 'string') return null
  const m = str.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/**
 * Lấy "thời điểm trong ngày" (số phút từ nửa đêm) của một Date THEO GIỜ KHÁCH SẠN.
 * KHÔNG dùng date.getHours() (phụ thuộc TZ của server). Thay vào đó tính từ epoch +
 * offset cố định của khách sạn → deterministic, không bị DST.
 */
function minutesOfDay(date, hotelUtcOffsetMinutes) {
  const shifted = date.getTime() + hotelUtcOffsetMinutes * MINUTE_MS
  const dayMs = ((shifted % (24 * HOUR_MS)) + 24 * HOUR_MS) % (24 * HOUR_MS)
  return Math.floor(dayMs / MINUTE_MS)
}

/** Số thứ tự ngày (theo giờ khách sạn) — dùng để so "cùng ngày" / "đếm ngày lịch". */
function dayIndex(date, hotelUtcOffsetMinutes) {
  const shifted = date.getTime() + hotelUtcOffsetMinutes * MINUTE_MS
  return Math.floor(shifted / (24 * HOUR_MS))
}

function isSameHotelDay(a, b, off) {
  return dayIndex(a, off) === dayIndex(b, off)
}

/**
 * Tạo Date tại "giờ trong ngày" cho ngày-lịch của `refDate` (theo giờ khách sạn).
 * Vd: refDate = 12/06 18:00, hhmm=12:00 → 12/06 12:00 (cùng ngày lịch KS).
 */
function atTimeOfDay(refDate, minutesFromMidnight, hotelUtcOffsetMinutes) {
  const di = dayIndex(refDate, hotelUtcOffsetMinutes)
  // Nửa đêm (giờ KS) của ngày đó, quy về epoch UTC:
  const midnightUtcMs = di * 24 * HOUR_MS - hotelUtcOffsetMinutes * MINUTE_MS
  return new Date(midnightUtcMs + minutesFromMidnight * MINUTE_MS)
}

function diffMinutes(a, b) {
  return (b.getTime() - a.getTime()) / MINUTE_MS
}

/** Cộng N ngày lịch (24h) — an toàn vì offset cố định. */
function addDays(date, n) {
  return new Date(date.getTime() + n * 24 * HOUR_MS)
}

/**
 * Làm tròn giờ theo tolerance (Cách B của hệ thống cũ — giữ tương thích):
 *   phút ≤ tolerance → 0; ngược lại ceil((phút − tolerance)/60).
 */
function roundHoursWithTolerance(totalMinutes, toleranceMin) {
  if (totalMinutes <= toleranceMin) return 0
  // ⭐ Rule 1 (14/06/2026): làm tròn theo tolerance trên PHẦN DƯ phút lẻ.
  //   fullHours = floor(total/60); remainder = total%60
  //   remainder ≤ tolerance → giữ fullHours; ngược lại → +1 giờ.
  //   KHÔNG floor cứng, KHÔNG ceil cứng. Vd tol=15: 3h00→3, 3h15→3, 3h16→4, 3h26→4.
  const fullHours = Math.floor(totalMinutes / 60)
  const remainder = totalMinutes % 60
  return remainder <= toleranceMin ? fullHours : fullHours + 1
}

/** Làm tròn tiền VND về đơn vị đồng (số nguyên). Tập trung 1 chỗ để tránh rounding bug. */
function roundMoney(x) {
  return Math.round(Number(x) || 0)
}

function fmtDM(date, off) {
  const shifted = new Date(date.getTime() + off * MINUTE_MS)
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  return `${d}/${m}`
}
function fmtHM(date, off) {
  const mins = minutesOfDay(date, off)
  const h = String(Math.floor(mins / 60)).padStart(2, '0')
  const mi = String(mins % 60).padStart(2, '0')
  return `${h}:${mi}`
}
function fmtDMHM(date, off) {
  return `${fmtDM(date, off)} ${fmtHM(date, off)}`
}

module.exports = {
  MINUTE_MS, HOUR_MS,
  parseHHmm, minutesOfDay, dayIndex, isSameHotelDay, atTimeOfDay,
  diffMinutes, addDays, roundHoursWithTolerance, roundMoney,
  fmtDM, fmtHM, fmtDMHM,
}