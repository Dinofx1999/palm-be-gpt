const crypto = require('crypto');
const User = require('../models/User');

// URL frontend để build link kích hoạt (đặt trong .env: FRONTEND_URL=https://palmhotel.com.vn)
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

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

// ── Gửi email kích hoạt (dùng cấu hình email + thương hiệu của chi nhánh user) ─
async function sendActivationEmail(user, rawToken) {
  const { sendMail } = require('../utils/mailer');
  // Thương hiệu = tên chi nhánh của tài khoản (fallback nếu thiếu)
  let brand = user.branchName || '';
  if (!brand && user.branchId) {
    try {
      const Branch = require('../models/Branch');
      const b = await Branch.findById(user.branchId).select('name').lean();
      brand = b?.name || '';
    } catch { /* ignore */ }
  }
  if (!brand) brand = 'LuxHotel PMS';

  const link = `${FRONTEND_URL.replace(/\/$/, '')}/activate?token=${rawToken}&uid=${user._id}`;
  const html = `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1E293B;">
    <div style="background:linear-gradient(135deg,#0B76EF,#1E40AF);padding:20px 24px;border-radius:12px 12px 0 0;">
      <div style="color:#BFDBFE;font-size:13px;">${brand}</div>
      <div style="color:#fff;font-size:20px;font-weight:800;">Kích hoạt tài khoản</div>
    </div>
    <div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px;">
      <p>Xin chào <b>${user.fullName}</b>,</p>
      <p>Tài khoản <b>${user.username}</b> đã được tạo tại <b>${brand}</b>. Bấm nút bên dưới để đặt mật khẩu và kích hoạt tài khoản:</p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${link}" style="background:#0B76EF;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;display:inline-block;">Kích hoạt & đặt mật khẩu</a>
      </p>
      <p style="font-size:13px;color:#64748B;">Hoặc copy link sau vào trình duyệt:<br><span style="word-break:break-all;color:#0B76EF;">${link}</span></p>
      <p style="font-size:13px;color:#EF4444;">Link có hiệu lực trong 48 giờ.</p>
      <p style="font-size:12px;color:#94A3B8;margin-top:16px;">Nếu bạn không yêu cầu tài khoản này, vui lòng bỏ qua email.</p>
    </div>
  </div>`;
  await sendMail({
    to: user.email,
    branchId: user.branchId,
    subject: `Kích hoạt tài khoản — ${brand}`,
    html,
  });
}

// POST /api/users — tạo tài khoản (CHỜ KÍCH HOẠT + gửi email)
const create = async (req, res, next) => {
  try {
    const { username, fullName, email, role, branchId } = req.body;
    if (!username || !fullName || !email || !role || !branchId)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc' });

    const exists = await User.findOne({ $or: [{ username }, { email }] });
    if (exists) return res.status(400).json({ success: false, message: 'Username hoặc email đã tồn tại' });

    // Tạo user CHƯA kích hoạt, mật khẩu ngẫu nhiên (user sẽ tự đặt khi kích hoạt)
    const randomPwd = crypto.randomBytes(24).toString('hex');
    const user = new User({
      username, fullName, email, role, branchId,
      phone: req.body.phone || '',
      password: randomPwd,
      isActive: false,       // chưa kích hoạt thì chưa đăng nhập được
      isActivated: false,
    });
    const rawToken = user.createActivationToken(48);
    await user.save();

    // Gửi email kích hoạt — nếu lỗi (email chi nhánh chưa cấu hình) vẫn tạo, báo để resend
    let emailSent = true, emailError = null;
    try {
      await sendActivationEmail(user, rawToken);
    } catch (e) {
      emailSent = false;
      emailError = e.message;
      console.error('[users.create] gửi email kích hoạt thất bại:', e.message);
    }

    res.status(201).json({
      success: true,
      message: emailSent
        ? `Đã tạo tài khoản & gửi email kích hoạt tới ${email}`
        : `Đã tạo tài khoản nhưng GỬI EMAIL THẤT BẠI (${emailError}). Kiểm tra cấu hình email của chi nhánh rồi gửi lại link kích hoạt.`,
      data: { user: user.toSafeObject(), emailSent },
    });
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
    if (req.params.id === req.user.id)
      return res.status(400).json({ success: false, message: 'Không thể xoá tài khoản đang đăng nhập' });
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user)
      return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
    res.json({ success: true, message: `Đã xoá người dùng ${user.username}` });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────
// ⭐ KÍCH HOẠT TÀI KHOẢN (public — user bấm link trong email)
// ─────────────────────────────────────────────────────────────

// GET /api/users/activation/verify?token=&uid= — kiểm tra link còn hiệu lực (cho FE hiện form)
const verifyActivation = async (req, res, next) => {
  try {
    const { token, uid } = req.query;
    if (!token || !uid) return res.status(400).json({ success: false, message: 'Link không hợp lệ' });
    const user = await User.findById(uid).select('username fullName email activationTokenHash activationExpires isActivated');
    if (!user || !user.activationTokenHash)
      return res.status(400).json({ success: false, message: 'Link không hợp lệ hoặc đã dùng' });
    if (user.activationExpires && user.activationExpires < new Date())
      return res.status(400).json({ success: false, message: 'Link đã hết hạn. Liên hệ quản trị viên gửi lại.' });
    if (User.hashToken(token) !== user.activationTokenHash)
      return res.status(400).json({ success: false, message: 'Link không hợp lệ' });

    res.json({ success: true, data: { username: user.username, fullName: user.fullName, email: user.email } });
  } catch (err) { next(err); }
};

// POST /api/users/activate — { token, uid, password } → đặt mật khẩu + kích hoạt
const activate = async (req, res, next) => {
  try {
    const { token, uid, password } = req.body;
    if (!token || !uid || !password)
      return res.status(400).json({ success: false, message: 'Thiếu thông tin' });
    if (password.length < 6)
      return res.status(400).json({ success: false, message: 'Mật khẩu tối thiểu 6 ký tự' });

    const user = await User.findById(uid);
    if (!user || !user.activationTokenHash)
      return res.status(400).json({ success: false, message: 'Link không hợp lệ hoặc đã dùng' });
    if (user.activationExpires && user.activationExpires < new Date())
      return res.status(400).json({ success: false, message: 'Link đã hết hạn. Liên hệ quản trị viên gửi lại.' });
    if (User.hashToken(token) !== user.activationTokenHash)
      return res.status(400).json({ success: false, message: 'Link không hợp lệ' });

    user.password = password;          // pre-save hook tự hash
    user.isActive = true;
    user.isActivated = true;
    user.activationTokenHash = null;   // vô hiệu link sau khi dùng
    user.activationExpires = null;
    await user.save();

    res.json({ success: true, message: 'Kích hoạt tài khoản thành công. Bạn có thể đăng nhập.' });
  } catch (err) { next(err); }
};

// POST /api/users/forgot-password — { account } (username hoặc email)
//   PUBLIC. Luôn trả success (không tiết lộ tài khoản có tồn tại hay không).
//   Nếu tìm thấy → sinh token + gửi email link đặt lại mật khẩu (tới trang /activate).
const forgotPassword = async (req, res, next) => {
  try {
    const account = String(req.body?.account || '').trim();
    if (!account) return res.status(400).json({ success: false, message: 'Nhập tên đăng nhập hoặc email' });

    const user = await User.findOne({
      $or: [{ username: account.toLowerCase() }, { email: account }],
    });

    // Tìm thấy + có chi nhánh → gửi email. Luôn trả success ở cuối.
    if (user && user.branchId) {
      try {
        const rawToken = user.createActivationToken(48);
        await user.save();
        const { sendMail } = require('../utils/mailer');
        // Thương hiệu = tên chi nhánh của tài khoản
        let brand = user.branchName || '';
        if (!brand) {
          try {
            const Branch = require('../models/Branch');
            const b = await Branch.findById(user.branchId).select('name').lean();
            brand = b?.name || '';
          } catch { /* ignore */ }
        }
        if (!brand) brand = 'LuxHotel PMS';

        const link = `${FRONTEND_URL.replace(/\/$/, '')}/activate?token=${rawToken}&uid=${user._id}&mode=reset`;
        const html = `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1E293B;">
          <div style="background:linear-gradient(135deg,#0B76EF,#1E40AF);padding:20px 24px;border-radius:12px 12px 0 0;">
            <div style="color:#BFDBFE;font-size:13px;">${brand}</div>
            <div style="color:#fff;font-size:20px;font-weight:800;">Đặt lại mật khẩu</div>
          </div>
          <div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 12px 12px;">
            <p>Xin chào <b>${user.fullName}</b>,</p>
            <p>Có yêu cầu đặt lại mật khẩu cho tài khoản <b>${user.username}</b> tại <b>${brand}</b>. Bấm nút bên dưới để đặt mật khẩu mới:</p>
            <p style="text-align:center;margin:24px 0;">
              <a href="${link}" style="background:#0B76EF;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;display:inline-block;">Đặt lại mật khẩu</a>
            </p>
            <p style="font-size:13px;color:#64748B;">Hoặc copy link:<br><span style="word-break:break-all;color:#0B76EF;">${link}</span></p>
            <p style="font-size:13px;color:#EF4444;">Link có hiệu lực 48 giờ.</p>
            <p style="font-size:12px;color:#94A3B8;margin-top:16px;">Nếu bạn không yêu cầu, hãy bỏ qua email này — mật khẩu của bạn không thay đổi.</p>
          </div>
        </div>`;
        await sendMail({ to: user.email, branchId: user.branchId, subject: `Đặt lại mật khẩu — ${brand}`, html });
      } catch (e) {
        console.error('[users.forgotPassword] gửi email thất bại:', e.message);
        // vẫn trả generic success bên dưới
      }
    }

    res.json({ success: true, message: 'Nếu tài khoản tồn tại, email đặt lại mật khẩu đã được gửi. Vui lòng kiểm tra hộp thư.' });
  } catch (err) { next(err); }
};

// POST /api/users/:id/resend-activation — Admin gửi lại link kích hoạt
const resendActivation = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
    if (user.isActivated)
      return res.status(400).json({ success: false, message: 'Tài khoản đã kích hoạt rồi' });

    const rawToken = user.createActivationToken(48);
    await user.save();
    try {
      await sendActivationEmail(user, rawToken);
    } catch (e) {
      return res.status(500).json({ success: false, message: `Gửi email thất bại: ${e.message}` });
    }
    res.json({ success: true, message: `Đã gửi lại link kích hoạt tới ${user.email}` });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────
// HỒ SƠ CÁ NHÂN (user thao tác với chính mình)
// ─────────────────────────────────────────────────────────────
const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
    res.json({ success: true, data: { user } });
  } catch (err) { next(err); }
};

const updateMe = async (req, res, next) => {
  try {
    const allowed = ['email', 'phone', 'avatar'];
    const payload = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) payload[k] = req.body[k]; });
    if (Object.keys(payload).length === 0)
      return res.status(400).json({ success: false, message: 'Không có thông tin nào để cập nhật' });
    if (payload.email) {
      const dup = await User.findOne({ email: payload.email, _id: { $ne: req.user.id } });
      if (dup) return res.status(400).json({ success: false, message: 'Email đã được sử dụng' });
    }
    const user = await User.findByIdAndUpdate(req.user.id, payload, {
      new: true, runValidators: true,
    }).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
    res.json({ success: true, message: 'Cập nhật hồ sơ thành công', data: { user } });
  } catch (err) { next(err); }
};

const changeMyPassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ success: false, message: 'Thiếu mật khẩu hiện tại hoặc mật khẩu mới' });
    if (newPassword.length < 6)
      return res.status(400).json({ success: false, message: 'Mật khẩu mới tối thiểu 6 ký tự' });
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });
    const ok = await user.comparePassword(currentPassword);
    if (!ok) return res.status(400).json({ success: false, message: 'Mật khẩu hiện tại không đúng' });
    user.password = newPassword;
    await user.save();
    res.json({ success: true, message: 'Đổi mật khẩu thành công' });
  } catch (err) { next(err); }
};

module.exports = {
  getAll, getOne, create, update, toggle, resetPassword, remove,
  getMe, updateMe, changeMyPassword,
  // kích hoạt
  verifyActivation, activate, resendActivation, forgotPassword,
};