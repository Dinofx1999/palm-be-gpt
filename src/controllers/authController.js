const jwt  = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET  = process.env.JWT_SECRET  || 'luxstay-secret-2025';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

const login = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ success: false, message: 'Thiếu username hoặc password' });

    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user)
      return res.status(401).json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu' });

    if (!user.isActive)
      return res.status(403).json({ success: false, message: 'Tài khoản đã bị khoá' });

    const match = await user.comparePassword(password);
    if (!match)
      return res.status(401).json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu' });

    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role, branchId: user.branchId },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    res.json({
      success: true,
      message: 'Đăng nhập thành công',
      data: { token, user: user.toSafeObject() },
    });
  } catch (err) { next(err); }
};

const me = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user)
      return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
    res.json({ success: true, data: user });
  } catch (err) { next(err); }
};

const logout = (_req, res) => {
  res.json({ success: true, message: 'Đã đăng xuất' });
};

module.exports = { login, me, logout };