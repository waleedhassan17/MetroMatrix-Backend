/**
 * Booking state machine (FR-08).
 *
 * All lifecycle changes go through transition() — controllers never set
 * booking.status directly. Illegal moves and actor violations throw a
 * StatusError with statusCode 400/403 that the shared errorMiddleware turns
 * into { success: false, message }.
 */
const {
  STATUS,
  ALLOWED_TRANSITIONS,
  PROVIDER_TRANSITIONS,
  CUSTOMER_TRANSITIONS,
} = require('./statusMap');

class StatusError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Statuses from which the customer may still cancel (strictly before IN_PROGRESS)
const CUSTOMER_CANCELLABLE_FROM = [
  STATUS.PENDING,
  STATUS.ACCEPTED,
  STATUS.EN_ROUTE,
  STATUS.ARRIVED,
];

/**
 * @param {Object} booking - mongoose HSBooking doc (not saved here unless save=true)
 * @param {string} nextStatus - canonical status from statusMap.STATUS
 * @param {Object} actor - { id, role: 'customer'|'provider'|'admin'|'system' }
 * @param {Object} [opts] - { note, reason, save = true }
 */
async function transition(booking, nextStatus, actor, opts = {}) {
  const { note, reason, save = true } = opts;
  const current = booking.status;

  if (!ALLOWED_TRANSITIONS[current]) {
    throw new StatusError(`Unknown booking status '${current}'`);
  }

  const isAdminForce = actor.role === 'admin';

  // A customer grant is checked against CUSTOMER_TRANSITIONS rather than the
  // main graph, so widening what a CUSTOMER may do never widens what a
  // PROVIDER may do. ALLOWED_TRANSITIONS still forbids ACCEPTED → COMPLETED;
  // only the booking's own customer may take that shortcut, and only to close
  // out a job — see CUSTOMER_TRANSITIONS for why that shortcut exists.
  const customerGrant =
    actor.role === 'customer' && (CUSTOMER_TRANSITIONS[current] || []).includes(nextStatus);

  if (!isAdminForce && !customerGrant && !ALLOWED_TRANSITIONS[current].includes(nextStatus)) {
    throw new StatusError(
      `Illegal transition ${current} → ${nextStatus}`
    );
  }

  if (isAdminForce) {
    if (!reason || !String(reason).trim()) {
      throw new StatusError('Admin force-transition requires a reason');
    }
  } else if (nextStatus === STATUS.CANCELLED) {
    // 'system' is the platform releasing a request nobody chose to drop: the
    // customer shopped the same job to several providers, one accepted, and
    // the rest are let go. It is not the customer's cancellation — recording
    // it as theirs would blame a tap they never made — so it is allowed here
    // alongside them, and like an admin force it must say why.
    if (actor.role !== 'customer' && actor.role !== 'system') {
      throw new StatusError('Only the customer may cancel a booking', 403);
    }
    if (actor.role === 'system' && (!reason || !String(reason).trim())) {
      throw new StatusError('System cancellation requires a reason');
    }
    if (!CUSTOMER_CANCELLABLE_FROM.includes(current)) {
      throw new StatusError(
        `Booking can no longer be cancelled (status ${current})`
      );
    }
  } else if (PROVIDER_TRANSITIONS.includes(nextStatus)) {
    // A few of these the customer may also perform — today only the
    // IN_PROGRESS → COMPLETED confirmation. Checked against the source status,
    // so this grant cannot leak to any other provider-only move.
    const customerMayDoThis = (CUSTOMER_TRANSITIONS[current] || []).includes(nextStatus);

    if (actor.role === 'customer' && customerMayDoThis) {
      // Same populated-vs-raw unwrap as the provider check below —
      // loadBookingWithAccess populates customer too.
      const customerId = booking.customer && booking.customer._id ? booking.customer._id : booking.customer;
      if (String(customerId) !== String(actor.id)) {
        throw new StatusError('You are not the customer for this booking', 403);
      }
    } else {
      if (actor.role !== 'provider') {
        throw new StatusError(
          `Only the assigned provider may move a booking to ${nextStatus}`,
          403
        );
      }
      // booking.provider may be a raw ObjectId or a populated Provider doc
      // (loadBookingWithAccess populates it) — String(populatedDoc) is NOT its
      // id string, so unwrap ._id first.
      const providerId = booking.provider && booking.provider._id ? booking.provider._id : booking.provider;
      if (String(providerId) !== String(actor.id)) {
        throw new StatusError('You are not the assigned provider for this booking', 403);
      }
    }
  }

  booking.status = nextStatus;
  booking.statusHistory.push({
    status: nextStatus,
    changedBy: { id: actor.id, role: actor.role },
    changedAt: new Date(),
    note: isAdminForce ? `FORCED: ${reason}` : note,
  });

  if (nextStatus === STATUS.CANCELLED) {
    booking.cancellation = {
      by: actor.role,
      reason: reason || note || '',
      at: new Date(),
    };
  }
  if (nextStatus === STATUS.IN_PROGRESS && !booking.work.startedAt) {
    booking.work.startedAt = new Date();
  }
  if (nextStatus === STATUS.COMPLETED && !booking.work.endedAt) {
    booking.work.endedAt = new Date();
    if (booking.work.startedAt) {
      booking.work.actualDurationMinutes = Math.round(
        (booking.work.endedAt - booking.work.startedAt) / 60000
      );
    }
  }

  if (save) {
    await booking.save();
  }

  // Real-time fan-out. Published to the realtime service, which owns the only
  // socket; this process holds none. Capped at 2s inside the publisher, so a
  // slow or sleeping realtime dyno can never stall or fail a transition — the
  // booking is already saved above.
  //
  // The empty catch this replaces is why the customer's screen never advanced.
  try {
    const { emitToBooking } = require('../../../sockets');
    await emitToBooking(booking._id, 'booking_status_changed', {
      bookingId: String(booking._id),
      roomId: String(booking._id),
      status: nextStatus,
      changedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[booking] status publish failed booking=${booking._id}: ${e.message}`);
  }

  // Durable notification, alongside the live socket event above. That frame
  // only reaches whoever is connected at that instant; this is what the other
  // party finds later in their notifications list, and what backs the unread
  // badge. Hooked HERE because this function is the single choke point every
  // status change passes through — one place to be right, rather than a dozen
  // call sites to keep in sync.
  //
  // notifyBookingStatus swallows its own errors; the booking is already saved
  // either way, so a notification can never undo completed work.
  try {
    const notify = require('./notificationService');
    const ctx = {
      customerName: booking.customer?.fullName,
      providerName: booking.provider?.fullName,
      service: booking.serviceSubCategory || booking.serviceCategory,
    };
    if (nextStatus === STATUS.CANCELLED) {
      await notify.notifyBookingCancelled(booking, actor.id, {
        ...ctx,
        byRole: actor.role,
        reason: reason || note || '',
      });
    } else {
      await notify.notifyBookingStatus(booking, nextStatus, ctx);
    }
  } catch (e) {
    console.error(`[booking] notify failed booking=${booking._id}: ${e.message}`);
  }

  return booking;
}

/**
 * First accept wins.
 *
 * A customer is allowed to send the same job to several providers at once —
 * that is the point of a marketplace, and waiting on one provider at a time is
 * how a five-minute repair becomes an afternoon. But the job is still ONE job:
 * the moment a provider accepts, every other request for it is a promise the
 * customer cannot keep, and leaving them PENDING means two electricians turn
 * up at the same door.
 *
 * So acceptance releases the rest, and the scope of "the rest" is deliberate:
 *
 *   - Same customer, same serviceCategory. A pending plumber is a DIFFERENT
 *     job and survives an electrician accepting — narrowing by category is
 *     what keeps "book more than one person at a time" true for genuinely
 *     separate work.
 *   - PENDING only. A rival the customer already had ACCEPTED is a live
 *     commitment with a provider who has planned their day around it; that is
 *     the customer's to cancel, not ours.
 *
 * Best-effort per booking: the winning acceptance has already been saved by
 * the time this runs, and one stubborn rival must never turn a successful
 * accept into a 500. Each failure is logged with its booking id.
 *
 * @returns {Promise<string[]>} ids of the requests actually released
 */
async function releaseCompetingRequests(acceptedBooking, opts = {}) {
  const Booking = require('../models/Booking');

  const customerId =
    acceptedBooking.customer && acceptedBooking.customer._id
      ? acceptedBooking.customer._id
      : acceptedBooking.customer;

  const winner =
    acceptedBooking.provider && acceptedBooking.provider.fullName
      ? acceptedBooking.provider.fullName
      : 'Another provider';

  const reason =
    opts.reason || `${winner} accepted this job first — request released automatically.`;

  const rivals = await Booking.find({
    _id: { $ne: acceptedBooking._id },
    customer: customerId,
    serviceCategory: acceptedBooking.serviceCategory,
    status: STATUS.PENDING,
  })
    .populate('customer', 'fullName')
    .populate('provider', 'fullName');

  const released = [];
  for (const rival of rivals) {
    try {
      await transition(rival, STATUS.CANCELLED, { id: null, role: 'system' }, { reason });
      released.push(String(rival._id));
    } catch (e) {
      console.error(
        `[booking] releasing rival request failed booking=${rival._id}: ${e.message}`
      );
    }
  }
  return released;
}

module.exports = {
  transition,
  releaseCompetingRequests,
  StatusError,
  CUSTOMER_CANCELLABLE_FROM,
};
