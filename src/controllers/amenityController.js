const Amenity = require('../models/Amenity');

const getAll = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';

    const data = await Amenity.find(filter).sort({ category: 1, name: 1 });

    // Group theo category
    const grouped = data.reduce((acc, item) => {
      if (!acc[item.category]) acc[item.category] = [];
      acc[item.category].push(item);
      return acc;
    }, {});

    res.json({ success: true, data: { data, grouped, total: data.length } });
  } catch (err) { next(err); }
};

const getOne = async (req, res, next) => {
  try {
    const amenity = await Amenity.findById(req.params.id);
    if (!amenity)
      return res.status(404).json({ success: false, message: 'Không tìm thấy tiện nghi' });
    res.json({ success: true, data: { amenity } });
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const { name, category } = req.body;
    if (!name || !category)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc: name, category' });

    const exists = await Amenity.findOne({ name, category });
    if (exists)
      return res.status(400).json({ success: false, message: 'Tiện nghi này đã tồn tại trong danh mục' });

    const amenity = await Amenity.create(req.body);
    res.status(201).json({ success: true, message: 'Tạo tiện nghi thành công', data: { amenity } });
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const amenity = await Amenity.findByIdAndUpdate(
      req.params.id, req.body, { new: true, runValidators: true }
    );
    if (!amenity)
      return res.status(404).json({ success: false, message: 'Không tìm thấy tiện nghi' });
    res.json({ success: true, message: 'Cập nhật thành công', data: { amenity } });
  } catch (err) { next(err); }
};

const toggle = async (req, res, next) => {
  try {
    const amenity = await Amenity.findById(req.params.id);
    if (!amenity)
      return res.status(404).json({ success: false, message: 'Không tìm thấy tiện nghi' });
    amenity.isActive = !amenity.isActive;
    await amenity.save();
    res.json({ success: true, message: `Đã ${amenity.isActive ? 'kích hoạt' : 'tạm dừng'} tiện nghi`, data: { amenity } });
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    const amenity = await Amenity.findByIdAndDelete(req.params.id);
    if (!amenity)
      return res.status(404).json({ success: false, message: 'Không tìm thấy tiện nghi' });
    res.json({ success: true, message: 'Đã xoá tiện nghi' });
  } catch (err) { next(err); }
};

module.exports = { getAll, getOne, create, update, toggle, remove };