const Room    = require('../models/Room');
const Booking = require('../models/Booking');
const Invoice = require('../models/Invoice');

const getStats = async (req, res, next) => {
  try {
    const today      = new Date();
    const startOfDay = new Date(today.setHours(0, 0, 0, 0));
    const endOfDay   = new Date(today.setHours(23, 59, 59, 999));
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const [
      totalRooms, statusCounts, todayRevenue, monthRevenue,
      todayCheckIns, todayCheckOuts, pendingBookings, revenueChart,
    ] = await Promise.all([
      Room.countDocuments(),
      Room.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Invoice.aggregate([
        { $match: { paidAt: { $gte: startOfDay, $lte: endOfDay } } },
        { $group: { _id: null, total: { $sum: '$paidAmount' } } },
      ]),
      Invoice.aggregate([
        { $match: { paidAt: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: '$paidAmount' } } },
      ]),
      Booking.countDocuments({ actualCheckIn: { $gte: startOfDay, $lte: endOfDay } }),
      Booking.countDocuments({ actualCheckOut: { $gte: startOfDay, $lte: endOfDay } }),
      Booking.countDocuments({ status: 'confirmed' }),
      // Revenue last 7 days
      Invoice.aggregate([
        { $match: { paidAt: { $gte: new Date(Date.now() - 7 * 86400000) } } },
        { $group: {
          _id: { $dateToString: { format: '%d/%m', date: '$paidAt' } },
          amount: { $sum: '$paidAmount' },
        }},
        { $sort: { _id: 1 } },
      ]),
    ]);

    const statusMap = statusCounts.reduce((acc, s) => { acc[s._id] = s.count; return acc; }, {});

    res.json({
      success: true,
      data: {
        totalRooms,
        availableRooms:   statusMap['available']   || 0,
        occupiedRooms:    statusMap['occupied']     || 0,
        checkoutRooms:    statusMap['checkout']     || 0,
        cleaningRooms:    statusMap['cleaning']     || 0,
        maintenanceRooms: statusMap['maintenance']  || 0,
        reservedRooms:    statusMap['reserved']     || 0,
        todayRevenue:     todayRevenue[0]?.total    || 0,
        monthRevenue:     monthRevenue[0]?.total    || 0,
        todayCheckIns, todayCheckOuts, pendingBookings,
        occupancyRate: totalRooms > 0 ? Math.round((statusMap['occupied'] || 0) / totalRooms * 100) : 0,
        roomStatusSummary: statusMap,
        revenueChart: revenueChart.map(r => ({ date: r._id, amount: r.amount })),
        branchOccupancy: [],
      },
    });
  } catch (err) { next(err); }
};

module.exports = { getStats };