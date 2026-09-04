const HSNotification = require('../models/HSNotification');
const { STATUS } = require('./statusMap');

// ============================================================================
// Creating home-service notifications.
//
// EVERY FUNCTION HERE IS BEST-EFFORT AND NEVER THROWS. A notification is a
// side-effect of an action that has already succeeded — the booking is accepted,
// the job is done, the payment is taken. Letting a failed insert bubble up would
// roll back or 500 a request whose real work is finished, which trades a missing
// notification for a broken feature. Callers may `await` these or not; either
// way they cannot fail the operation.
// ============================================================================

/** Who to tell, and what to say, for each booking transition. */
const BOOKING_EVENTS = {
  [STATUS.PENDING]: {
    to: 'provider',
    type: 'booking_created',
    title: 'New booking request',
    message: (ctx) => `${ctx.customerName || 'A customer'} requested ${ctx.service || 'a service'}.`,
  },
  [STATUS.ACCEPTED]: {
    to: 'user',
    type: 'booking_accepted',
    title: 'Booking accepted',
    message: (ctx) => `${ctx.providerName || 'Your provider'} accepted your booking.`,
  },
  [STATUS.REJECTED]: {
    to: 'user',
    type: 'booking_rejected',
    title: 'Booking declined',
    message: (ctx) => `${ctx.providerName || 'The provider'} can't take this booking.`,
  },
  [STATUS.EN_ROUTE]: {
    to: 'user',
    type: 'booking_en_route',
    title: 'On the way',
    message: (ctx) => `${ctx.providerName || 'Your provider'} is on the way.`,
  },
  [STATUS.ARRIVED]: {
    to: 'user',
    type: 'booking_arrived',
    title: 'Provider arrived',
    message: (ctx) => `${ctx.providerName || 'Your provider'} has arrived.`,
  },
  [STATUS.IN_PROGRESS]: {
    to: 'user',
    type: 'booking_in_progress',
    title: 'Work started',
    message: () => 'Your provider has started the job.',
  },
  [STATUS.COMPLETED]: {
    to: 'user',
    type: 'booking_completed',
    title: 'Job completed',
    message: () => 'Your job is complete. Leave a review?',
  },
};

async function create({ recipient, recipientRole, type, title, message, data }) {
  if (!recipient || !recipientRole || !type) return null;
  try {
    return await HSNotification.create({
      recipient,
      recipientRole,
      type,
      title,
      message,
      data: data || null,
    });
  } catch (e) {
    console.error(`[hs-notify] create failed type=${type}: ${e.message}`);
    return null;
  }
}

/**
 * Announce a booking status change to whichever party did NOT cause it.
 *
 * @param {object} booking  the HSBooking (customer/provider may be populated)
 * @param {string} status   the status just transitioned INTO
 * @param {object} ctx      { customerName, providerName, service }
 */
async function notifyBookingStatus(booking, status, ctx = {}) {
  const spec = BOOKING_EVENTS[status];
  if (!spec || !booking) return null;

  // Populated or raw — accept both, since call sites differ.
  const customerId = booking.customer?._id || booking.customer;
  const providerId = booking.provider?._id || booking.provider;
  const recipient = spec.to === 'provider' ? providerId : customerId;

  return create({
    recipient,
    recipientRole: spec.to,
    type: spec.type,
    title: spec.title,
    message: spec.message(ctx),
    data: { bookingId: String(booking._id), roomType: 'homeservice', status },
  });
}

/** A cancellation can come from either side; tell the other one. */
async function notifyBookingCancelled(booking, cancelledBy, ctx = {}) {
  const customerId = booking.customer?._id || booking.customer;
  const providerId = booking.provider?._id || booking.provider;
  const toProvider = String(cancelledBy) === String(customerId);

  return create({
    recipient: toProvider ? providerId : customerId,
    recipientRole: toProvider ? 'provider' : 'user',
    type: 'booking_cancelled',
    title: 'Booking cancelled',
    message: toProvider
      ? `${ctx.customerName || 'The customer'} cancelled this booking.`
      : `${ctx.providerName || 'The provider'} cancelled this booking.`,
    data: { bookingId: String(booking._id), roomType: 'homeservice' },
  });
}

/**
 * The customer paid — tell the provider.
 *
 * Deliberately NOT in BOOKING_EVENTS: that map is keyed by booking STATUS, and
 * payment is a parallel axis (a booking is COMPLETED whether or not it is
 * paid), so there is no status to key this on. Same shape as
 * notifyBookingCancelled — straight to create(), which never throws.
 *
 * The `payment_received` type is already in the HSNotification enum; until now
 * nothing wrote it, which is why a provider was never told about a payment and
 * the provider app faked it on a timer instead.
 */
async function notifyPaymentReceived(booking, ctx = {}) {
  const providerId = booking.provider?._id || booking.provider;
  const amount = ctx.amount != null ? `PKR ${Number(ctx.amount).toLocaleString()}` : 'Payment';

  return create({
    recipient: providerId,
    recipientRole: 'provider',
    type: 'payment_received',
    title: 'Payment received',
    message: `${amount} received from ${ctx.customerName || 'the customer'}.`,
    data: {
      bookingId: String(booking._id),
      roomType: 'homeservice',
      amount: ctx.amount,
      method: ctx.method,
    },
  });
}

module.exports = {
  create,
  notifyBookingStatus,
  notifyBookingCancelled,
  notifyPaymentReceived,
  BOOKING_EVENTS,
};
