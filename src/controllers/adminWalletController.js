const asyncHandler = require('express-async-handler');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const WalletAdjustment = require('../models/WalletAdjustment');
const WalletService = require('../services/walletService');
const User = require('../models/User');
const Provider = require('../models/Provider');
const AppError = require('../utils/AppError');
const { ERROR_CODES } = require('../utils/errorCodes');
const apiResponse = require('../utils/apiResponse');
const { getAdminSettings } = require('../services/settingsCache');
const { audit } = require('../services/auditService');
const { computeReconciliation } = require('../services/walletReconciliation');
const notifications = require('../services/notificationService');
const { clampInt, MAX_PAGE_SIZE } = require('../utils/pagination');


// GET /api/admin/wallets — all wallets: owner type, balance, last activity; searchable, paginated
const listWallets = asyncHandler(async (req, res) => {
  const { ownerType, search, page = 1, limit = 20 } = req.query;
  const pageN = clampInt(page, 1, 1, 1000000);
  const limitN = clampInt(limit, 20, 1, MAX_PAGE_SIZE);

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

  apiResponse.ok(res, items, { page: pageN, limit: limitN, total, pages: Math.max(1, Math.ceil(total / limitN)) });
});

// GET /api/admin/wallets/:id/transactions — full ledger for one wallet
const getWalletTransactions = asyncHandler(async (req, res) => {
  const wallet = await Wallet.findById(req.params.id);
  if (!wallet) throw new AppError(ERROR_CODES.NOT_FOUND, 'Wallet not found');
  const page = clampInt(req.query.page, 1, 1, 1000000);
  const limit = clampInt(req.query.limit, 50, 1, MAX_PAGE_SIZE);

  const [transactions, total] = await Promise.all([
    WalletTransaction.find({ wallet: wallet._id })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    WalletTransaction.countDocuments({ wallet: wallet._id }),
  ]);

  apiResponse.ok(
    res,
    { wallet: { id: String(wallet._id), balance: wallet.balance, currency: wallet.currency }, transactions },
    { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
  );
});

// ---- Manual adjustments (maker-checker) ----

const walletShape = (w) => ({ id: String(w._id), balance: w.balance, currency: w.currency });

/**
 * Apply a claimed adjustment (status already moved to 'applying'). On an
 * insufficient balance the adjustment is marked failed — nothing moved.
 */
async function applyClaimed(req, adjustment, { approvedBy }) {
  try {
    const { wallet, transaction, balanceBefore } = await WalletService.applyAdminAdjustment(adjustment, { approvedBy });
    adjustment.status = 'applied';
    adjustment.transaction = transaction._id;
    adjustment.balanceBefore = balanceBefore;
    adjustment.balanceAfter = wallet.balance;
    await adjustment.save();
    await audit(req, {
      action: 'wallet.adjust.applied',
      module: 'wallet',
      targetType: 'Wallet',
      targetId: adjustment.wallet,
      before: { balance: balanceBefore },
      after: { balance: wallet.balance },
      reason: adjustment.reason,
      meta: {
        adjustmentId: String(adjustment._id),
        direction: adjustment.direction,
        amount: adjustment.amount,
        requestedBy: String(adjustment.requestedBy),
        approvedBy: approvedBy ? String(approvedBy) : null,
      },
    });
    return { wallet, transaction };
  } catch (err) {
    adjustment.status = 'failed';
    adjustment.failureReason = err.message;
    await adjustment.save();
    if (/insufficient/i.test(err.message)) {
      throw new AppError(ERROR_CODES.INSUFFICIENT_BALANCE, 'The wallet balance does not cover this debit.', {
        details: { adjustmentId: String(adjustment._id) },
      });
    }
    throw err;
  }
}

// POST /api/admin/wallets/:id/adjust — manual credit/debit, reason required.
// At or below finance.adjustmentApprovalThreshold it is applied now; above
// it, it waits for a different super admin (202 + the pending adjustment).
const adjustWallet = asyncHandler(async (req, res) => {
  const { type, amount, reason } = req.body;
  const problems = [];
  if (!['credit', 'debit'].includes(type)) problems.push({ field: 'type', message: "type must be 'credit' or 'debit'" });
  const amountN = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(amountN) || amountN <= 0) problems.push({ field: 'amount', message: 'amount must be a positive number' });
  if (!reason || !String(reason).trim()) {
    problems.push({ field: 'reason', message: 'A reason is required for a manual wallet adjustment' });
  }
  if (problems.length) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, problems.map((p) => p.message).join('; '), { details: { fields: problems } });
  }

  const wallet = await Wallet.findById(req.params.id);
  if (!wallet) throw new AppError(ERROR_CODES.NOT_FOUND, 'Wallet not found');

  const threshold = (await getAdminSettings()).finance?.adjustmentApprovalThreshold ?? 10000;
  const requiresApproval = amountN > threshold;
  const adjustment = await WalletAdjustment.create({
    wallet: wallet._id,
    direction: type,
    amount: amountN,
    currency: wallet.currency,
    reason: String(reason).trim(),
    requiresApproval,
    thresholdAtRequest: threshold,
    requestedBy: req.user._id,
    status: requiresApproval ? 'pending' : 'applying',
  });

  if (requiresApproval) {
    await audit(req, {
      action: 'wallet.adjust.requested',
      module: 'wallet',
      targetType: 'Wallet',
      targetId: wallet._id,
      reason: adjustment.reason,
      meta: { adjustmentId: String(adjustment._id), direction: type, amount: amountN, threshold },
    });
    await notifications.notifyAdjustmentPending(adjustment);
    return apiResponse.ok(res, { adjustment: adjustment.toPublic(), requiresApproval: true }, undefined, 202);
  }

  const { wallet: updated, transaction } = await applyClaimed(req, adjustment, { approvedBy: null });
  return apiResponse.ok(res, {
    adjustment: adjustment.toPublic(),
    requiresApproval: false,
    wallet: walletShape(updated),
    transaction,
  });
});

// GET /api/admin/wallets/adjustments?status=pending
const listAdjustments = asyncHandler(async (req, res) => {
  const filter = {};
  if (typeof req.query.status === 'string' && WalletAdjustment.schema.path('status').enumValues.includes(req.query.status)) {
    filter.status = req.query.status;
  }
  const limit = clampInt(req.query.limit, 20, 1, MAX_PAGE_SIZE);
  const page = clampInt(req.query.page, 1, 1, 1000000);
  const [items, total] = await Promise.all([
    WalletAdjustment.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    WalletAdjustment.countDocuments(filter),
  ]);
  return apiResponse.ok(res, items.map((a) => a.toPublic()), { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });
});

// Claim a pending adjustment for a decision. Atomic, so two super admins
// approving at the same moment can't both apply it.
async function claimPending(req, nextStatus) {
  const adjustment = await WalletAdjustment.findById(req.params.adjustmentId);
  if (!adjustment) throw new AppError(ERROR_CODES.NOT_FOUND, 'Adjustment not found');
  if (String(adjustment.requestedBy) === String(req.user._id)) {
    throw new AppError(ERROR_CODES.SECOND_APPROVER_REQUIRED, 'A different super admin has to decide on an adjustment you requested.');
  }
  const claimed = await WalletAdjustment.findOneAndUpdate(
    { _id: adjustment._id, status: 'pending' },
    { $set: { status: nextStatus, decidedBy: req.user._id, decidedAt: new Date(), decisionNote: String(req.body.note || '').slice(0, 500) } },
    { new: true }
  );
  if (!claimed) throw new AppError(ERROR_CODES.CONFLICT, `This adjustment is already ${adjustment.status}.`);
  return claimed;
}

// POST /api/admin/wallets/adjustments/:adjustmentId/approve
const approveAdjustment = asyncHandler(async (req, res) => {
  const adjustment = await claimPending(req, 'applying');
  const { wallet, transaction } = await applyClaimed(req, adjustment, { approvedBy: req.user._id });
  return apiResponse.ok(res, { adjustment: adjustment.toPublic(), wallet: walletShape(wallet), transaction });
});

// POST /api/admin/wallets/adjustments/:adjustmentId/reject
const rejectAdjustment = asyncHandler(async (req, res) => {
  const adjustment = await claimPending(req, 'rejected');
  await audit(req, {
    action: 'wallet.adjust.rejected',
    module: 'wallet',
    targetType: 'Wallet',
    targetId: adjustment.wallet,
    reason: adjustment.decisionNote || '',
    meta: { adjustmentId: String(adjustment._id), direction: adjustment.direction, amount: adjustment.amount },
  });
  return apiResponse.ok(res, { adjustment: adjustment.toPublic() });
});

// GET /api/admin/wallets/reconciliation
// total user balances + total provider balances + platform commission
// must equal total topped up minus total paid out.
const reconciliation = asyncHandler(async (req, res) => {
  const result = await computeReconciliation();
  if (!result.balanced) await notifications.notifyReconciliationDrift(result);
  apiResponse.ok(res, result);
});

module.exports = {
  listWallets,
  getWalletTransactions,
  adjustWallet,
  listAdjustments,
  approveAdjustment,
  rejectAdjustment,
  reconciliation,
};
