/**
 * 08 — take back the rupee a top-up's currency round trip added (Nov 2026).
 *
 * Top-ups are charged in USD cents and used to be credited by converting the
 * charged cents back to PKR. One cent is PKR 2.80, so the round trip is off by
 * up to a rupee either way: PKR 5,000 was charged as 1,786 cents and credited
 * as PKR 5,001, while the history row (created when checkout opened) said
 * 5,000. A customer who topped up 5,000 and paid 2,500 twice was left holding
 * PKR 1 that nothing in their history explained. walletService.applyTopUp now
 * credits the amount the customer asked for; this repairs wallets credited
 * before that.
 *
 * For each completed Stripe top-up, the PKR actually credited is its charged
 * cents at its own fxRate, rounded. Where that differs from the amount on the
 * row, the wallet's balance is moved by the difference, so it equals what the
 * history adds up to, and the row is stamped metadata.fxDriftCorrected (the
 * PKR taken back; negative means given back). One AdminAuditLog row per wallet
 * (source 'migration:08').
 *
 * A wallet is only touched when its whole unexplained balance (balance minus
 * its completed ledger, minus payouts still in flight) is exactly the top-up
 * drift — anything else means something more is going on, and it is listed
 * for a person instead. The balance update is conditional on the balance read,
 * so a payment landing mid-run makes that wallet skip, not miscount.
 *
 * Idempotent: stamped rows are never looked at again. Rollback: for each
 * stamped row, $inc its wallet's balance by metadata.fxDriftCorrected and
 * unset the stamp (the audit rows list every wallet and amount).
 */
const { runMigration } = require('./lib');
const Wallet = require('../../src/models/Wallet');
const WalletTransaction = require('../../src/models/WalletTransaction');
const AdminAuditLog = require('../../src/models/AdminAuditLog');
const { PKR_PER_USD } = require('../../src/config/currency');

const round2 = (n) => Math.round(n * 100) / 100;

/** PKR the old applyTopUp credited for this row: its cents at its own rate. */
function creditedPkr(row) {
  const cents = Number(row.metadata && row.metadata.originalAmountUsdCents);
  const rate = Number(row.metadata && row.metadata.fxRate) || PKR_PER_USD;
  return Math.round((cents / 100) * rate);
}

/** What the wallet's ledger says its balance should be. */
async function ledgerNet(walletId) {
  const [agg] = await WalletTransaction.collection
    .aggregate([
      { $match: { wallet: walletId } },
      {
        $group: {
          _id: null,
          credits: { $sum: { $cond: [{ $and: [{ $eq: ['$type', 'credit'] }, { $eq: ['$status', 'completed'] }] }, '$amount', 0] } },
          debits: { $sum: { $cond: [{ $and: [{ $eq: ['$type', 'debit'] }, { $eq: ['$status', 'completed'] }] }, '$amount', 0] } },
          // A payout reserves the money when it is requested and stays
          // 'pending' until the bank transfer lands.
          payoutsInFlight: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$source', 'payout'] }, { $eq: ['$type', 'debit'] }, { $eq: ['$status', 'pending'] }] },
                '$amount',
                0,
              ],
            },
          },
        },
      },
    ])
    .toArray();
  return agg ? round2(agg.credits - agg.debits - agg.payoutsInFlight) : 0;
}

runMigration('08-topup-fx-drift', async ({ dry, log }) => {
  const rows = await WalletTransaction.collection
    .find(
      {
        source: 'stripe_topup',
        type: 'credit',
        status: 'completed',
        'metadata.originalAmountUsdCents': { $type: 'number' },
        'metadata.fxDriftCorrected': { $exists: false },
      },
      { projection: { _id: 1, wallet: 1, amount: 1, metadata: 1 } }
    )
    .toArray();

  const byWallet = new Map();
  for (const row of rows) {
    const drift = round2(creditedPkr(row) - row.amount);
    if (!drift) continue;
    const key = String(row.wallet);
    if (!byWallet.has(key)) byWallet.set(key, { walletId: row.wallet, rows: [] });
    byWallet.get(key).rows.push({ _id: row._id, drift });
  }

  let corrected = 0;
  let netTakenBack = 0;
  const skipped = [];
  const now = new Date();

  for (const { walletId, rows: drifted } of byWallet.values()) {
    const drift = round2(drifted.reduce((s, r) => s + r.drift, 0));
    const wallet = await Wallet.collection.findOne({ _id: walletId }, { projection: { balance: 1, owner: 1, ownerType: 1 } });
    if (!wallet) {
      skipped.push({ wallet: String(walletId), reason: 'wallet not found' });
      continue;
    }
    const unexplained = round2(wallet.balance - (await ledgerNet(walletId)));
    const label = `${wallet.ownerType} ${wallet.owner}: balance ${wallet.balance}, top-up drift ${drift}, unexplained ${unexplained}`;
    if (unexplained !== drift) {
      skipped.push({ wallet: String(walletId), reason: 'unexplained balance is not just top-up drift', balance: wallet.balance, drift, unexplained });
      log(`skip  ${label} — needs a person`);
      continue;
    }
    if (drift === 0) continue; // drifts in both directions cancelled out; nothing to move
    log(`${dry ? 'would fix' : 'fix  '} ${label} → balance ${round2(wallet.balance - drift)}`);
    if (dry) {
      corrected += 1;
      netTakenBack = round2(netTakenBack + drift);
      continue;
    }

    // Only if the balance is still what was read: a payment landing between
    // the read and here makes this wallet skip rather than miscount.
    const res = await Wallet.collection.updateOne(
      { _id: walletId, balance: wallet.balance },
      { $inc: { balance: -drift }, $set: { updatedAt: now } }
    );
    if (!res.modifiedCount) {
      skipped.push({ wallet: String(walletId), reason: 'balance changed during the run — re-run to retry' });
      log(`skip  ${label} — balance changed during the run`);
      continue;
    }
    await WalletTransaction.collection.bulkWrite(
      drifted.map((r) => ({
        updateOne: {
          filter: { _id: r._id, 'metadata.fxDriftCorrected': { $exists: false } },
          update: { $set: { 'metadata.fxDriftCorrected': r.drift, 'metadata.fxDriftCorrectedAt': now } },
        },
      })),
      { ordered: false }
    );
    await AdminAuditLog.collection.insertOne({
      actor: null,
      actorRole: 'system',
      action: 'wallet.topup.fx_drift_correct',
      module: 'wallet',
      targetType: 'Wallet',
      targetId: walletId,
      before: { balance: wallet.balance },
      after: { balance: round2(wallet.balance - drift) },
      reason: 'Top-up credited the USD cents converted back to PKR instead of the PKR asked for',
      meta: { transactions: drifted.map((r) => ({ id: r._id, drift: r.drift })) },
      source: 'migration:08',
      createdAt: now,
    });
    corrected += 1;
    netTakenBack = round2(netTakenBack + drift);
  }

  log(`top-ups checked: ${rows.length}; wallets ${dry ? 'to fix' : 'fixed'}: ${corrected}; skipped: ${skipped.length}`);
  return { checked: rows.length, corrected, netTakenBack, skipped };
}).catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
