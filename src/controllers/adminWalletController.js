const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const WalletAuditLog = require('../models/WalletAuditLog');
const WalletService = require('../services/walletService');
const User = require('../models/User');
const Provider = require('../models/Provider');

const ok = (res, data, message, pagination) =>
  res.json({ success: true, data, message, ...(pagination ? { pagination } : {}) });

async function audit(adminId, action, targetId, before, after, reason) {
  await WalletAuditLog.create({ admin: adminId, action, targetId, before, after, reason });
}

// GET /api/admin/wallets — all wallets: owner type, balance, last activity; searchable, paginated
const listWallets = asyncHandler(async (req, res) => {
  const { ownerType, search, page = 1, limit = 20 } = req.query;
  const pageN = parseInt(page, 10) || 1;
  const limitN = parseInt(limit, 10) || 20;

  const query = {};
  if (ownerType && ['User', 'Provider', 'Platform'].includes(ownerType)) query.ownerType = ownerType;

  let ownerIds = null;
  if (search) {
    const [users, providers] = await Promise.all([
      User.find({
        $or: [
          { fullName: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
        ],
      }).select('_id'),
      Provider.find({
        $or: [
          { fullName: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
        ],
      }).select('_id'),
    ]);
    ownerIds = [...users.map((u) => u._id), ...providers.map((p) => p._id)];
    query.owner = { $in: ownerIds };
  }

  const [wallets, total] = await Promise.all([
    Wallet.find(query)
      .sort({ updatedAt: -1 })
      .skip((pageN - 1) * limitN)
      .limit(limitN),
    Wallet.countDocuments(query),
  ]);

  // Resolve owner display name per wallet (owner may be User, Provider, or
  // the sentinel Platform id with no backing document).
  const items = await Promise.all(
    wallets.map(async (w) => {
      let ownerName = 'Platform (commission ledger)';
      let ownerEmail = null;
      if (w.ownerType === 'User') {
        const u = await User.findById(w.owner).select('fullName email');
        ownerName = u ? u.fullName : 'Unknown user';
        ownerEmail = u ? u.email : null;
      } else if (w.ownerType === 'Provider') {
        const p = await Provider.findById(w.owner).select('fullName email');
        ownerName = p ? p.fullName : 'Unknown provider';
        ownerEmail = p ? p.email : null;
      }
      const lastTxn = await WalletTransaction.findOne({ wallet: w._id }).sort({ createdAt: -1 });
      return {
        id: String(w._id),
        ownerId: String(w.owner),
        ownerType: w.ownerType,
        ownerName,
        ownerEmail,
        balance: w.balance,
        currency: w.currency,
        lastActivityAt: lastTxn ? lastTxn.createdAt.toISOString() : null,
        createdAt: w.createdAt.toISOString(),
      };
    })
  );

  const totalPages = Math.max(1, Math.ceil(total / limitN));
  ok(res, items, 'Wallets fetched', {
    currentPage: pageN,
    totalPages,
    totalItems: total,
    itemsPerPage: limitN,
    hasNext: pageN < totalPages,
    hasPrevious: pageN > 1,
  });
});

// GET /api/admin/wallets/:id/transactions — full ledger for one wallet
const getWalletTransactions = asyncHandler(async (req, res) => {
  const wallet = await Wallet.findById(req.params.id);
  if (!wallet) {
    res.status(404);
    throw new Error('Wallet not found');
  }
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;

  const [transactions, total] = await Promise.all([
    WalletTransaction.find({ wallet: wallet._id })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    WalletTransaction.countDocuments({ wallet: wallet._id }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / limit));
  ok(
    res,
    { wallet: { id: String(wallet._id), balance: wallet.balance, currency: wallet.currency }, transactions },
    'Wallet transactions fetched',
    {
      currentPage: page,
      totalPages,
      totalItems: total,
      itemsPerPage: limit,
      hasNext: page < totalPages,
      hasPrevious: page > 1,
    }
  );
});

// POST /api/admin/wallets/:id/adjust — manual credit/debit, MANDATORY reason
const adjustWallet = asyncHandler(async (req, res) => {
  const { type, amount, reason } = req.body;
  if (!['credit', 'debit'].includes(type)) {
    res.status(400);
    throw new Error("type must be 'credit' or 'debit'");
  }
  const amountN = Number(amount);
  if (!Number.isFinite(amountN) || amountN <= 0) {
    res.status(400);
    throw new Error('amount must be a positive number');
  }
  if (!reason || !String(reason).trim()) {
    res.status(400);
    throw new Error('A reason is required for a manual wallet adjustment');
  }

  const wallet = await Wallet.findById(req.params.id);
  if (!wallet) {
    res.status(404);
    throw new Error('Wallet not found');
  }
  const before = { balance: wallet.balance };

  const updated =
    type === 'credit'
      ? await Wallet.creditAtomic(wallet._id, amountN)
      : await Wallet.debitAtomic(wallet._id, amountN).catch((e) => {
          if (/insufficient/i.test(e.message)) {
            res.status(400);
            throw new Error('Insufficient balance for this debit');
          }
          throw e;
        });

  const txn = await WalletTransaction.create({
    wallet: wallet._id,
    type,
    amount: amountN,
    currency: wallet.currency,
    description: `Admin adjustment: ${reason}`,
    source: 'admin_adjustment',
    status: 'completed',
    metadata: { adminId: String(req.user._id) },
  });

  await audit(
    req.user._id,
    'wallet.adjust',
    wallet._id,
    before,
    { balance: updated.balance },
    reason
  );

  ok(
    res,
    { wallet: { id: String(updated._id), balance: updated.balance, currency: updated.currency }, transaction: txn },
    'Wallet adjusted'
  );
});

// GET /api/admin/wallets/reconciliation
// total user balances + total provider balances + platform commission
// must equal total topped up minus total paid out.
const reconciliation = asyncHandler(async (req, res) => {
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
    // Net admin adjustments (credits - debits) — legitimate manual money
    // creation/destruction outside the topup/payout rails, so it belongs
    // in the reconciliation formula too.
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

  const totalToppedUp = (topupAgg[0] && topupAgg[0].total) || 0;
  const totalPaidOut = (payoutAgg[0] && payoutAgg[0].total) || 0;
  const netAdjustments = adjustAgg[0] ? adjustAgg[0].credits - adjustAgg[0].debits : 0;

  // Money in the system right now = every wallet's balance summed.
  const sumOfAllWallets = totals.User + totals.Provider + totals.Platform;
  // Money that SHOULD be in the system = everything topped up, minus
  // everything paid out to a real bank account, plus/minus manual
  // adjustments. Transfers between wallets (P2P, settle/settlePayout,
  // commission) net to zero across the whole ledger by construction — they
  // move balance between wallets without creating or destroying money — so
  // they do not appear in this formula at all.
  const expected = totalToppedUp - totalPaidOut + netAdjustments;
  const drift = Math.round((sumOfAllWallets - expected) * 100) / 100;

  ok(res, {
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
  }, 'Reconciliation computed');
});

module.exports = { listWallets, getWalletTransactions, adjustWallet, reconciliation };
