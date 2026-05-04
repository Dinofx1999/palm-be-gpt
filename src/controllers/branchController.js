const Branch = require('../models/Branch');

const getAll = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const data = await Branch.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, data: { data, total: data.length } });
  } catch (err) { next(err); }
};

const getOne = async (req, res, next) => {
  try {
    const branch = await Branch.findById(req.params.id);
    if (!branch) return res.status(404).json({ success: false, message: 'Không tìm thấy chi nhánh' });
    res.json({ success: true, data: { branch } });
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const { name, address, city } = req.body;
    if (!name || !address || !city)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc: name, address, city' });
    const branch = await Branch.create(req.body);
    res.status(201).json({ success: true, message: 'Tạo chi nhánh thành công', data: { branch } });
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    // ⭐ Đầy đủ các field config — trước đây thiếu sẽ bị strip ra khỏi payload
    const allowed = [
      'name', 'address', 'city', 'phone', 'email', 'managerId', 'status',
      'checkInTime', 'checkOutTime',
      'toleranceMinutes',
      'hourToDayThreshold',
      'dayEquivalentHours',
      'earlyCheckinUntil',         // ⭐ NEW
      'autoConvertPriceType',
    ];
    const payload = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k]; });

    for (const field of ['checkInTime','checkOutTime']) {
      if (payload[field] && !/^\d{2}:\d{2}$/.test(payload[field]))
        return res.status(400).json({ success: false, message: `${field} phải có định dạng HH:mm` });
    }

    // ⭐ Validate range cho config Number
    if (payload.toleranceMinutes !== undefined && (payload.toleranceMinutes < 0 || payload.toleranceMinutes > 120)) {
      return res.status(400).json({ success: false, message: 'toleranceMinutes phải trong khoảng 0–120' });
    }
    if (payload.hourToDayThreshold !== undefined && (payload.hourToDayThreshold < 1 || payload.hourToDayThreshold > 24)) {
      return res.status(400).json({ success: false, message: 'hourToDayThreshold phải trong khoảng 1–24' });
    }
    if (payload.dayEquivalentHours !== undefined && (payload.dayEquivalentHours < 0 || payload.dayEquivalentHours > 23)) {
      return res.status(400).json({ success: false, message: 'dayEquivalentHours phải trong khoảng 0–23' });
    }
    if (payload.earlyCheckinUntil !== undefined && (payload.earlyCheckinUntil < 0 || payload.earlyCheckinUntil > 11)) {
      return res.status(400).json({ success: false, message: 'earlyCheckinUntil phải trong khoảng 0–11' });
    }

    const branch = await Branch.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
    if (!branch) return res.status(404).json({ success: false, message: 'Không tìm thấy chi nhánh' });
    res.json({ success: true, message: 'Cập nhật thành công', data: { branch } });
  } catch (err) { next(err); }
};

const toggle = async (req, res, next) => {
  try {
    const branch = await Branch.findById(req.params.id);
    if (!branch) return res.status(404).json({ success: false, message: 'Không tìm thấy chi nhánh' });
    branch.status = branch.status === 'active' ? 'inactive' : 'active';
    await branch.save();
    res.json({ success: true, message: `Đã ${branch.status === 'active' ? 'kích hoạt' : 'tạm dừng'} chi nhánh`, data: { branch } });
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    const branch = await Branch.findByIdAndDelete(req.params.id);
    if (!branch) return res.status(404).json({ success: false, message: 'Không tìm thấy chi nhánh' });
    res.json({ success: true, message: 'Đã xoá chi nhánh' });
  } catch (err) { next(err); }
};

module.exports = { getAll, getOne, create, update, toggle, remove };