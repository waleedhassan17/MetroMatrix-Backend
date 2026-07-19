const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

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
    refreshToken: String,
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

// Hash password before saving
adminSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    next();
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Match passwords
adminSchema.methods.matchPassword = async function (enteredPassword) {
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

// Sanitize admin data for response
adminSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshToken;
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpire;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Admin', adminSchema);