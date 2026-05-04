const Customer = require('../models/Customer');

const getAll = async (req, res, next) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (search) filter.$or = [
      { name:  { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
    const total = await Customer.countDocuments(filter);
    const data  = await Customer.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(+limit);
    res.json({ success: true, data: { data, total, page: +page, limit: +limit } });
  } catch (err) { next(err); }
};

const getOne = async (req, res, next) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Không tìm thấy khách hàng' });
    res.json({ success: true, data: { customer } });
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc: name, phone' });

    const exists = await Customer.findOne({ phone });
    if (exists) return res.status(400).json({ success: false, message: 'Số điện thoại đã tồn tại' });

    const customer = await Customer.create(req.body);
    res.status(201).json({ success: true, message: 'Tạo khách hàng thành công', data: { customer } });
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const customer = await Customer.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!customer) return res.status(404).json({ success: false, message: 'Không tìm thấy khách hàng' });
    res.json({ success: true, message: 'Cập nhật thành công', data: { customer } });
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    const customer = await Customer.findByIdAndDelete(req.params.id);
    if (!customer) return res.status(404).json({ success: false, message: 'Không tìm thấy khách hàng' });
    res.json({ success: true, message: 'Đã xoá khách hàng' });
  } catch (err) { next(err); }
};

module.exports = { getAll, getOne, create, update, remove };