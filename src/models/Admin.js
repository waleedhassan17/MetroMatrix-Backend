const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { hashPasswordPreSave } = require('../utils/hashPassword');

const adminSchema = new mongoose.Schema(
  {
    // Basic Information
    email: {
      type: String,
      required: [true, 'Please provide an email'],
      unique: true,
      lowercase: true,
      match: [
        /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
        'Please provide a valid email',
      ],
    },
    password: {
      type: String,
      required: [true, 'Please provide a password'],
      minlength: 6,
      select: false,
    },
    fullName: {
      type: String,
      required: [true, 'Please provide your full name'],
      trim: true,
    },
    phoneNumber: {
      type: String,
      match: [/^[0-9]{10,15}$/, 'Please provide a valid phone number'],
    },

    // Admin Role
    role: {
      type: String,
      enum: ['super_admin', 'admin', 'moderator'],
      default: 'admin',
    },

    // Permissions
    permissions: {
      canApproveProviders: {
        type: Boolean,
        default: true,
      },
      canManageUsers: {
        type: Boolean,
        default: true,
      },
      canManagePosts: {
        type: Boolean,
        default: true,
      },
      canViewAnalytics: {
        type: Boolean,
        default: true,
      },
      canManageSettings: {
        type: Boolean,
        default: false,
      },
      canManageNotifications: {
        type: Boolean,
        default: true,
      },
      canManageAdmins: {
        type: Boolean,
        default: false,
      },
      // Shopping module oversight (brands, orders, outlets, shopping settings)
      canManageShopping: {
        type: Boolean,
        default: true,
      },
      // Healthcare module oversight (doctors, appointments, clinics, reviews, settings)
      canManageHealthcare: {
        type: Boolean,
        default: true,
      },
    },

    // Profile
    avatar: {
      type: String,
      default: null,
    },
    profilePhoto: {
      type: String,
      default: null,
    },
    profilePhotoId: {
      type: String,
    },

    // Status
    isActive: {
      type: Boolean,
      default: true,
    },
    isSuperAdmin: {
      type: Boolean,
      default: false,
    },

    // Authentication
    lastLoginDate: Date,
    // Set for bootstrap/temporary passwords (seed-admin, admin-issued resets):
    // the first sign-in gets a session that can only change the password.
    mustChangePassword: {
      type: Boolean,
      default: false,
    },
    passwordChangedAt: Date,
    // Sessions live in AdminSession (one per device, hashed rotating refresh
    // token). The old single plaintext `refreshToken` field is gone; the
    // cleanup migration unsets it from existing documents.

    // TOTP two-factor sign-in. Secrets are AES-GCM encrypted
    // (services/admin/totp.js) and never selected by default.
    twoFactor: {
      enabled: { type: Boolean, default: false },
      secretEnc: { type: String, select: false },
      pendingSecretEnc: { type: String, select: false },
      recoveryCodeHashes: { type: [String], select: false, default: undefined },
      // Last accepted time-step counter — a code can't be used twice.
      lastUsedCounter: { type: Number, select: false, default: 0 },
      enrolledAt: Date,
    },
    resetPasswordToken: String,
    resetPasswordExpire: Date,

    // Activity Tracking
    activityLog: [
      {
        action: {
          type: String,
          enum: [
            'login',
            'logout',
            'approve_provider',
            'reject_provider',
            'deactivate_user',
            'activate_user',
            'delete_post',
            'create_admin',
            'update_settings',
          ],
        },
        targetId: mongoose.Schema.Types.ObjectId,
        targetType: String,
        details: String,
        timestamp: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    // Statistics
    stats: {
      totalProvidersApproved: {
        type: Number,
        default: 0,
      },
      totalProvidersRejected: {
        type: Number,
        default: 0,
      },
      totalUsersManaged: {
        type: Number,
        default: 0,
      },
      totalPostsModerated: {
        type: Number,
        default: 0,
      },
    },

    // Created by (for tracking who created this admin)
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
adminSchema.index({ email: 1 });
adminSchema.index({ role: 1 });
adminSchema.index({ isActive: 1 });

// Hash password before saving (shared hook — see utils/hashPassword.js for
// the double-hash bug it fixes). Admin had the identical missing-`return`,
// so admin logins were corrupting their own hash too.
adminSchema.pre('save', hashPasswordPreSave);

// Match passwords
adminSchema.methods.matchPassword = async function (enteredPassword) {
  // See User.matchPassword.
  if (!this.password) return false;
  return await bcrypt.compare(enteredPassword, this.password);
};

// Generate reset password token
adminSchema.methods.getResetPasswordToken = function () {
  const resetToken = crypto.randomBytes(20).toString('hex');

  this.resetPasswordToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');

  this.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // 10 minutes

  return resetToken;
};

// Log admin activity
adminSchema.methods.logActivity = function (action, targetId, targetType, details) {
  this.activityLog.push({
    action,
    targetId,
    targetType,
    details,
    timestamp: new Date(),
  });

  // Keep only last 100 activities
  if (this.activityLog.length > 100) {
    this.activityLog = this.activityLog.slice(-100);
  }
};

// Update statistics
adminSchema.methods.incrementStat = function (statName) {
  if (this.stats[statName] !== undefined) {
    this.stats[statName] += 1;
  }
};

// Check permissions
adminSchema.methods.hasPermission = function (permission) {
  if (this.isSuperAdmin) return true;
  return this.permissions[permission] === true;
};

// Every permission flag the schema defines (new flags are picked up
// automatically).
const PERMISSION_KEYS = Object.keys(adminSchema.paths)
  .filter((p) => p.startsWith('permissions.'))
  .map((p) => p.slice('permissions.'.length));
adminSchema.statics.PERMISSION_KEYS = PERMISSION_KEYS;

// Effective permissions: what this admin can actually do (a super admin has
// every flag regardless of what is stored).
adminSchema.methods.effectivePermissions = function () {
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, this.isSuperAdmin ? true : this.permissions?.[k] === true]));
};

// Sanitize admin data for response
adminSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshToken;
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpire;
  if (obj.twoFactor) {
    delete obj.twoFactor.secretEnc;
    delete obj.twoFactor.pendingSecretEnc;
    delete obj.twoFactor.recoveryCodeHashes;
    delete obj.twoFactor.lastUsedCounter;
  }
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Admin', adminSchema);