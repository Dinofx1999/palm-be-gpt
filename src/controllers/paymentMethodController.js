const PaymentMethod = require('../models/PaymentMethod');

const getAll = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';
    const data = await PaymentMethod.find(filter).sort({ name: 1 });
    res.json({ success: true, data: { data, total: data.length } });
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const { name, type } = req.body;
    if (!name || !type)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc: name, type' });
    const method = await PaymentMethod.create(req.body);
    res.status(201).json({ success: true, message: 'Tạo hình thức thanh toán thành công', data: { paymentMethod: method } });
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const method = await PaymentMethod.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!method) return res.status(404).json({ success: false, message: 'Không tìm thấy hình thức thanh toán' });
    res.json({ success: true, message: 'Cập nhật thành công', data: { paymentMethod: method } });
  } catch (err) { next(err); }
};

const toggle = async (req, res, next) => {
  try {
    const method = await PaymentMethod.findById(req.params.id);
    if (!method) return res.status(404).json({ success: false, message: 'Không tìm thấy hình thức thanh toán' });
    method.isActive = !method.isActive;
    await method.save();
    res.json({ success: true, message: 'Cập nhật thành công', data: { paymentMethod: method } });
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    const method = await PaymentMethod.findByIdAndDelete(req.params.id);
    if (!method) return res.status(404).json({ success: false, message: 'Không tìm thấy hình thức thanh toán' });
    res.json({ success: true, message: 'Đã xoá' });
  } catch (err) { next(err); }
};

module.exports = { getAll, create, update, toggle, remove };