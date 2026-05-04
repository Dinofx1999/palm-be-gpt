const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username:   { type: String, required: true, unique: true, trim: true, lowercase: true },
  password:   { type: String, required: true },
  fullName:   { type: String, required: true, trim: true },
  email:      { type: String, required: true, unique: true },
  phone:      { type: String, default: '' },
  role:       { type: String, enum: ['Admin', 'Manager', 'Receptionist', 'Staff'], required: true },
  branchId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
  branchName: { type: String, default: '' },
  isActive:   { type: Boolean, default: true },
}, { timestamps: true });

// Hash password trước khi save — không dùng callback
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.comparePassword = async function (plain) {
  return bcrypt.compare(plain, this.password);
};

userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

userSchema.index({ username: 1 });
userSchema.index({ branchId: 1 });

module.exports = mongoose.model('User', userSchema);