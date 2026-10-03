const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');

/**
 * Does the ledger add up?
 *
 *   sum of every wallet's balance  ==  total topped up − total paid out ± admin adjustments
 *
 * Transfers between wallets (P2P, settle/settlePayout, commission) move
 * balance without creating or destroying money, so they net to zero and are
 * not in the formula. `drift` is the difference, rounded to the paisa.
 *
 * Used by GET /api/admin/wallets/reconciliation and by the overview/queue
 * (a non-zero drift is something an admin must look at).
 */
async function computeReconciliation() {
  const [byOwnerType, topupAgg, payoutAgg, adjustAgg] = await Promise.all([
    Wallet.aggregate([{ $group: { _id: '$ownerType', total: { $sum: '$balance' } } }]),
    WalletTransaction.aggregate([
      { $match: { source: 'stripe_topup', status: 'completed', type: 'credit' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    WalletTransaction.aggregate([
      { $match: { source: 'payout', status: 'completed', type: 'debit' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    WalletTransaction.aggregate([
      { $match: { source: 'admin_adjustment', status: 'completed' } },
      {
        $group: {
          _id: null,
          credits: { $sum: { $cond: [{ $eq: ['$type', 'credit'] }, '$amount', 0] } },
          debits: { $sum: { $cond: [{ $eq: ['$type', 'debit'] }, '$amount', 0] } },
        },
      },
    ]),
  ]);

  const totals = { User: 0, Provider: 0, Platform: 0 };
  byOwnerType.forEach((row) => {
    totals[row._id] = row.total;
  });
  const totalToppedUp = topupAgg[0]?.total || 0;
  const totalPaidOut = payoutAgg[0]?.total || 0;
  const netAdjustments = adjustAgg[0] ? adjustAgg[0].credits - adjustAgg[0].debits : 0;
  const sumOfAllWallets = totals.User + totals.Provider + totals.Platform;
  const expected = totalToppedUp - totalPaidOut + netAdjustments;
  const drift = Math.round((sumOfAllWallets - expected) * 100) / 100;

  return {
    totalUserBalance: totals.User,
    totalProviderBalance: totals.Provider,
    platformCommissionBalance: totals.Platform,
    sumOfAllWallets,
    totalToppedUp,
    totalPaidOut,
    netAdjustments,
    expected,
    drift,
    balanced: Math.abs(drift) < 0.01,
    computedAt: new Date().toISOString(),
  };
}

module.exports = { computeReconciliation };
