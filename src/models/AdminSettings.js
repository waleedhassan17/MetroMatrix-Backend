const mongoose = require('mongoose');

const adminSettingsSchema = new mongoose.Schema(
  {
    // General Settings
    general: {
      platformName: {
        type: String,
        default: 'MetroMatrix',
      },
      contactEmail: {
        type: String,
        default: 'waleedhassansfd@gmail.com',
      },
      supportPhone: {
        type: String,
        default: '+92 42 1234567',
      },
      timezone: {
        type: String,
        default: 'Asia/Karachi',
      },
      language: {
        type: String,
        default: 'en',
      },
      autoApproveProviders: {
        type: Boolean,
        default: false,
      },
      requireEmailVerification: {
        type: Boolean,
        default: true,
      },
      maintenanceMode: {
        type: Boolean,
        default: false,
      },
    },

    // Notification Settings
    notifications: {
      emailNotifications: {
        type: Boolean,
        default: true,
      },
      pushNotifications: {
        type: Boolean,
        default: true,
      },
      providerRegistrations: {
        type: Boolean,
        default: true,
      },
      userRegistrations: {
        type: Boolean,
        default: true,
      },
      systemAlerts: {
        type: Boolean,
        default: true,
      },
      weeklyReports: {
        type: Boolean,
        default: false,
      },
    },

    // Security Settings
    security: {
      twoFactorEnabled: {
        type: Boolean,
        default: false,
      },
      sessionTimeout: {
        type: Number,
        default: 30, // minutes
      },
      maxLoginAttempts: {
        type: Number,
        default: 5,
      },
      passwordExpiry: {
        type: Number,
        default: 90, // days
      },
      ipWhitelist: {
        type: [String],
        default: [],
      },
    },

    // Appearance Settings
    appearance: {
      theme: {
        type: String,
        enum: ['light', 'dark', 'auto'],
        default: 'light',
      },
      primaryColor: {
        type: String,
        default: '#6366f1',
      },
      accentColor: {
        type: String,
        default: '#8b5cf6',
      },
      compactMode: {
        type: Boolean,
        default: false,
      },
    },

    // Shopping Settings — the SAME values shopping checkout/inventory/analytics read.
    // Managed via GET/PATCH /api/shopping/admin/settings.
    shopping: {
      commissionPercent: {
        type: Number,
        default: 10,
        min: 0,
        max: 100,
      },
      shippingFeePerBrand: {
        type: Number,
        default: 150,
        min: 0,
      },
      freeShippingThreshold: {
        type: Number,
        default: 3000,
        min: 0,
      },
      lowStockThreshold: {
        type: Number,
        default: 5,
        min: 0,
      },
      defaultReturnDays: {
        type: Number,
        default: 7,
        min: 0,
      },
      autoApproveBrands: {
        type: Boolean,
        default: false,
      },
    },

    // Metadata
    lastUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
    },
  },
  {
    timestamps: true,
  }
);

// Ensure only one settings document exists (singleton pattern)
adminSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  }
  return settings;
};

adminSettingsSchema.statics.updateSettings = async function (category, data, adminId) {
  let settings = await this.getSettings();
  
  if (category === 'all') {
    // Update all categories
    if (data.general) settings.general = { ...settings.general.toObject(), ...data.general };
    if (data.notifications) settings.notifications = { ...settings.notifications.toObject(), ...data.notifications };
    if (data.security) settings.security = { ...settings.security.toObject(), ...data.security };
    if (data.appearance) settings.appearance = { ...settings.appearance.toObject(), ...data.appearance };
  } else {
    // Update specific category
    settings[category] = { ...settings[category].toObject(), ...data };
  }
  
  settings.lastUpdatedBy = adminId;
  await settings.save();
  
  return settings;
};

const AdminSettings = mongoose.model('AdminSettings', adminSettingsSchema);

module.exports = AdminSettings;
