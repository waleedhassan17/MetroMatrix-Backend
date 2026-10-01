/**
 * 03 — unified audit trail backfill (phase B2).
 *
 * Copies the four per-module audit collections (written, never read) and the
 * embedded Admin.activityLog into AdminAuditLog, then unsets activityLog and
 * stats from the admins. Each copied row carries meta.legacyId, so running
 * this again copies nothing twice.
 *
 *   --drop-legacy   also drop hsauditlogs / shoppingauditlogs /
 *                   healthcareauditlogs / walletauditlogs after copying.
 *                   Leave it off on the first run; verify, then re-run with it.
 *
 * Rollback: delete AdminAuditLog rows with source 'backfill:*'. activityLog
 * is not restored (nothing reads it).
 */
const { runMigration } = require('./lib');
const AdminAuditLog = require('../../src/models/AdminAuditLog');

const LEGACY = [
  { coll: 'hsauditlogs', module: 'homeservice', prefix: 'homeservice', time: 'createdAt' },
  { coll: 'shoppingauditlogs', module: 'shopping', prefix: 'shopping', time: 'at' },
  { coll: 'healthcareauditlogs', module: 'healthcare', prefix: 'healthcare', time: 'at' },
  { coll: 'walletauditlogs', module: 'wallet', prefix: '', time: 'createdAt', targetType: 'Wallet' },
];

async function existingLegacyIds(ids) {
  if (!ids.length) return new Set();
  const rows = await AdminAuditLog.collection
    .find({ 'meta.legacyId': { $in: ids } }, { projection: { 'meta.legacyId': 1 } })
    .toArray();
  return new Set(rows.map((r) => r.meta.legacyId));
}

async function insertNew(rows, dry) {
  const have = await existingLegacyIds(rows.map((r) => r.meta.legacyId));
  const fresh = rows.filter((r) => !have.has(r.meta.legacyId));
  if (!dry && fresh.length) await AdminAuditLog.collection.insertMany(fresh, { ordered: false });
  return fresh.length;
}

runMigration('03-audit-backfill', async ({ dry, db, log }) => {
  const dropLegacy = process.argv.includes('--drop-legacy');
  const report = {};
  const present = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  for (const src of LEGACY) {
    if (!present.has(src.coll)) {
      report[src.coll] = 'absent';
      continue;
    }
    const docs = await db.collection(src.coll).find({}).toArray();
    const rows = docs.map((d) => ({
      actor: d.admin || null,
      actorRole: null,
      action: src.prefix ? `${src.prefix}.${d.action}` : d.action,
      module: src.module,
      targetType: d.targetType || src.targetType || null,
      targetId: d.targetId || null,
      before: d.before,
      after: d.after,
      reason: d.reason || '',
      meta: { legacyId: `${src.coll}:${d._id}` },
      ip: null,
      userAgent: null,
      requestId: null,
      source: `backfill:${src.coll}`,
      createdAt: d[src.time] || d.createdAt || d._id.getTimestamp(),
    }));
    report[src.coll] = { found: docs.length, copied: await insertNew(rows, dry) };
    log(`${src.coll}: ${JSON.stringify(report[src.coll])}`);
    if (dropLegacy && !dry) {
      await db.collection(src.coll).drop();
      log(`${src.coll}: dropped`);
    }
  }

  const admins = await db
    .collection('admins')
    .find({ $or: [{ activityLog: { $exists: true } }, { stats: { $exists: true } }] }, { projection: { activityLog: 1, role: 1 } })
    .toArray();
  let activityRows = 0;
  for (const a of admins) {
    const rows = (a.activityLog || []).map((e, i) => ({
      actor: a._id,
      actorRole: a.role || null,
      action: `legacy.${e.action}`,
      module: 'core',
      targetType: e.targetType || null,
      targetId: e.targetId || null,
      reason: e.details || '',
      meta: { legacyId: `admins:${a._id}:${e._id || i}` },
      ip: null,
      userAgent: null,
      requestId: null,
      source: 'backfill:activityLog',
      createdAt: e.timestamp || a._id.getTimestamp(),
    }));
    activityRows += await insertNew(rows, dry);
  }
  if (!dry && admins.length) {
    await db.collection('admins').updateMany({}, { $unset: { activityLog: '', stats: '' } });
  }
  report.activityLog = { admins: admins.length, copied: activityRows };
  log(`activityLog: ${JSON.stringify(report.activityLog)}`);
  return report;
}).catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
