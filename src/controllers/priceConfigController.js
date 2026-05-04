const PriceConfig = require('../models/PriceConfig');

const getAll = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.roomTypeId) filter.roomTypeId = req.query.roomTypeId;
    if (req.query.branchId)   filter.branchId   = req.query.branchId;
    const data = await PriceConfig.find(filter).sort({ roomTypeName: 1, priceType: 1 });
    res.json({ success: true, data: { data, total: data.length } });
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const { roomTypeId, priceType, price, branchId } = req.body;
    if (!roomTypeId || !priceType || !price || !branchId)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc' });

    const exists = await PriceConfig.findOne({ roomTypeId, priceType, branchId });
    if (exists) return res.status(400).json({ success: false, message: 'Cấu hình giá này đã tồn tại' });

    const config = await PriceConfig.create(req.body);
    res.status(201).json({ success: true, message: 'Tạo cấu hình giá thành công', data: { priceConfig: config } });
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const config = await PriceConfig.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!config) return res.status(404).json({ success: false, message: 'Không tìm thấy cấu hình giá' });
    res.json({ success: true, message: 'Cập nhật thành công', data: { priceConfig: config } });
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    const config = await PriceConfig.findByIdAndDelete(req.params.id);
    if (!config) return res.status(404).json({ success: false, message: 'Không tìm thấy cấu hình giá' });
    res.json({ success: true, message: 'Đã xoá cấu hình giá' });
  } catch (err) { next(err); }
};

module.exports = { getAll, create, update, remove };