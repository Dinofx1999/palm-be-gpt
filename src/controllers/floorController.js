const Floor = require('../models/Floor');

const getAll = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.branchId) filter.branchId = req.query.branchId;
    const data = await Floor.find(filter).sort({ number: 1 });
    res.json({ success: true, data: { data, total: data.length } });
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const { name, branchId } = req.body;
    if (!name || !branchId)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc: name, branchId' });
    const floor = await Floor.create(req.body);
    res.status(201).json({ success: true, message: 'Tạo tầng thành công', data: { floor } });
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const floor = await Floor.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!floor) return res.status(404).json({ success: false, message: 'Không tìm thấy tầng' });
    res.json({ success: true, message: 'Cập nhật thành công', data: { floor } });
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    const floor = await Floor.findByIdAndDelete(req.params.id);
    if (!floor) return res.status(404).json({ success: false, message: 'Không tìm thấy tầng' });
    res.json({ success: true, message: 'Đã xoá tầng' });
  } catch (err) { next(err); }
};

module.exports = { getAll, create, update, remove };