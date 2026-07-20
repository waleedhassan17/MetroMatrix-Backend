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
    if (/insufficient/i.test(e.message)) {
      throw new PaymentError('Insufficient wallet balance');
    }
    throw e;
  }

  booking.payment.status = 'paid';
  booking.payment.method = 'wallet';
  booking.payment.walletTransactionId = result.payerTransaction._id;
  booking.payment.paidAt = new Date();
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
  const amount =
    booking.payment.requestedAmount ||
    booking.pricing.finalPrice ||
    booking.pricing.estimatedPrice;
  const commission = commissionOf(amount, settings.commissionPercent);

  const wallet = await WalletService.getOrCreateWallet(provider._id, 'Provider');
  const relatedTo = { kind: 'Booking', id: booking._id };

  let tx;
  if (wallet.balance >= commission) {
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
};
