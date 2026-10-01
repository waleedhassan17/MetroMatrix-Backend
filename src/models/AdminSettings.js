const mongoose = require('mongoose');

// Only settings something actually reads belong here — the editable ones are
// defined (with their consumers) in config/platformSettings.js. Fields that
// were stored and editable but enforced nowhere (timezone, language,
// autoApproveProviders, requireEmailVerification, pushNotifications,
// weeklyReports, ipWhitelist, the whole appearance section) were removed; see
// docs/ADMIN_SETTINGS.md and scripts/migrations/01-admin-auth-cleanup.js.
const adminSettingsSchema = new mongoose.Schema(
  {
    // General Settings
    general: {
      platformName: {
        type: String,
        default: 'MetroMatrix',
      },
      // No defaults: an unset contact is shown as unset, not as a personal
      // address or a placeholder number.
      contactEmail: {
        type: String,
        default: '',
      },
      supportPhone: {
        type: String,
        default: '',
      },
      // middleware/maintenance.js: non-admin API traffic gets 503 + this message.
      maintenanceMode: {
        type: Boolean,
        default: false,
      },
      maintenanceMessage: {
        type: String,
        default: '',
      },
    },

    // Notification Settings
    notifications: {
      emailNotifications: {
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
    },

    // Security Settings — all enforced by the admin auth flow (see
    // config/platformSettings.js for the consumer of each).
    security: {
      // Require TOTP two-factor sign-in for super admins.
      twoFactorEnabled: {
        type: Boolean,
        default: false,
      },
      sessionTimeout: {
        type: Number,
        default: 30, // minutes of inactivity
      },
      maxLoginAttempts: {
        type: Number,
        default: 5,
      },
      lockoutMinutes: {
        type: Number,
        default: 15,
      },
      passwordExpiry: {
        type: Number,
        default: 90, // days; 0 = never
      },
    },

    // Finance controls (super admin only).
    finance: {
      // Manual wallet adjustments above this amount (PKR) wait for a second,
      // different super admin to approve them (maker-checker).
      adjustmentApprovalThreshold: {
        type: Number,
        default: 10000,
        min: 0,
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
      // Delivery speed tiers offered at checkout. `surcharge` is charged on
      // top of the per-brand shipping fee above. These used to be a hardcoded
      // array in the app, so the price shown was never the price charged.
      // `default: undefined` keeps the field absent on documents that predate
      // it, so shopping's settingsService supplies the defaults rather than an
      // empty array shadowing them.
      deliveryTiers: {
        type: [
          new mongoose.Schema(
            {
              id: { type: String, required: true },
              name: { type: String, required: true },
              eta: { type: String, default: '' },
              description: { type: String, default: '' },
              surcharge: { type: Number, default: 0, min: 0 },
              isActive: { type: Boolean, default: true },
            },
            { _id: false }
          ),
        ],
        default: undefined,
      },
    },

    // Healthcare Settings — the SAME values the appointment payment/refund
    // code reads (healthcare settingsService). Managed via
    // GET/PATCH /api/v1/admin/healthcare/settings.
    healthcare: {
      commissionPercent: {
        type: Number,
        default: 10,
        min: 0,
        max: 100,
      },
      // Full refund when cancelling ≥ this many hours before the slot
      cancellationWindowHours: {
        type: Number,
        default: 12,
        min: 0,
      },
      // % refunded when cancelling inside the window (0 = forfeit)
      lateCancelRefundPercent: {
        type: Number,
        default: 50,
        min: 0,
        max: 100,
      },
    },

    // Home Services Settings — the SAME values the booking payment (HS4) and
    // provider matching (HS2) code reads via the homeservice settingsService.
    // Managed via GET/PATCH /api/admin/homeservice/settings.
    homeservice: {
      commissionPercent: {
        type: Number,
        default: 10,
        min: 0,
        max: 100,
      },
      defaultSearchRadiusKm: {
        type: Number,
        default: 15,
        min: 1,
      },
      // Weighted matching score (HS2). Hardcoded for FYP-I; to be learned in FYP-II.
      matchingWeights: {
        distance: { type: Number, default: 0.4, min: 0, max: 1 },
        rating: { type: Number, default: 0.4, min: 0, max: 1 },
        availability: { type: Number, default: 0.2, min: 0, max: 1 },
      },
      minPayoutAmount: {
        type: Number,
        default: 500,
        min: 0,
      },
      avgUrbanSpeedKmh: {
        type: Number,
        default: 25,
        min: 5,
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
    if (data.finance) settings.finance = { ...settings.finance.toObject(), ...data.finance };
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
