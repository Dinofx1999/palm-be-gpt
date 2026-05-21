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
    const allowed = [
      'name', 'address', 'city', 'phone', 'email',
      'checkInTime', 'checkOutTime',
      'toleranceMinutes',
      'dayEquivalentHours', 'earlyCheckinUntil',
      'autoConvertPriceType',
      'quotePolicy','hourBookingCutoffEnabled','hourBookingCutoffStart','hourBookingCutoffEnd',
      'latitude', 'longitude', 'geofenceRadius',                              // ⭐ THÊM dòng này
      'images', 'coverImage',                                                 // ⭐ NEW: ảnh chi nhánh
    ]
    const payload = {}
    allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k] })

    // ⭐ Nếu cập nhật images mà coverImage trống → lấy ảnh đầu làm mặc định
    //   (findByIdAndUpdate không chạy pre-save hook nên xử lý ở đây)
    if (Array.isArray(payload.images) && payload.images.length > 0
        && (payload.coverImage === undefined || !String(payload.coverImage).trim())) {
      const cur = await Branch.findById(req.params.id).select('coverImage').lean();
      if (!cur?.coverImage) payload.coverImage = payload.images[0];
    }

    const branch = await Branch.findByIdAndUpdate(
      req.params.id, payload, { new: true, runValidators: true }
    )
    if (!branch) return res.status(404).json({ success: false, message: 'Không tìm thấy' })
    res.json({ success: true, message: 'Cập nhật thành công', data: { branch } })
  } catch (err) { next(err) }
}

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