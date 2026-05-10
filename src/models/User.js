const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

// ⭐ NEW: Sub-schema cho thiết bị đã biết của user
const knownDeviceSchema = new mongoose.Schema({
  deviceId:    { type: String, required: true, index: true },
  label:       { type: String, default: '' },              // VD: "iPhone của tôi"
  userAgent:   { type: String, default: '' },
  components:  { type: mongoose.Schema.Types.Mixed },      // raw fingerprint data (debug)
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt:  { type: Date, default: Date.now },
  isFallback:  { type: Boolean, default: false },          // true nếu dùng UUID fallback
  source:      { type: String, enum: ['login', 'checkin'], default: 'login' },
}, { _id: true });

const userSchema = new mongoose.Schema({
  username:   { type: String, required: true, unique: true, trim: true, lowercase: true },
  password:   { type: String, required: true },
  fullName:   { type: String, required: true, trim: true },
  email:      { type: String, required: true, unique: true },
  phone:      { type: String, default: '' },
  role:       { type: String, enum: ['Admin', 'Manager', 'Receptionist', 'Staff'], required: true },
  branchId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  // ⭐ branchName là CACHE để tránh phải populate mỗi lần — auto-sync qua pre-save hook
  //   KHÔNG dùng field này ở route /auth/login (nơi cần data chuẩn) → luôn populate
  branchName: { type: String, default: '' },
  isActive:   { type: Boolean, default: true },

  // ⭐ NEW: Device binding — list thiết bị user đã đăng nhập
  knownDevices: {
    type: [knownDeviceSchema],
    default: [],
  },
}, { timestamps: true });

// Hash password trước khi save — không dùng callback
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

// ⭐ Auto-sync branchName mỗi khi branchId thay đổi
//   Tránh data lệch giữa branchId (ref) và branchName (cache string)
userSchema.pre('save', async function () {
  if (!this.isModified('branchId')) return;
  if (!this.branchId) {
    this.branchName = '';
    return;
  }
  try {
    const Branch = mongoose.model('Branch');
    const branch = await Branch.findById(this.branchId).select('name').lean();
    this.branchName = branch?.name ?? '';
  } catch (err) {
    console.error('[User pre-save] failed to sync branchName:', err.message);
  }
});

// ⭐ Cũng auto-sync branchName khi update qua findOneAndUpdate / updateOne
userSchema.pre(['findOneAndUpdate', 'updateOne'], async function () {
  const update = this.getUpdate();
  if (!update) return;
  // Hỗ trợ cả $set và direct fields
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
  // ⭐ Không leak knownDevices ra response thông thường (Admin riêng có endpoint)
  delete obj.knownDevices;
  return obj;
};

userSchema.index({ username: 1 });
userSchema.index({ branchId: 1 });
// ⭐ NEW: Index cho query "user nào đang owning deviceId này"
userSchema.index({ 'knownDevices.deviceId': 1 });

module.exports = mongoose.model('User', userSchema);