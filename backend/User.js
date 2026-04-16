// models/User.js — UPDATED: adds vegPreference field
// This is the only model change needed for spec compliance

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');

const userSchema = new mongoose.Schema({
  name:     { type: String, required: [true, 'Name is required'], trim: true },
  email:    { type: String, required: [true, 'Email is required'], unique: true, lowercase: true, trim: true },
  password: { type: String, required: [true, 'Password is required'], minlength: 6, select: false },

  // Learned preferences
  preferredCuisines:   { type: [String], default: [] },
  budgetPreference:    { type: Number, default: 2, min: 1, max: 3 },
  spicePreference:     { type: Number, default: 3, min: 1, max: 5 },

  // ── NEW: Veg/Non-Veg preference (spec requirement) ────────
  // 'veg'    = user only wants vegetarian restaurants
  // 'nonveg' = user prefers non-veg options
  // 'any'    = no preference (default)
  vegPreference: {
    type:    String,
    enum:    ['veg', 'nonveg', 'any'],
    default: 'any',
  },

  likedRestaurants:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant' }],
  dislikedRestaurants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant' }],

  // Email verification (OTP)
  emailVerified:    { type: Boolean, default: false },
  emailOTP:         { type: String, select: false },
  emailOTPExpires:  { type: Date,   select: false },

  // Password reset
  passwordResetToken:   { type: String, select: false },
  passwordResetExpires: { type: Date,   select: false },

}, { timestamps: true });

// Hash password before save
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.createEmailOTP = function () {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  this.emailOTP        = require('crypto').createHash('sha256').update(otp).digest('hex');
  this.emailOTPExpires = new Date(Date.now() + 10 * 60 * 1000);
  return otp;
};

userSchema.methods.verifyEmailOTP = function (plain) {
  const hash = require('crypto').createHash('sha256').update(plain).digest('hex');
  return this.emailOTP === hash && this.emailOTPExpires > new Date();
};

userSchema.methods.createPasswordResetToken = function () {
  const resetToken = crypto.randomBytes(32).toString('hex');
  this.passwordResetToken   = crypto.createHash('sha256').update(resetToken).digest('hex');
  this.passwordResetExpires = new Date(Date.now() + 30 * 60 * 1000);
  return resetToken;
};

module.exports = mongoose.model('User', userSchema);
