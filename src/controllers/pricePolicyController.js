const PricePolicy = require('../models/PricePolicy');
const RoomType    = require('../models/RoomType');

// GET /api/price-policies
const getAll = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.roomTypeId) filter.roomTypeId = req.query.roomTypeId;
    if (req.query.branchId)   filter.branchId   = req.query.branchId;
    if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';

    // ⭐ Sort theo displayOrder asc, fallback name asc, cuối cùng createdAt desc
    const data = await PricePolicy.find(filter)
      .populate('roomTypeId', 'name')
      .sort({ displayOrder: 1, name: 1, createdAt: -1 });

    res.json({ success: true, data: { data, total: data.length } });
  } catch (err) { next(err); }
};

// GET /api/price-policies/:id
const getOne = async (req, res, next) => {
  try {
    const policy = await PricePolicy.findById(req.params.id).populate('roomTypeId', 'name');
    if (!policy)
      return res.status(404).json({ success: false, message: 'Không tìm thấy chính sách giá' });
    res.json({ success: true, data: { policy } });
  } catch (err) { next(err); }
};

// POST /api/price-policies
const create = async (req, res, next) => {
  try {
    const { name, roomTypeId, branchId } = req.body;
    if (!name || !roomTypeId || !branchId)
      return res.status(400).json({ success: false, message: 'Thiếu: name, roomTypeId, branchId' });

    // Lấy tên loại phòng
    const roomType = await RoomType.findById(roomTypeId);
    const roomTypeName = roomType?.name ?? '';

    // ⭐ Auto-assign displayOrder = max + 1 trong cùng roomType
    //   (policy mới luôn xếp cuối list)
    const maxOrderDoc = await PricePolicy.findOne({ roomTypeId })
      .sort({ displayOrder: -1 })
      .select('displayOrder')
      .lean();
    const displayOrder = (maxOrderDoc?.displayOrder ?? -1) + 1;

    const policy = await PricePolicy.create({
      ...req.body,
      roomTypeName,
      displayOrder,
    });
    res.status(201).json({ success: true, message: 'Tạo chính sách giá thành công', data: { policy } });
  } catch (err) { next(err); }
};

// PUT /api/price-policies/:id
const update = async (req, res, next) => {
  try {
    const policy = await PricePolicy.findByIdAndUpdate(
      req.params.id, req.body, { new: true, runValidators: true }
    );
    if (!policy)
      return res.status(404).json({ success: false, message: 'Không tìm thấy chính sách giá' });
    res.json({ success: true, message: 'Cập nhật thành công', data: { policy } });
  } catch (err) { next(err); }
};

// PATCH /api/price-policies/:id/toggle
const toggle = async (req, res, next) => {
  try {
    const policy = await PricePolicy.findById(req.params.id);
    if (!policy)
      return res.status(404).json({ success: false, message: 'Không tìm thấy chính sách giá' });
    policy.isActive = !policy.isActive;
    await policy.save();
    res.json({ success: true, message: `Đã ${policy.isActive ? 'kích hoạt' : 'tạm dừng'}`, data: { policy } });
  } catch (err) { next(err); }
};

// DELETE /api/price-policies/:id
const remove = async (req, res, next) => {
  try {
    const policy = await PricePolicy.findByIdAndDelete(req.params.id);
    if (!policy)
      return res.status(404).json({ success: false, message: 'Không tìm thấy chính sách giá' });
    res.json({ success: true, message: 'Đã xoá chính sách giá' });
  } catch (err) { next(err); }
};

// ⭐ NEW: PATCH /api/price-policies/reorder
//   Body: { items: [{ id, displayOrder }, ...] }
//   Mục đích: bulk update displayOrder khi user kéo-thả sắp xếp
const reorder = async (req, res, next) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'items phải là mảng' });
    }

    if (items.length === 0) {
      return res.json({ success: true, message: 'Không có gì để cập nhật', updated: 0 });
    }

    // Validate: each item phải có id + displayOrder số nguyên
    for (const item of items) {
      if (!item.id || typeof item.displayOrder !== 'number') {
        return res.status(400).json({
          success: false,
          message: 'Mỗi item phải có { id, displayOrder: Number }',
        });
      }
    }

    // Bulk update
    const ops = items.map(({ id, displayOrder }) => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: { displayOrder } },
      },
    }));

    const result = await PricePolicy.bulkWrite(ops);

    res.json({
      success: true,
      message: 'Đã cập nhật thứ tự',
      updated: result.modifiedCount ?? items.length,
    });
  } catch (err) { next(err); }
};

// GET /api/price-policies/lookup — tìm giá áp dụng cho booking
const lookup = async (req, res, next) => {
  try {
    const { roomTypeId, branchId, checkIn, checkOut, priceType = 'day' } = req.query;
    if (!roomTypeId || !checkIn || !checkOut)
      return res.status(400).json({ success: false, message: 'Thiếu roomTypeId, checkIn, checkOut' });

    const filter = { roomTypeId, isActive: true };
    if (branchId) filter.branchId = branchId;

    // ⭐ Sort theo displayOrder để pick policy đầu list (theo thứ tự user sắp xếp)
    const policies = await PricePolicy.find(filter).sort({ displayOrder: 1, name: 1 });
    if (!policies.length)
      return res.json({ success: true, data: { price: 0, breakdown: [] } });

    // Tính toán giá dựa trên loại
    const checkInDate  = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    const nights       = Math.max(1, Math.ceil((checkOutDate - checkInDate) / 86400000));

    // Dùng policy đầu tiên active (đã sort theo displayOrder)
    const policy = policies[0];
    let totalPrice = 0;
    const breakdown = [];

    if (priceType === 'day' && policy.dayEnabled) {
      totalPrice = policy.dayPrice * nights;
      breakdown.push({ label: `Giá ngày × ${nights}`, amount: totalPrice });
    } else if (priceType === 'night' && policy.nightEnabled) {
      totalPrice = policy.nightPrice * nights;
      breakdown.push({ label: `Giá đêm × ${nights}`, amount: totalPrice });
    } else if (priceType === 'week' && policy.weekEnabled) {
      const weeks = Math.ceil(nights / 7);
      totalPrice = policy.weekPrice * weeks;
      breakdown.push({ label: `Giá tuần × ${weeks}`, amount: totalPrice });
    } else if (priceType === 'month' && policy.monthEnabled) {
      const months = Math.ceil(nights / 30);
      totalPrice = policy.monthPrice * months;
      breakdown.push({ label: `Giá tháng × ${months}`, amount: totalPrice });
    }

    res.json({ success: true, data: { price: totalPrice, breakdown, policy: policy.name } });
  } catch (err) { next(err); }
};

module.exports = { getAll, getOne, create, update, toggle, remove, lookup, reorder };