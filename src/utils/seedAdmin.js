// backend/utils/seedAdmin.js
const User = require('../models/User');

/**
 * Tự động tạo tài khoản Admin mặc định nếu DB chưa có user nào.
 * Gọi sau khi DB đã connect.
 *
 * ENV (tuỳ chọn, đều có default):
 *   SEED_ADMIN_USERNAME   (default: 'admin')
 *   SEED_ADMIN_PASSWORD   (default: 'admin@123')
 *   SEED_ADMIN_EMAIL      (default: 'admin@luxstay.local')
 *   SEED_ADMIN_FULLNAME   (default: 'Administrator')
 */
async function seedAdminIfEmpty() {
  try {
    const count = await User.countDocuments();
    if (count > 0) {
      // Đã có user → không seed
      return { seeded: false, reason: 'users_exist', total: count };
    }

    const username = (process.env.SEED_ADMIN_USERNAME || 'admin').toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD || 'admin@123';
    const email    = process.env.SEED_ADMIN_EMAIL    || 'admin@luxstay.local';
    const fullName = process.env.SEED_ADMIN_FULLNAME || 'Administrator';

    // Dùng .create() để pre('save') hook hash password
    const admin = await User.create({
      username,
      password,
      fullName,
      email,
      role: 'Admin',
      branchId: null,
      branchName: '',
      isActive: true,
    });

    console.log('\n┌──────────────────────────────────────────────┐');
    console.log('│  🔐  AUTO-SEEDED DEFAULT ADMIN ACCOUNT       │');
    console.log('├──────────────────────────────────────────────┤');
    console.log(`│  Username : ${username.padEnd(33)}│`);
    console.log(`│  Password : ${password.padEnd(33)}│`);
    console.log(`│  Email    : ${email.padEnd(33)}│`);
    console.log('├──────────────────────────────────────────────┤');
    console.log('│  ⚠️   Đổi mật khẩu ngay sau lần đăng nhập đầu │');
    console.log('└──────────────────────────────────────────────┘\n');

    return { seeded: true, user: admin.toSafeObject() };
  } catch (err) {
    console.error('[seedAdmin] Lỗi khi tạo admin mặc định:', err.message);
    return { seeded: false, reason: 'error', error: err.message };
  }
}

module.exports = { seedAdminIfEmpty };