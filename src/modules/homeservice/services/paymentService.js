/**
 * Home-services payment (FR-11).
 *
 * Money movement rides the ONE cross-module ledger primitive,
 * WalletService.settle() (src/services/walletService.js Part C.3):
 *  - wallet method: settle() customer→provider in one atomic call, with
 *    idempotencyKey `hspay-<bookingId>` (double payment structurally
 *    impossible) and commissionRate from admin settings — the commission
 *    leg lands in the Platform ledger instead of vanishing.
 *  - cash method: no customer wallet movement; the provider confirms receipt
 *    and settlePayout() credits the Platform ledger with the commission by
 *    debiting the provider (net was already collected as cash in person).
 *    If the provider wallet cannot cover it, the commission is recorded as a
 *    PENDING debit that payouts subtract before approving (compensating
 *    design — free Atlas tier has no cross-collection transactions here).
 */
const WalletService = require('../../../services/walletService');
const WalletTransaction = require('../../../models/WalletTransaction');
const { getHomeserviceSettings } = require('./settingsService');
const { STATUS } = require('./statusMap');
const { billOf } = require('./money');

class PaymentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function assertPayable(booking) {
  if (booking.status !== STATUS.COMPLETED) {
    throw new PaymentError('Payment is only allowed after the job is completed');
  }
  if (booking.payment.status === 'paid') {
    throw new PaymentError('This booking has already been paid');
  }
}

function commissionOf(amount, commissionPercent) {
  return Math.round(((amount * commissionPercent) / 100) * 100) / 100;
}

/**
 * A settlement in flight holds this claim. Stale after a minute, so a request
 * that died mid-way cannot lock a booking forever; the ledger calls below are
 * idempotent per booking, so a retry after that cannot move money twice.
 */
const CLAIM_TTL_MS = 60 * 1000;

/**
 * Atomically take the right to settle this booking.
 *
 * Wallet payment (customer) and cash confirmation (provider) are two doors
 * into the same room. Each checked "not paid yet" and then moved money, so a
 * customer paying from the wallet in the same second the provider confirmed
 * cash settled the job twice: the customer charged, and the provider debited
 * a second commission. The claim is a conditional update — only one caller
 * can flip it — taken BEFORE any money moves.
 */
async function claimSettlement(booking) {
  const Booking = require('../models/Booking');
  const now = new Date();
  const claimed = await Booking.updateOne(
    {
      _id: booking._id,
      'payment.status': { $ne: 'paid' },
      $or: [
        { 'payment.settlingSince': null },
        { 'payment.settlingSince': { $lt: new Date(now.getTime() - CLAIM_TTL_MS) } },
      ],
    },
    { $set: { 'payment.settlingSince': now } }
  );
  if (!claimed.matchedCount) {
    const fresh = await Booking.findById(booking._id).select('payment.status').lean();
    if (fresh && fresh.payment && fresh.payment.status === 'paid') {
      throw new PaymentError('This booking has already been paid', 409);
    }
    throw new PaymentError('A payment for this booking is already being processed', 409);
  }
}

async function releaseSettlement(booking) {
  const Booking = require('../models/Booking');
  try {
    await Booking.updateOne({ _id: booking._id }, { $set: { 'payment.settlingSince': null } });
  } catch (e) {
    console.error(`[payment] releasing claim failed booking=${booking._id}: ${e.message}`);
  }
}

/**
 * Customer pays from wallet. Returns the customer-side WalletTransaction.
 */
async function payWithWallet(booking, customer, amount) {
  assertPayable(booking);
  const settings = await getHomeserviceSettings();
  await claimSettlement(booking);

  let result;
  try {
    result = await WalletService.settle({
      payerType: 'User',
      payerId: customer._id,
      payeeType: 'Provider',
      payeeId: booking.provider._id || booking.provider,
      amount,
      source: 'homeservice_payment',
      relatedTo: { kind: 'Booking', id: booking._id },
      description: `Home service payment — booking ${booking._id}`,
      idempotencyKey: `hspay-${booking._id}`,
      commissionRate: settings.commissionPercent,
    });
  } catch (e) {
    await releaseSettlement(booking);
    if (/insufficient/i.test(e.message)) {
      throw new PaymentError('Insufficient wallet balance');
    }
    throw e;
  }

  booking.payment.status = 'paid';
  booking.payment.method = 'wallet';
  booking.payment.walletTransactionId = result.payerTransaction._id;
  booking.payment.paidAt = new Date();
  booking.payment.settlingSince = null;
  if (!booking.pricing.finalPrice) booking.pricing.finalPrice = amount;
  await booking.save();

  return {
    transaction: result.payerTransaction,
    commission: result.commission,
  };
}

/**
 * Provider confirms cash received. Commission is deducted from the provider
 * wallet (or recorded pending when the balance cannot cover it).
 */
async function confirmCash(booking, provider) {
  assertPayable(booking);
  const settings = await getHomeserviceSettings();
  const amount = billOf(booking);
  const commission = commissionOf(amount, settings.commissionPercent);
  await claimSettlement(booking);

  try {
    return await settleCash(booking, provider, amount, commission);
  } catch (e) {
    await releaseSettlement(booking);
    throw e;
  }
}

async function settleCash(booking, provider, amount, commission) {
  const wallet = await WalletService.getOrCreateWallet(provider._id, 'Provider');
  const relatedTo = { kind: 'Booking', id: booking._id };

  let tx = null;
  if (commission <= 0) {
    // A zero-commission configuration has nothing to move; the cash itself
    // changed hands in person.
  } else if (wallet.balance >= commission) {
    // Debit the provider AND credit the Platform ledger in one call — the
    // commission has a real destination instead of just vanishing off the
    // provider's balance (the bug this module was built to avoid). settle()
    // creates its own linked transaction docs; use its payer-side one.
    const result = await WalletService.settle({
      payerType: 'Provider',
      payerId: provider._id,
      payeeType: 'Platform',
      payeeId: WalletService.PLATFORM_OWNER_ID,
      amount: commission,
      source: 'commission',
      relatedTo,
      description: `Platform commission (cash) — booking ${booking._id}`,
      // One commission per booking, however many times confirm is retried.
      idempotencyKey: `hscash-${booking._id}`,
      commissionRate: 0,
    });
    tx = result.payerTransaction;
  } else {
    // Provider can't cover it yet — record a PENDING debit (no wallet
    // mutation) that payouts subtract before approving (see settlePayout
    // caller in earningsController). Not routed through settle() because
    // settle() is all-or-nothing; this business rule needs the partial state.
    tx = await WalletService.recordTransaction(wallet._id, {
      type: 'debit',
      amount: commission,
      description: `Platform commission (cash) — booking ${booking._id}`,
      source: 'commission',
      status: 'pending',
      relatedTo,
      metadata: { bookingId: String(booking._id), method: 'cash', grossAmount: amount },
    });
  }

  booking.payment.status = 'paid';
  booking.payment.method = 'cash';
  booking.payment.walletTransactionId = tx ? tx._id : null;
  booking.payment.paidAt = new Date();
  booking.payment.settlingSince = null;
  if (!booking.pricing.finalPrice) booking.pricing.finalPrice = amount;
  await booking.save();

  return { transaction: tx || { _id: `CASH-${booking._id}` }, commission };
}

/**
 * Provider's pending (unsettled) cash commissions — subtracted from the
 * available payout balance.
 */
async function pendingCommission(providerId) {
  const wallet = await WalletService.getOrCreateWallet(providerId, 'Provider');
  const pending = await WalletTransaction.aggregate([
    {
      $match: {
        wallet: wallet._id,
        source: 'commission',
        type: 'debit',
        status: 'pending',
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return (pending[0] && pending[0].total) || 0;
}

module.exports = {
  PaymentError,
  assertPayable,
  commissionOf,
  payWithWallet,
  confirmCash,
  pendingCommission,
  claimSettlement,
  releaseSettlement,
  CLAIM_TTL_MS,
};
