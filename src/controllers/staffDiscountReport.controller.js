// ════════════════════════════════════════════════════════════════════════════
// staffDiscountReport.controller.js
// ════════════════════════════════════════════════════════════════════════════
// Báo cáo chiết khấu cho nhân viên — dùng để cuối tháng trừ lương NV
//
// GET /reports/staff-discount-charges
//   Query params:
//     - branchId (required nếu không phải super-admin)
//     - from     (ISO date, default = đầu tháng hiện tại)
//     - to       (ISO date, default = cuối tháng hiện tại)
//     - staffId  (optional - filter 1 NV cụ thể)
//
//   Response:
//     {
//       success: true,
//       data: {
//         summary: [
//           { staffId, staffName, staffRole, bookingCount, totalDiscount }
//         ],
//         details: [
//           { bookingId, bookingCode, customerName, roomNumber,
//             discount, discountPercent, discountAmount, isFreeRoom,
//             discountReason, discountChargedToName, discountChargedToRole,
//             discountAppliedAt, discountAppliedByName }
//         ],
//         grandTotal: 1900000,
//         period: { from, to }
//       }
//     }
// ════════════════════════════════════════════════════════════════════════════

const Booking = require('../models/Booking')
const mongoose = require('mongoose')

const getStaffDiscountCharges = async (req, res, next) => {
  try {
    const {
      branchId,
      from,
      to,
      staffId = null,
    } = req.query

    // Validate branchId (admin/manager phải có)
    if (!branchId) {
      return res.status(400).json({ success: false, message: 'Thiếu branchId' })
    }

    // Default period = tháng hiện tại
    const now = new Date()
    const fromDate = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1)
    const toDate = to ? new Date(to) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)

    // Build match condition
    const match = {
      branchId: new mongoose.Types.ObjectId(branchId),
      discountChargedTo: { $ne: null },
      discountAppliedAt: { $gte: fromDate, $lte: toDate },
      // Loại bỏ booking đã cancel (KS không nhận tiền → không nên tính discount NV chịu)
      status: { $nin: ['cancelled'] },
    }
    if (staffId) {
      try {
        match.discountChargedTo = new mongoose.Types.ObjectId(staffId)
      } catch (e) {
        return res.status(400).json({ success: false, message: 'staffId không hợp lệ' })
      }
    }

    // Aggregate: tổng theo NV
    const summaryPipeline = [
      { $match: match },
      {
        $group: {
          _id: '$discountChargedTo',
          staffName:     { $first: '$discountChargedToName' },
          staffRole:     { $first: '$discountChargedToRole' },
          bookingCount:  { $sum: 1 },
          totalDiscount: { $sum: '$discount' },
        },
      },
      { $sort: { totalDiscount: -1 } },
      {
        $project: {
          _id: 0,
          staffId:       '$_id',
          staffName:     1,
          staffRole:     1,
          bookingCount:  1,
          totalDiscount: 1,
        },
      },
    ]

    // Aggregate: chi tiết từng booking
    const detailsPipeline = [
      { $match: match },
      { $sort: { discountAppliedAt: -1 } },
      {
        $project: {
          _id: 0,
          bookingId:               '$_id',
          bookingCode:             1,
          customerName:            1,
          roomNumber:              1,
          roomType:                1,
          checkIn:                 1,
          checkOut:                1,
          actualCheckIn:           1,
          actualCheckOut:          1,
          status:                  1,
          discount:                1,
          discountPercent:         1,
          discountAmount:          1,
          isFreeRoom:              1,
          discountReason:          1,
          discountChargedTo:       1,
          discountChargedToName:   1,
          discountChargedToRole:   1,
          discountAppliedAt:       1,
          discountAppliedBy:       1,
          discountAppliedByName:   1,
          totalAmount:             1,
          roomAmount:              1,
        },
      },
      { $limit: 1000 },   // giới hạn 1000 dòng tránh timeout
    ]

    const [summary, details] = await Promise.all([
      Booking.aggregate(summaryPipeline),
      Booking.aggregate(detailsPipeline),
    ])

    const grandTotal = summary.reduce((s, r) => s + (r.totalDiscount || 0), 0)
    const grandCount = summary.reduce((s, r) => s + (r.bookingCount || 0), 0)

    res.json({
      success: true,
      data: {
        summary,
        details,
        grandTotal,
        grandCount,
        period: { from: fromDate.toISOString(), to: toDate.toISOString() },
      },
    })
  } catch (err) { next(err) }
}

module.exports = { getStaffDiscountCharges }

