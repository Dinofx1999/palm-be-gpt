const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');

// ⭐ Sub-schema cho thiết bị đã biết của user
const knownDeviceSchema = new mongoose.Schema({
  deviceId:    { type: String, required: true, index: true },
  label:       { type: String, default: '' },
  userAgent:   { type: String, default: '' },
  components:  { type: mongoose.Schema.Types.Mixed },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt:  { type: Date, default: Date.now },
  isFallback:  { type: Boolean, default: false },
  source:      { type: String, enum: ['login', 'checkin'], default: 'login' },
}, { _id: true });

const userSchema = new mongoose.Schema({
  username:   { type: String, required: true, unique: true, trim: true, lowercase: true },
  password:   { type: String, required: true },
  fullName:   { type: String, required: true, trim: true },
  email:      { type: String, required: true, unique: true },
  phone:      { type: String, default: '' },
  avatar:     { type: String, default: '' },   // ảnh đại diện
  role:       { type: String, enum: ['Admin', 'Manager', 'Receptionist', 'Staff'], required: true },
  branchId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  branchName: { type: String, default: '' },
  isActive:   { type: Boolean, default: true },

  // ⭐ NEW 29/05/2026: Kích hoạt tài khoản qua email
  //   - isActivated: true = đã đặt mật khẩu & kích hoạt; false = chờ kích hoạt
  //   - activationTokenHash: sha256 của token gửi qua email (không lưu token gốc)
  //   - activationExpires: hạn dùng link kích hoạt
  isActivated:         { type: Boolean, default: true },   // legacy users = true; tạo mới qua flow = false
  activationTokenHash: { type: String, default: null, index: true },
  activationExpires:   { type: Date, default: null },

  knownDevices: { type: [knownDeviceSchema], default: [] },
}, { timestamps: true });

// Hash password trước khi save
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

// Auto-sync branchName khi branchId thay đổi (save)
userSchema.pre('save', async function () {
  if (!this.isModified('branchId')) return;
  if (!this.branchId) { this.branchName = ''; return; }
  try {
    const Branch = mongoose.model('Branch');
    const branch = await Branch.findById(this.branchId).select('name').lean();
    this.branchName = branch?.name ?? '';
  } catch (err) {
    console.error('[User pre-save] failed to sync branchName:', err.message);
  }
});

// Auto-sync branchName khi update
userSchema.pre(['findOneAndUpdate', 'updateOne'], async function () {
  const update = this.getUpdate();
  if (!update) return;
  const $set = update.$set ?? update;
  if (!('branchId' in $set)) return;
  if (!$set.branchId) {
    $set.branchName = '';
    if (update.$set) update.$set = $set;
    return;
  }
  try {
    const Branch = mongoose.model('Branch');
    const branch = await Branch.findById($set.branchId).select('name').lean();
    $set.branchName = branch?.name ?? '';
    if (update.$set) update.$set = $set;
  } catch (err) {
    console.error('[User pre-update] failed to sync branchName:', err.message);
  }
});

userSchema.methods.comparePassword = async function (plain) {
  return bcrypt.compare(plain, this.password);
};

userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.knownDevices;
  delete obj.activationTokenHash;
  delete obj.activationExpires;
  return obj;
};

// ⭐ Sinh token kích hoạt mới: trả token GỐC (gửi email), lưu HASH + hạn vào doc.
//   Gọi xong nhớ .save(). Token sống `hours` giờ (mặc định 48h).
userSchema.methods.createActivationToken = function (hours = 48) {
  const raw = crypto.randomBytes(32).toString('hex');
  this.activationTokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  this.activationExpires = new Date(Date.now() + hours * 3600 * 1000);
  return raw;
};

// ⭐ Băm token gốc (để so khi user bấm link)
userSchema.statics.hashToken = function (raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
};

userSchema.index({ username: 1 });
userSchema.index({ branchId: 1 });
userSchema.index({ 'knownDevices.deviceId': 1 });

module.exports = mongoose.model('User', userSchema);