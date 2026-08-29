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

  if (!isAdminForce && !ALLOWED_TRANSITIONS[current].includes(nextStatus)) {
    throw new StatusError(
      `Illegal transition ${current} → ${nextStatus}`
    );
  }

  if (isAdminForce) {
    if (!reason || !String(reason).trim()) {
      throw new StatusError('Admin force-transition requires a reason');
    }
  } else if (nextStatus === STATUS.CANCELLED) {
    if (actor.role !== 'customer') {
      throw new StatusError('Only the customer may cancel a booking', 403);
    }
    if (!CUSTOMER_CANCELLABLE_FROM.includes(current)) {
      throw new StatusError(
        `Booking can no longer be cancelled (status ${current})`
      );
    }
  } else if (PROVIDER_TRANSITIONS.includes(nextStatus)) {
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
      await notify.notifyBookingCancelled(booking, actor.id, ctx);
    } else {
      await notify.notifyBookingStatus(booking, nextStatus, ctx);
    }
  } catch (e) {
    console.error(`[booking] notify failed booking=${booking._id}: ${e.message}`);
  }

  return booking;
}

module.exports = { transition, StatusError, CUSTOMER_CANCELLABLE_FROM };
