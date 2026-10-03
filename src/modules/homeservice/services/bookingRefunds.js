const Booking = require('../models/Booking');
const WalletTransaction = require('../../../models/WalletTransaction');
const WalletService = require('../../../services/walletService');
const AppError = require('../../../utils/AppError');
const { ERROR_CODES } = require('../../../utils/errorCodes');

/*
 * Refunds on a home-service booking — the admin refund and a dispute refund.
 *
 * Both used to credit the customer with whatever amount was asked (the admin
 * refund defaulting to the full price), with nothing recording that a refund
 * had already gone out: tapping "Refund" twice refunded twice, and a dispute
 * refund on top of an admin refund paid the customer more than they paid.
 *
 * Now the total refunded on a booking can never exceed what the customer paid:
 *  - only a paid booking can be refunded;
 *  - "already refunded" is the larger of the booking's own counter
 *    (payment.refundedAmount) and the completed refunds in the ledger (which
 *    covers refunds issued before the counter existed);
 *  - before any money moves, the counter is advanced with a conditional
 *    update that only matches the value this request read. Two concurrent
 *    refunds read the same value; one update matches, the other gets a 409.
 *    This does not depend on any index existing;
 *  - the ledger row also carries an idempotency key as a second guard.
 */

const round2 = (n) => Math.round(n * 100) / 100;

const paidAmount = (booking) =>
  booking.payment?.status === 'paid'
    ? Number(booking.payment.requestedAmount ?? booking.pricing?.finalPrice ?? booking.pricing?.estimatedPrice) || 0
    : 0;

async function ledgerRefunds(bookingId) {
  const [row] = await WalletTransaction.aggregate([
    { $match: { 'relatedTo.kind': 'Booking', 'relatedTo.id': bookingId, type: 'credit', source: 'refund', status: 'completed' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return row ? row.total : 0;
}

/** { paid, refunded, remaining } for a booking. */
async function refundState(booking) {
  const paid = paidAmount(booking);
  const recorded = Number(booking.payment?.refundedAmount) || 0;
  const refunded = Math.max(recorded, await ledgerRefunds(booking._id));
  return { paid, refunded: round2(refunded), remaining: Math.max(0, round2(paid - refunded)) };
}

/**
 * Credit `amount` (default: everything still refundable) to the booking's
 * customer. Throws CONFLICT when nothing is refundable or a concurrent refund
 * won, VALIDATION_FAILED when the amount is out of range.
 */
async function refundBookingToCustomer(booking, { amount, description, metadata }) {
  if (booking.payment?.status !== 'paid') {
    throw new AppError(ERROR_CODES.CONFLICT, 'Only a paid booking can be refunded.', {
      details: { paymentStatus: booking.payment?.status || null },
    });
  }
  const recorded = Number(booking.payment?.refundedAmount) || 0;
  const state = await refundState(booking);
  if (state.remaining <= 0) {
    throw new AppError(ERROR_CODES.CONFLICT, 'This booking has already been refunded in full.', { details: state });
  }
  const value = amount === undefined || amount === null || amount === '' ? state.remaining : round2(Number(amount));
  if (!Number.isFinite(value) || value <= 0 || value > state.remaining) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `Refund must be more than 0 and at most ${state.remaining}.`, {
      details: { ...state, fields: [{ field: 'amount', message: `At most ${state.remaining}` }] },
    });
  }

  // Claim: advance the counter only if nobody else has since this read.
  const claimed = round2(state.refunded + value);
  const claim = await Booking.updateOne(
    {
      _id: booking._id,
      'payment.status': 'paid',
      'payment.refundedAmount': recorded === 0 ? { $in: [0, null] } : recorded,
    },
    { $set: { 'payment.refundedAmount': claimed } }
  );
  if (claim.modifiedCount !== 1) {
    throw new AppError(ERROR_CODES.CONFLICT, 'Another refund on this booking was just issued. Reload and check the amount.');
  }

  try {
    const { transaction } = await WalletService.refund({
      ownerType: 'User',
      ownerId: booking.customer?._id || booking.customer,
      amount: value,
      relatedTo: { kind: 'Booking', id: booking._id },
      description,
      metadata,
      idempotencyKey: `booking-refund:${booking._id}:${state.refunded}`,
    });
    if (booking.payment) booking.payment.refundedAmount = claimed;
    return { amount: value, transaction, remainingAfter: Math.max(0, round2(state.remaining - value)) };
  } catch (err) {
    // Nothing was paid out: release the claim.
    await Booking.updateOne({ _id: booking._id, 'payment.refundedAmount': claimed }, { $set: { 'payment.refundedAmount': recorded } });
    if (err && err.code === 11000) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Another refund on this booking was just issued. Reload and check the amount.');
    }
    throw err;
  }
}

module.exports = { refundState, refundBookingToCustomer };
