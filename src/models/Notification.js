const mongoose = require('mongoose');

/**
 * Admin notification feed.
 *
 * Read and dismissed state is PER ADMIN (readBy / dismissedBy). It used to be
 * one isRead flag on a broadcast document, so the first admin to open a
 * notification marked it read for everyone, and "delete" removed it for all.
 *
 * `requiredPermission` scopes who sees it — an admin only gets notified about
 * work they are allowed to do. `target` points at the record ({ type, id });
 * the app decides which screen that is. `dedupeKey` (unique when set) stops a
 * recurring condition from notifying twice, e.g. one reconciliation alert a day.
 */
const TYPES = [
  // Legacy types — kept so existing documents stay valid.
  'provider_registration',
  'provider_approved',
  'provider_rejected',
  'user_registration',
  'system_alert',
  'report',
  'doctor_verification',
  'doctor_approved',
  'doctor_rejected',
  // Work arriving for admins.
  'provider_submitted',
  'brand_submitted',
  'dispute_opened',
  'payout_requested',
  'return_requested',
  'wallet_adjustment_pending',
  'reconciliation_drift',
  'payment_webhook_failed',
];

const notificationSchema = new mongoose.Schema(
  {
    // A specific admin, or null for every admin who may see it.
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null, index: true },
    type: { type: String, enum: TYPES, required: true, index: true },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    severity: { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' },
    target: {
      type: { type: String, default: null },
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      // The provider the record belongs to (doctor, brand, payout), if any.
      providerId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
    },
    requiredPermission: { type: String, default: null },
    dedupeKey: { type: String, default: undefined },
    readBy: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    dismissedBy: { type: [mongoose.Schema.Types.ObjectId], default: [] },

    // Legacy payload (pre-B3 documents); new ones use `target` and `severity`.
    data: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true }
);

notificationSchema.index({ createdAt: -1 });
notificationSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });

notificationSchema.statics.TYPES = TYPES;

/**
 * The query for "notifications this admin can see": addressed to them or to
 * all admins, not dismissed by them, and within their permissions.
 */
notificationSchema.statics.visibleTo = function (admin) {
  const permissions = Object.entries(admin.effectivePermissions())
    .filter(([, allowed]) => allowed)
    .map(([key]) => key);
  return {
    $and: [
      { $or: [{ adminId: admin._id }, { adminId: null }] },
      { dismissedBy: { $ne: admin._id } },
      { $or: [{ requiredPermission: null }, { requiredPermission: { $exists: false } }, { requiredPermission: { $in: permissions } }] },
    ],
  };
};

module.exports = mongoose.model('Notification', notificationSchema);
