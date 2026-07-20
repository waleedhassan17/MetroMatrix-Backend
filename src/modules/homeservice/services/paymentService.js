/**
 * Home-services payment (FR-11).
 *
 * Money movement rides the EXISTING wallet rails (src/services/walletService):
 *  - wallet method: WalletService.transferFunds customer→provider with
 *    feePercent = platform commission and idempotencyKey `hspay-<bookingId>`,
 *    which makes double payment structurally impossible (idempotent) and
 *    atomic where the Atlas tier supports sessions (transferFunds already
 *    falls back to sequential ops with the same invariants otherwise).
 *  - cash method: no customer wallet movement; the provider confirms receipt
 *    and the platform commission is debited from the provider's wallet so
 *    platform accounting stays correct on both paths. If the provider wallet
 *    cannot cover it, the commission is recorded as a PENDING debit that
 *    payouts subtract before approving (compensating design — free Atlas
 *    tier has no cross-collection transactions for this path).
 */
const WalletService = require('../../../services/walletService');
const WalletTransaction = require('../../../models/WalletTransaction');
const { getHomeserviceSettings } = require('./settingsService');
const { STATUS } = require('./statusMap');

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
 * Customer pays from wallet. Returns the customer-side WalletTransaction.
 */
async function payWithWallet(booking, customer, amount) {
  assertPayable(booking);
  const settings = await getHomeserviceSettings();

  let result;
  try {
    result = await WalletService.transferFunds({
      senderOwnerId: customer._id,
      senderOwnerType: 'User',
      receiverOwnerId: booking.provider._id || booking.provider,
      receiverOwnerType: 'Provider',
      amount,
      description: `Home service payment — booking ${booking._id}`,
      idempotencyKey: `hspay-${booking._id}`,
      feePercent: settings.commissionPercent,
    });
  } catch (e) {
    if (/insufficient/i.test(e.message)) {
      throw new PaymentError('Insufficient wallet balance');
    }
    throw e;
  }

  booking.payment.status = 'paid';
  booking.payment.method = 'wallet';
  booking.payment.walletTransactionId = result.senderTransaction._id;
  booking.payment.paidAt = new Date();
  if (!booking.pricing.finalPrice) booking.pricing.finalPrice = amount;
  await booking.save();

  return {
    transaction: result.senderTransaction,
    commission: commissionOf(amount, settings.commissionPercent),
  };
}

/**
 * Provider confirms cash received. Commission is deducted from the provider
 * wallet (or recorded pending when the balance cannot cover it).
 */
async function confirmCash(booking, provider) {
  assertPayable(booking);
  const settings = await getHomeserviceSettings();
  const amount =
    booking.payment.requestedAmount ||
    booking.pricing.finalPrice ||
    booking.pricing.estimatedPrice;
  const commission = commissionOf(amount, settings.commissionPercent);

  const wallet = await WalletService.getOrCreateWallet(provider._id, 'Provider');

  let commissionStatus = 'completed';
  if (wallet.balance >= commission) {
    await wallet.debit(commission);
  } else {
    commissionStatus = 'pending'; // settled against the next payout
  }

  const tx = await WalletService.recordTransaction(wallet._id, {
    type: 'debit',
    amount: commission,
    description: `Platform commission (cash) — booking ${booking._id}`,
    source: 'service_payment',
    status: commissionStatus,
    metadata: { bookingId: String(booking._id), method: 'cash', grossAmount: amount },
  });

  booking.payment.status = 'paid';
  booking.payment.method = 'cash';
  booking.payment.walletTransactionId = tx._id;
  booking.payment.paidAt = new Date();
  if (!booking.pricing.finalPrice) booking.pricing.finalPrice = amount;
  await booking.save();

  return { transaction: tx, commission };
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
        source: 'service_payment',
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
};
