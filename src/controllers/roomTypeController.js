const RoomType = require('../models/RoomType');

const getAll = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.branchId) filter.branchId = req.query.branchId;
    const data = await RoomType.find(filter)
      .populate('amenities', 'name icon category')   // ← populate
      .sort({ name: 1 });
    res.json({ success: true, data: { data, total: data.length } });
  } catch (err) { next(err); }
};

const getOne = async (req, res, next) => {
  try {
    const roomType = await RoomType.findById(req.params.id)
      .populate('amenities', 'name icon category');  // ← populate
    if (!roomType)
      return res.status(404).json({ success: false, message: 'Không tìm thấy loại phòng' });
    res.json({ success: true, data: { roomType } });
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const { name, branchId } = req.body;
    if (!name || !branchId)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc: name, branchId' });
    const roomType = await RoomType.create(req.body);
    res.status(201).json({ success: true, message: 'Tạo loại phòng thành công', data: { roomType } });
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const roomType = await RoomType.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!roomType) return res.status(404).json({ success: false, message: 'Không tìm thấy loại phòng' });
    res.json({ success: true, message: 'Cập nhật thành công', data: { roomType } });
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    const roomType = await RoomType.findByIdAndDelete(req.params.id);
    if (!roomType) return res.status(404).json({ success: false, message: 'Không tìm thấy loại phòng' });
    res.json({ success: true, message: 'Đã xoá loại phòng' });
  } catch (err) { next(err); }
};

module.exports = { getAll, getOne, create, update, remove };