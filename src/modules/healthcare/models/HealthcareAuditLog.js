const mongoose = require('mongoose');

/**
 * HealthcareAuditLog — who/what/when/before/after for every admin mutation
 * in the healthcare module (mirrors ShoppingAuditLog).
 */
const healthcareAuditLogSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId },
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
    reason: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'at', updatedAt: false } }
);

healthcareAuditLogSchema.index({ at: -1 });

module.exports = mongoose.model('HealthcareAuditLog', healthcareAuditLogSchema);
