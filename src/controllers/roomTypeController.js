const RoomType = require('../models/RoomType');

// ⭐ Helper: normalize maxAdults/maxChildren từ body (đảm bảo >= 0, integer)
//   Cho phép FE cũ vẫn gửi `capacity` → tự convert thành maxAdults
const normalizeBody = (body) => {
  const out = { ...body }

  // ⭐ Backward compat: nếu FE cũ gửi `capacity` mà không gửi maxAdults
  //   → coi capacity = maxAdults (tất cả là NL), maxChildren = 0
  if (out.capacity !== undefined && out.maxAdults === undefined) {
    out.maxAdults   = Math.max(0, parseInt(out.capacity, 10) || 0)
    out.maxChildren = 0
    delete out.capacity   // không lưu vào DB (capacity là virtual)
  }

  if (out.maxAdults !== undefined) {
    out.maxAdults = Math.max(0, parseInt(out.maxAdults, 10) || 0)
  }
  if (out.maxChildren !== undefined) {
    out.maxChildren = Math.max(0, parseInt(out.maxChildren, 10) || 0)
  }

  return out
}

const getAll = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.branchId) filter.branchId = req.query.branchId;
    const data = await RoomType.find(filter)
      .populate('amenities', 'name icon category')
      .sort({ name: 1 });
    res.json({ success: true, data: { data, total: data.length } });
  } catch (err) { next(err); }
};

const getOne = async (req, res, next) => {
  try {
    const roomType = await RoomType.findById(req.params.id)
      .populate('amenities', 'name icon category');
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

    const payload = normalizeBody(req.body)

    // ⭐ Validation: tổng phải >= 1 (loại phòng phải chứa được ít nhất 1 người)
    const totalCap = (payload.maxAdults ?? 2) + (payload.maxChildren ?? 0)
    if (totalCap < 1) {
      return res.status(400).json({
        success: false,
        message: 'Loại phòng phải chứa được ít nhất 1 người (NL hoặc TE)',
      })
    }

    const roomType = await RoomType.create(payload);
    res.status(201).json({ success: true, message: 'Tạo loại phòng thành công', data: { roomType } });
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const payload = normalizeBody(req.body)

    // ⭐ Validation tổng (chỉ check khi có gửi 1 trong 2 field)
    if (payload.maxAdults !== undefined || payload.maxChildren !== undefined) {
      // Lấy giá trị hiện tại để so sánh tổng cuối cùng
      const cur = await RoomType.findById(req.params.id)
      if (!cur) return res.status(404).json({ success: false, message: 'Không tìm thấy loại phòng' });
      const finalMaxA = payload.maxAdults   ?? cur.maxAdults   ?? 2
      const finalMaxC = payload.maxChildren ?? cur.maxChildren ?? 0
      if ((finalMaxA + finalMaxC) < 1) {
        return res.status(400).json({
          success: false,
          message: 'Loại phòng phải chứa được ít nhất 1 người (NL hoặc TE)',
        })
      }
    }

    const roomType = await RoomType.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: true });
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