/**
 * 06 — remove platform commission (Oct 2026).
 *
 * The platform no longer takes a share of home-service, healthcare or shopping
 * payments. This migration:
 *   - unsets the three stored commissionPercent settings (the code ignores
 *     them already; this keeps the settings document honest);
 *   - waives the cash-job commissions still PENDING on provider wallets. They
 *     were never taken from the balance, but they were subtracted from what a
 *     provider could withdraw. Each becomes status 'failed' with
 *     metadata.waived, and gets one AdminAuditLog row (source 'migration:06').
 *
 * Commission already taken (completed transactions, the Platform wallet's
 * balance, payout.commission on old appointments and orders) is history and is
 * left as it is.
 *
 * Idempotent: only settings that still carry the field and transactions that
 * are still pending are touched. Rollback: the previous release reads a missing
 * commissionPercent as its default of 10%; waived debits can be found by
 * metadata.waived and set back to 'pending'.
 */
const { runMigration } = require('./lib');
const WalletTransaction = require('../../src/models/WalletTransaction');
const AdminAuditLog = require('../../src/models/AdminAuditLog');
const AdminSettings = require('../../src/models/AdminSettings');

const FIELDS = ['shopping.commissionPercent', 'healthcare.commissionPercent', 'homeservice.commissionPercent'];

runMigration('06-remove-commission', async ({ dry, log }) => {
  const settings = AdminSettings.collection;
  const withField = await settings.countDocuments({ $or: FIELDS.map((f) => ({ [f]: { $exists: true } })) });
  if (!dry && withField) {
    await settings.updateMany({}, { $unset: Object.fromEntries(FIELDS.map((f) => [f, ''])) });
  }
  log(`settings documents with a commission: ${withField}`);

  const txs = WalletTransaction.collection;
  const pending = await txs
    .find({ source: 'commission', type: 'debit', status: 'pending' }, { projection: { _id: 1, wallet: 1, amount: 1 } })
    .toArray();
  const total = pending.reduce((s, t) => s + (t.amount || 0), 0);
  if (!dry && pending.length) {
    const now = new Date();
    await txs.bulkWrite(
      pending.map((t) => ({
        updateOne: {
          // Still pending: a second run (or a race with anything else) never
          // waives the same debit twice.
          filter: { _id: t._id, status: 'pending' },
          update: {
            $set: {
              status: 'failed',
              'metadata.waived': true,
              'metadata.waivedAt': now,
              'metadata.waivedReason': 'Platform commission removed',
              updatedAt: now,
            },
          },
        },
      })),
      { ordered: false }
    );
    await AdminAuditLog.collection.insertMany(
      pending.map((t) => ({
        actor: null,
        actorRole: 'system',
        action: 'wallet.commission.waive',
        module: 'wallet',
        targetType: 'WalletTransaction',
        targetId: t._id,
        before: { status: 'pending' },
        after: { status: 'failed', waived: true },
        reason: 'Platform commission removed',
        meta: { wallet: t.wallet, amount: t.amount },
        source: 'migration:06',
        createdAt: now,
      })),
      { ordered: false }
    );
  }
  log(`pending cash commissions waived: ${pending.length} (total ${total})`);
  return { settings: withField, waived: pending.length, waivedTotal: total };
}).catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
