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

  // Real-time fan-out (HS3). Lazy require avoids a cycle and no-ops when the
  // socket layer is not attached (tests, serverless).
  try {
    const { emitToBooking } = require('../../../sockets');
    emitToBooking(booking._id, 'booking_status_changed', {
      bookingId: String(booking._id),
      status: nextStatus,
      changedAt: new Date().toISOString(),
    });
  } catch (e) {
    /* socket layer unavailable — REST polling still works */
  }

  return booking;
}

module.exports = { transition, StatusError, CUSTOMER_CANCELLABLE_FROM };
