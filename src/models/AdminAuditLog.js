const mongoose = require('mongoose');

/**
 * The single audit trail for admin actions across every module.
 *
 * Replaces Admin.activityLog (an unbounded embedded array with a fixed action
 * enum — logging any new action threw a validation error after the action had
 * already happened) and the four per-module logs that nothing ever read.
 *
 * `action` is a dotted verb, e.g. 'provider.approve', 'wallet.adjust',
 * 'admin.login.failed'. `before`/`after` hold only the fields that changed.
 */
const adminAuditLogSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    actorRole: { type: String, default: null },
    action: { type: String, required: true },
    module: {
      type: String,
      enum: ['core', 'auth', 'homeservice', 'healthcare', 'shopping', 'wallet', 'settings', 'admins'],
      default: 'core',
    },
    targetType: { type: String, default: null },
    targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
    before: { type: mongoose.Schema.Types.Mixed, default: undefined },
    after: { type: mongoose.Schema.Types.Mixed, default: undefined },
    reason: { type: String, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed, default: undefined },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    requestId: { type: String, default: null },
    // Set by the backfill for rows copied from the old per-module logs.
    source: { type: String, default: 'live' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

adminAuditLogSchema.index({ createdAt: -1 });
adminAuditLogSchema.index({ actor: 1, createdAt: -1 });
adminAuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
adminAuditLogSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);
