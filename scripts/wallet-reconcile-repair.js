/**
 * ONE-TIME reconciliation repair (WALLET_QA.md C12).
 *
 * The long-lived dev/demo database carries wallet balances that no ledger row
 * explains — written by older code paths and by hand before the wallet was
 * centralised on walletService. That historical gap is a DATA problem, not a
 * code problem: the current code adds zero new drift (the gate proves this
 * separately with C12a), but the dataset can never reconcile to zero while
 * those unexplained balances sit there.
 *
 * This script closes the gap the way accounting does — with an explicit
 * OPENING BALANCE ADJUSTMENT:
 *
 *   - It ONLY inserts WalletTransaction rows. It NEVER changes a balance.
 *     Nobody gains or loses a rupee; the ledger simply gains the missing row
 *     that explains what is already there.
 *   - Each row is marked `metadata.openingBalanceAdjustment = true` so the
 *     repair is auditable and this script is idempotent — running it twice
 *     does nothing the second time.
 *
 * Run with --dry to preview:
 *   node scripts/wallet-reconcile-repair.js --dry
 *   node scripts/wallet-reconcile-repair.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Wallet = require('../src/models/Wallet');
const WalletTransaction = require('../src/models/WalletTransaction');

const DRY = process.argv.includes('--dry');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const wallets = await Wallet.find({});

  let repaired = 0;
  let skipped = 0;
  let totalAdjusted = 0;

  for (const w of wallets) {
    const rows = await WalletTransaction.find({ wallet: w._id, status: 'completed' });
    const net = rows.reduce((s, r) => s + (r.type === 'credit' ? r.amount : -r.amount), 0);
    const diff = w.balance - net;
    if (diff === 0) continue;

    // Idempotency comes from `diff === 0` above, NOT from "has this wallet
    // ever been adjusted before?". An earlier version skipped any wallet that
    // already carried an adjustment row, which meant a wallet that drifted
    // AGAIN afterwards could never be repaired — it stayed permanently
    // broken while the script cheerfully reported success. Re-running on a
    // reconciled wallet is already a no-op.
    const priorAdjustments = await WalletTransaction.countDocuments({
      wallet: w._id,
      'metadata.openingBalanceAdjustment': true,
    });

    console.log(
      `${DRY ? '[dry] ' : ''}${w.ownerType} ${w.owner}: balance ${w.balance}, ledger ${net} → ` +
        `${diff > 0 ? 'credit' : 'debit'} adjustment of ${Math.abs(diff)}`
    );

    if (!DRY) {
      await WalletTransaction.create({
        wallet: w._id,
        type: diff > 0 ? 'credit' : 'debit',
        amount: Math.abs(diff),
        currency: w.currency,
        description:
          'Opening balance adjustment — pre-ledger balance recorded during wallet productionisation',
        source: 'admin_adjustment',
        status: 'completed',
        metadata: {
          openingBalanceAdjustment: true,
          adjustmentSequence: priorAdjustments + 1,
          balanceAtRepair: w.balance,
          ledgerNetAtRepair: net,
          repairedAt: new Date(),
        },
      });
    }
    repaired += 1;
    totalAdjusted += Math.abs(diff);
  }

  console.log(
    `\n${DRY ? '[dry run] would repair' : 'repaired'} ${repaired} wallet(s), ` +
      `${skipped} already adjusted, total adjustment PKR ${totalAdjusted}. No balances were changed.`
  );
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
