/**
 * Home-services payment (FR-11).
 *
 * Money movement rides the ONE cross-module ledger primitive,
 * WalletService.settle() (src/services/walletService.js Part C.3):
 *  - wallet method: settle() customer→provider in one atomic call, with
 *    idempotencyKey `hspay-<bookingId>` (double payment structurally
 *    impossible). The provider receives the full amount.
 *  - cash method: no wallet movement at all; the provider confirms the cash
 *    they were handed and the booking is marked paid.
 *
 * There is no platform commission (removed Oct 2026). Cash jobs used to leave
 * a commission debit on the provider's wallet; any still pending are waived by
 * scripts/migrations/06-remove-commission.js, and pendingCommission() below
 * only reports what that migration has not yet waived.
 */
const WalletService = require('../../../services/walletService');
const WalletTransaction = require('../../../models/WalletTransaction');
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
 * cash settled the job twice (and, while there was a commission, debited the
 * provider a second time). The claim is a conditional update — only one caller
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

  return { transaction: result.payerTransaction };
}

/**
 * Provider confirms the cash they were paid. Nothing moves in the ledger: the
 * customer paid the provider in person and the platform takes no share.
 */
async function confirmCash(booking) {
  assertPayable(booking);
  const amount = billOf(booking);
  await claimSettlement(booking);

  try {
    booking.payment.status = 'paid';
    booking.payment.method = 'cash';
    booking.payment.walletTransactionId = null;
    booking.payment.paidAt = new Date();
    booking.payment.settlingSince = null;
    if (!booking.pricing.finalPrice) booking.pricing.finalPrice = amount;
    await booking.save();
    return { transaction: { _id: `CASH-${booking._id}` } };
  } catch (e) {
    await releaseSettlement(booking);
    throw e;
  }
}

/**
 * Cash commissions recorded before commission was removed and not yet waived
 * by migration 06 — still subtracted from the available payout balance so the
 * figure matches what requestPayout() enforces. 0 once the migration has run.
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
  payWithWallet,
  confirmCash,
  pendingCommission,
  claimSettlement,
  releaseSettlement,
  CLAIM_TTL_MS,
};
