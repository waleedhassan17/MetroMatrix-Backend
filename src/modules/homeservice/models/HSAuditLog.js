const mongoose = require('mongoose');

/**
 * Audit trail for admin home-service mutations (HS5 rule 7):
 * who, what, when, before/after, reason.
 */
const hsAuditLogSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
    action: { type: String, required: true }, // e.g. 'booking.force-status'
    targetType: { type: String, required: true }, // 'booking' | 'dispute' | 'payout' | ...
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
    reason: { type: String, required: true },
  },
  { timestamps: true }
);

hsAuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

module.exports = mongoose.model('HSAuditLog', hsAuditLogSchema);
