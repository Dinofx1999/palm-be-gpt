const jwt  = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET  = process.env.JWT_SECRET  || 'luxstay-secret-2025';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

const login = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ success: false, message: 'Thiếu username hoặc password' });

    // ⭐ FIX: Populate branchId để lấy thông tin branch THẬT từ Branch collection
    //   Tránh dependency vào field branchName cache trên User (có thể stale)
    const user = await User.findOne({ username: username.toLowerCase() })
      .populate('branchId', 'name address city');

    if (!user)
      return res.status(401).json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu' });

    if (!user.isActive)
      return res.status(403).json({ success: false, message: 'Tài khoản đã bị khoá' });

    const match = await user.comparePassword(password);
    if (!match)
      return res.status(401).json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu' });

    // ⭐ FIX: Lấy branchId chuẩn (string) — sau populate, branchId có thể là object hoặc null
    //   Nếu populate thành công: user.branchId = { _id, name, address, city }
    //   Nếu branch đã bị xóa: user.branchId = null (mặc dù User document vẫn có ref cũ)
    const branchObj = user.branchId && typeof user.branchId === 'object' ? user.branchId : null;
    const branchIdStr = branchObj?._id?.toString() ?? null;
    const branchNameStr = branchObj?.name ?? '';

    // Token vẫn lưu branchId là string (không lưu object)
    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role, branchId: branchIdStr },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    // ⭐ FIX: Build user response với branchId/branchName CHUẨN (lấy từ Branch collection)
    //   Không dùng user.branchName cache (có thể stale)
    const safeUser = user.toSafeObject();
    safeUser.branchId = branchIdStr;
    safeUser.branchName = branchNameStr;

    // ⭐ Log để debug khi cần
    console.log('[auth.login]', {
      username: user.username,
      role: user.role,
      branchId: branchIdStr,
      branchName: branchNameStr,
      cachedBranchName: user.branchName,
      branchPopulated: !!branchObj,
    });

    // ⭐ Bonus: Nếu branchName cache không khớp → log warning để admin biết và fix data
    if (branchNameStr && user.branchName && branchNameStr !== user.branchName) {
      console.warn(`[auth.login] ⚠️ User ${user.username} có branchName cache (${user.branchName}) KHÁC với branch thực tế (${branchNameStr}). Cần update DB!`);
    }

    res.json({
      success: true,
      message: 'Đăng nhập thành công',
      data: { token, user: safeUser },
    });
  } catch (err) { next(err); }
};

const me = async (req, res, next) => {
  try {
    // ⭐ FIX: Cũng populate branchId để FE luôn có data branch chuẩn
    const user = await User.findById(req.user.id)
      .select('-password')
      .populate('branchId', 'name address city');

    if (!user)
      return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });

    // Build response giống login
    const branchObj = user.branchId && typeof user.branchId === 'object' ? user.branchId : null;
    const branchIdStr = branchObj?._id?.toString() ?? null;
    const branchNameStr = branchObj?.name ?? '';

    const safeUser = user.toObject();
    safeUser.branchId = branchIdStr;  
    safeUser.branchName = branchNameStr;

    res.json({ success: true, data: safeUser });
  } catch (err) { next(err); }
};

const logout = (_req, res) => {
  res.json({ success: true, message: 'Đã đăng xuất' });
};

module.exports = { login, me, logout };