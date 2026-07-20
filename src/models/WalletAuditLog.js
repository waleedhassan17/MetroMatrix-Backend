const mongoose = require('mongoose');

/**
 * Audit trail for admin wallet mutations (Part F.7-equivalent): who, what,
 * when, before/after, reason. Same shape as the other module audit logs
 * (HSAuditLog, ShoppingAuditLog, HealthcareAuditLog) — kept separate rather
 * than a shared model because each module owns its own audit collection.
 */
const walletAuditLogSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
    action: { type: String, required: true }, // e.g. 'wallet.adjust'
    targetType: { type: String, required: true, default: 'wallet' },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
    reason: { type: String, required: true },
  },
  { timestamps: true }
);

walletAuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

module.exports = mongoose.model('WalletAuditLog', walletAuditLogSchema);
