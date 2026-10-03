const AdminAuditLog = require('../../models/AdminAuditLog');

/**
 * What admins did to one record, newest first — the timeline on the detail
 * screens. Comes from the audit trail, so it is complete by construction.
 */
async function historyOf(targetType, targetId, limit = 20) {
  const rows = await AdminAuditLog.find({ targetType, targetId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('actor', 'fullName role')
    .lean();
  return rows.map((r) => ({
    id: String(r._id),
    action: r.action,
    actor: r.actor ? { id: String(r.actor._id), name: r.actor.fullName, role: r.actor.role } : null,
    reason: r.reason || null,
    before: r.before ?? null,
    after: r.after ?? null,
    createdAt: r.createdAt,
  }));
}

module.exports = { historyOf };
