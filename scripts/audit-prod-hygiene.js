/**
 * Production data hygiene — find what the seed and QA scripts may have left in
 * a real database (release checklist §5).
 *
 * READ-ONLY by default. Reports:
 *   - accounts on the seed/QA domains (@metromatrix.pk, @mmlocal.dev,
 *     @example.com) — User, Provider, Admin;
 *   - admins and seeded accounts whose password is one of the demo passwords
 *     that were committed to this public repository.
 *
 * With --apply:
 *   - seeded users/providers are soft-deleted through the same guarded path as
 *     the admin console (refused while they have open work or money);
 *   - admins with a known password are deactivated and signed out everywhere.
 *   Every change is written to the admin audit trail.
 *
 * Run: node scripts/audit-prod-hygiene.js --confirm-db=<db name> [--apply]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { parseTarget, describeUri } = require('./lib/seedSafety');
const User = require('../src/models/User');
const Provider = require('../src/models/Provider');
const Admin = require('../src/models/Admin');
const { softDeleteAccount } = require('../src/services/admin/accountDeletion');
const sessions = require('../src/services/admin/sessionService');
const { audit } = require('../src/services/auditService');

// Demo/test domains used by the seed and QA scripts.
const SEED_DOMAINS = /@(metromatrix\.pk|mmlocal\.dev|example\.com)$/i;
// Passwords that were committed to this repo at some point (they are public).
const KNOWN_PASSWORDS = ['123456', 'password123', 'Provider@123', 'Doctor@123', 'Shopper@123', 'Vendor@123', 'Moderator@123456', 'secret123'];

async function knownPassword(doc) {
  for (const candidate of KNOWN_PASSWORDS) {
    if (await doc.matchPassword(candidate)) return true;
  }
  return false;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const target = parseTarget(process.env.MONGODB_URI);
  if (!target) throw new Error('MONGODB_URI is missing or not a MongoDB URI');
  if ((argv.find((a) => a.startsWith('--confirm-db=')) || '').slice(13) !== target.dbName) {
    console.error(`\n✋ Re-run with --confirm-db=${target.dbName} to inspect ${describeUri(process.env.MONGODB_URI)}.\n`);
    process.exit(1);
  }
  console.log(`Inspecting ${describeUri(process.env.MONGODB_URI)}${apply ? ' (APPLY — changes will be made)' : ' (read-only)'}`);
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

  const report = { seededUsers: [], seededProviders: [], weakAdmins: [], deleted: [], blocked: [], deactivatedAdmins: [] };
  const script = { _id: null, role: 'script' };

  for (const [kind, Model, list] of [['User', User, report.seededUsers], ['Provider', Provider, report.seededProviders]]) {
    const docs = await Model.find({ email: SEED_DOMAINS }).select('+password');
    for (const doc of docs) {
      list.push({ email: doc.email, knownPassword: await knownPassword(doc) });
      if (!apply) continue;
      try {
        await softDeleteAccount(kind, doc, { admin: { _id: null }, reason: 'Seed/QA account removed from production (audit-prod-hygiene)' });
        await audit(null, { action: `${kind.toLowerCase()}.delete`, actor: script, targetType: kind, targetId: doc._id, reason: 'audit-prod-hygiene' });
        report.deleted.push(doc.email);
      } catch (err) {
        report.blocked.push({ email: doc.email, why: err.message });
      }
    }
  }

  const admins = await Admin.find({}).select('+password');
  for (const admin of admins) {
    const seeded = SEED_DOMAINS.test(admin.email);
    const weak = await knownPassword(admin);
    if (!weak && !seeded) continue;
    report.weakAdmins.push({ email: admin.email, role: admin.role, knownPassword: weak, seededDomain: seeded, active: admin.isActive });
    if (apply && weak && admin.isActive) {
      await Admin.updateOne({ _id: admin._id }, { $set: { isActive: false } });
      await sessions.revokeAll(admin._id, 'deactivated');
      await audit(null, { action: 'admin.update', actor: script, module: 'admins', targetType: 'Admin', targetId: admin._id, before: { isActive: true }, after: { isActive: false }, reason: 'Known (public) password — audit-prod-hygiene' });
      report.deactivatedAdmins.push(admin.email);
    }
  }

  console.log(JSON.stringify(report, null, 2));
  const findings = report.seededUsers.length + report.seededProviders.length + report.weakAdmins.length;
  console.log(findings ? `\n${findings} finding(s).${apply ? '' : ' Re-run with --apply to clean up.'}` : '\nNo seed accounts or known passwords found.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Hygiene audit failed:', err.message);
  process.exit(1);
});
