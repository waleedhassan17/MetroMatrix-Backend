const AdminAuditLog = require('../models/AdminAuditLog');
const logger = require('../utils/logger');

// Never store credentials in the audit trail, however they got into a payload.
const SECRET_KEY = /pass(word)?|token|secret|otp|^code$|recovery/i;

function redact(value, depth = 0) {
  if (value == null || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Date || typeof value !== 'object') return value;
  if (typeof value.toObject === 'function') value = value.toObject();
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

const plain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc || {});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The changed part of two snapshots: { before, after } containing only the
 * listed fields (or every top-level field) whose value differs.
 */
function diff(beforeDoc, afterDoc, fields) {
  const a = plain(beforeDoc);
  const b = plain(afterDoc);
  const keys = fields || [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const before = {};
  const after = {};
  for (const key of keys) {
    if (key === 'updatedAt' || key === '__v') continue;
    if (!same(a[key], b[key])) {
      before[key] = a[key];
      after[key] = b[key];
    }
  }
  return { before, after };
}

let failures = 0;

/**
 * Record an admin action. Never throws: a failed audit write is logged and
 * counted (surfaced by /health/ready) but must not fail the action the admin
 * already performed.
 *
 * @param {object} req      the request (actor, ip, user agent, request id)
 * @param {object} entry    { action, module, targetType, targetId, before, after, reason, meta, actor? }
 *                          `actor` overrides req.user — for events with no
 *                          signed-in admin (failed logins, token reuse).
 */
async function audit(req, entry) {
  try {
    const actor = entry.actor !== undefined ? entry.actor : req?.isAdmin ? req.user : null;
    await AdminAuditLog.create({
      actor: actor?._id || null,
      actorRole: actor?.role || null,
      action: entry.action,
      module: entry.module || 'core',
      targetType: entry.targetType || null,
      targetId: entry.targetId || null,
      before: entry.before === undefined ? undefined : redact(entry.before),
      after: entry.after === undefined ? undefined : redact(entry.after),
      reason: entry.reason || '',
      meta: entry.meta === undefined ? undefined : redact(entry.meta),
      ip: req?.ip || null,
      userAgent: req?.get?.('user-agent')?.slice(0, 300) || null,
      requestId: req?.id || null,
    });
    return true;
  } catch (err) {
    failures += 1;
    (req?.log || logger).error({ err, action: entry?.action }, 'audit write failed');
    return false;
  }
}

module.exports = { audit, diff, redact, auditFailureCount: () => failures };
