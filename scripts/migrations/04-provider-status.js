/**
 * 04 — provider state model (phase B3).
 *
 * The admin console now reads `verificationStatus` (pending/approved/rejected)
 * + `isSuspended` instead of inferring everything from adminVerified, where
 * 'inactive' meant both "rejected" and "approved, then deactivated". This
 * fills the new fields from what each provider's record says happened:
 *
 *   adminVerified 'active'                       → approved (suspended if isActive is false)
 *   adminVerified 'inactive' + rejection evidence → rejected
 *   adminVerified 'inactive' + approvedAt, no rejection → approved + suspended
 *   adminVerified 'inactive', no evidence either way → rejected
 *   otherwise                                    → pending
 *
 * adminVerified and isActive are not changed (login keeps working exactly as
 * before). Idempotent. Rollback: nothing reads isSuspended in the previous release.
 */
const { runMigration } = require('./lib');
const Provider = require('../../src/models/Provider');

function target(p) {
  const rejected = p.status === 'rejected' || !!p.rejectionReason || !!p.rejectedAt;
  if (p.adminVerified === 'active') return { verificationStatus: 'approved', isSuspended: p.isActive === false };
  if (p.adminVerified === 'inactive') {
    if (rejected) return { verificationStatus: 'rejected', isSuspended: false };
    if (p.approvedAt) return { verificationStatus: 'approved', isSuspended: true };
    return { verificationStatus: 'rejected', isSuspended: false };
  }
  return { verificationStatus: 'pending', isSuspended: false };
}

runMigration('04-provider-status', async ({ dry, log }) => {
  const coll = Provider.collection;
  const cursor = coll.find({}, {
    projection: { email: 1, adminVerified: 1, isActive: 1, status: 1, rejectionReason: 1, rejectedAt: 1, approvedAt: 1, verificationStatus: 1, isSuspended: 1 },
  });
  const tally = { pending: 0, approved: 0, rejected: 0, suspended: 0, changed: 0 };
  const ops = [];
  for await (const p of cursor) {
    const t = target(p);
    tally[t.isSuspended ? 'suspended' : t.verificationStatus] += 1;
    if (p.verificationStatus !== t.verificationStatus || (p.isSuspended === true) !== t.isSuspended) {
      tally.changed += 1;
      const set = { verificationStatus: t.verificationStatus, isSuspended: t.isSuspended };
      if (t.isSuspended && !p.isSuspended) set.suspendedReason = 'Deactivated before the suspension state existed';
      ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: set } } });
    }
  }
  if (!dry && ops.length) await coll.bulkWrite(ops, { ordered: false });
  log(JSON.stringify(tally));
  return tally;
}).catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
