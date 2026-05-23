const User = require('../models/User');

const getAll = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.branchId) filter.branchId = req.query.branchId;
    if (req.query.role)     filter.role     = req.query.role;
    const data = await User.find(filter).select('-password').sort({ createdAt: -1 });
    res.json({ success: true, data: { data, total: data.length } });
  } catch (err) { next(err); }
};

const getOne = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
    res.json({ success: true, data: { user } });
  } catch (err) { next(err); }
};

const create = async (req, res, next) => {
  try {
    const { username, fullName, email, role, branchId } = req.body;
    if (!username || !fullName || !email || !role || !branchId)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc' });

    const exists = await User.findOne({ $or: [{ username }, { email }] });
    if (exists) return res.status(400).json({ success: false, message: 'Username hoặc email đã tồn tại' });

    const user = await User.create({ ...req.body, password: req.body.password ?? '123456' });
    res.status(201).json({ success: true, message: 'Tạo người dùng thành công', data: { user: user.toSafeObject() } });
  } catch (err) { next(err); }
};

const update = async (req, res, next) => {
  try {
    const allowed = ['fullName','email','phone','role','branchId','branchName'];
    const payload = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k]; });
    const user = await User.findByIdAndUpdate(req.params.id, payload, { new: true }).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
    res.json({ success: true, message: 'Cập nhật thành công', data: { user } });
  } catch (err) { next(err); }
};

const toggle = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
    user.isActive = !user.isActive;
    await user.save();
    res.json({ success: true, message: `Đã ${user.isActive ? 'kích hoạt' : 'khoá'} tài khoản`, data: { user: user.toSafeObject() } });
  } catch (err) { next(err); }
};

const resetPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6)
      return res.status(400).json({ success: false, message: 'Mật khẩu tối thiểu 6 ký tự' });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
    user.password = password;
    await user.save();
    res.json({ success: true, message: 'Đã reset mật khẩu' });
  } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try {
    // Không cho xoá chính mình
    if (req.params.id === req.user.id)
      return res.status(400).json({ success: false, message: 'Không thể xoá tài khoản đang đăng nhập' });

    const user = await User.findByIdAndDelete(req.params.id);
    if (!user)
      return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });

    res.json({ success: true, message: `Đã xoá người dùng ${user.username}` });
  } catch (err) { next(err); }
};


// ─────────────────────────────────────────────────────────────
// ⭐ NEW: Các hàm cho HỒ SƠ CÁ NHÂN (user thao tác với chính mình)
//   Thêm vào file controllers/userController.js
//   Nhớ export thêm 3 hàm ở dưới cùng.
// ─────────────────────────────────────────────────────────────
 
// GET /api/users/me — lấy hồ sơ của chính mình
const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
    res.json({ success: true, data: { user } });
  } catch (err) { next(err); }
};
 
// PATCH /api/users/me — user tự cập nhật email / phone / avatar
//   ⚠️ KHÔNG cho phép tự đổi role / branchId / isActive / username
const updateMe = async (req, res, next) => {
  try {
    const allowed = ['email', 'phone', 'avatar'];
    const payload = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k]; });
 
    if (Object.keys(payload).length === 0)
      return res.status(400).json({ success: false, message: 'Không có thông tin nào để cập nhật' });
 
    // Nếu đổi email → check trùng với user khác
    if (payload.email) {
      const dup = await User.findOne({ email: payload.email, _id: { $ne: req.user.id } });
      if (dup) return res.status(400).json({ success: false, message: 'Email đã được sử dụng' });
    }
 
    const user = await User.findByIdAndUpdate(req.user.id, payload, {
      new: true,
      runValidators: true,
    }).select('-password');
 
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
    res.json({ success: true, message: 'Cập nhật hồ sơ thành công', data: { user } });
  } catch (err) { next(err); }
};
 
// POST /api/users/me/change-password — đổi mật khẩu của chính mình
const changeMyPassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ success: false, message: 'Thiếu mật khẩu hiện tại hoặc mật khẩu mới' });
    if (newPassword.length < 6)
      return res.status(400).json({ success: false, message: 'Mật khẩu mới tối thiểu 6 ký tự' });
 
    // Cần lấy cả field password (mặc định select('-password') ở nơi khác, nên ở đây lấy đủ)
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
 
    const ok = await user.comparePassword(currentPassword);
    if (!ok) return res.status(400).json({ success: false, message: 'Mật khẩu hiện tại không đúng' });
 
    // Hook pre('save') sẽ tự hash
    user.password = newPassword;
    await user.save();
 
    res.json({ success: true, message: 'Đổi mật khẩu thành công' });
  } catch (err) { next(err); }
};

module.exports = { getAll, getOne, create, update, toggle, resetPassword, remove , getMe, updateMe, changeMyPassword };