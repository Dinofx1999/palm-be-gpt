// backend/src/services/revenueService.js
// Tính doanh thu branch trong tháng — dùng cùng nguồn data với Dashboard
// Logic: lấy tất cả booking đã `checked_out` trong tháng, sum totalAmount
// Hỗ trợ cả single booking và group booking

const mongoose = require('mongoose');
const Booking = require('../models/Booking');

/**
 * Tổng doanh thu của branch trong tháng.
 *
 * @param {string|ObjectId} branchId
 * @param {number} year
 * @param {number} month - 1..12
 * @returns {Promise<number>}
 */
async function getBranchRevenue(branchId, year, month) {
  if (!branchId) return 0;

  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 1, 0, 0, 0, 0);

  const matchStage = {
    status: 'checked_out',
    actualCheckOut: { $gte: start, $lt: end },
    branchId: new mongoose.Types.ObjectId(branchId),
  };

  const result = await Booking.aggregate([
    { $match: matchStage },
    {
      $facet: {
        // Booking thường (không có rooms[])
        singles: [
          {
            $match: {
              $or: [
                { rooms: { $exists: false } },
                { rooms: { $size: 0 } },
              ],
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: { $ifNull: ['$totalAmount', 0] } },
            },
          },
        ],
        // Booking đoàn (có rooms[]) - chỉ tính room đã checked_out
        groups: [
          { $match: { rooms: { $exists: true, $not: { $size: 0 } } } },
          { $unwind: '$rooms' },
          { $match: { 'rooms.status': 'checked_out' } },
          {
            $group: {
              _id: null,
              total: { $sum: { $ifNull: ['$rooms.roomAmount', 0] } },
            },
          },
        ],
      },
    },
    {
      $project: {
        total: {
          $add: [
            { $ifNull: [{ $arrayElemAt: ['$singles.total', 0] }, 0] },
            { $ifNull: [{ $arrayElemAt: ['$groups.total', 0] }, 0] },
          ],
        },
      },
    },
  ]);

  return result[0]?.total || 0;
}

/**
 * Doanh thu áp dụng cho 1 nhân viên khi tính KPI.
 *
 * ⭐ KHÔNG CHIA — trả về NGUYÊN doanh thu branch.
 * Lý do: target được công bố là target CỦA CẢ BRANCH.
 * → Khi đạt: KPI tính từ doanh thu thật của branch.
 * → Tiền KPI sẽ được trả riêng cho mỗi nhân viên dựa trên config role,
 *   không phải chia doanh thu rồi mới so target.
 */
async function getEmployeeRevenue(user, year, month) {
  if (!user?.branchId) return 0;
  return await getBranchRevenue(user.branchId, year, month);
}

module.exports = { getBranchRevenue, getEmployeeRevenue };