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
 * Thrown when the booking moved on between being read and being written —
 * a customer cancelling in the same second a provider accepts, or the same
 * button tapped twice. The second writer loses cleanly instead of both
 * "succeeding" and the booking ending up in whichever state landed last.
 */
const CONFLICT_MESSAGE =
  'This booking was just updated by someone else. Refresh to see its latest status.';

function isRealId(id) {
  const mongoose = require('mongoose');
  return !!id && mongoose.isValidObjectId(id);
}

/**
 * Save `booking`, but only if it is still in `expectedStatus` in the database.
 *
 * Mongoose applies `doc.$where` to the save() update's filter, so the write is
 * `updateOne({ _id, status: expectedStatus }, delta)`. When another request
 * has moved the booking in the meantime nothing matches and Mongoose throws
 * DocumentNotFoundError, which becomes a 409. A read-modify-write without the
 * precondition let two conflicting transitions both succeed.
 */
async function saveIfStillIn(booking, expectedStatus) {
  booking.$where = { ...(booking.$where || {}), status: expectedStatus };
  try {
    await booking.save();
  } catch (e) {
    if (e && e.name === 'DocumentNotFoundError') {
      throw new StatusError(CONFLICT_MESSAGE, 409);
    }
    throw e;
  } finally {
    if (booking.$where) delete booking.$where.status;
  }
}

/** What to tell someone trying to move a booking that has already ended, or null. */
function endedMessage(booking) {
  switch (booking.status) {
    case STATUS.CANCELLED: {
      const code = booking.cancellation && booking.cancellation.code;
      if (code === 'expired_pending') return 'This request expired before it was accepted.';
      if (code === 'expired_accepted') return 'This booking was closed because the job never started.';
      if (code === 'released') return 'The customer has already booked another provider for this job.';
      return 'This booking has been cancelled.';
    }
    case STATUS.REJECTED:
      return 'This booking was declined.';
    case STATUS.COMPLETED:
      return 'This job is already completed.';
    default:
      return null;
  }
}

/**
 * For a repeated move: would this actor have been allowed to make it? Only
 * identity is checked — the move itself already happened.
 */
function assertSameActor(booking, nextStatus, actor) {
  const customerId = booking.customer && booking.customer._id ? booking.customer._id : booking.customer;
  const providerId = booking.provider && booking.provider._id ? booking.provider._id : booking.provider;
  if (actor.role === 'system') return;
  if (nextStatus === STATUS.CANCELLED || (nextStatus === STATUS.COMPLETED && actor.role === 'customer')) {
    if (actor.role !== 'customer' || String(customerId) !== String(actor.id)) {
      if (nextStatus === STATUS.CANCELLED) {
        throw new StatusError('Only the customer may cancel a booking', 403);
      }
      throw new StatusError('You are not the customer for this booking', 403);
    }
    return;
  }
  if (actor.role !== 'provider' || String(providerId) !== String(actor.id)) {
    throw new StatusError('You are not the assigned provider for this booking', 403);
  }
}

/**
 * @param {Object} booking - mongoose HSBooking doc (not saved here unless save=true)
 * @param {string} nextStatus - canonical status from statusMap.STATUS
 * @param {Object} actor - { id, role: 'customer'|'provider'|'admin'|'system' }
 * @param {Object} [opts] - { note, reason, code, save = true }. `code` is a
 *   machine-readable cancellation cause ('released', 'expired_pending',
 *   'expired_accepted') so stats can tell a provider's no-show from a
 *   customer changing their mind.
 */
async function transition(booking, nextStatus, actor, opts = {}) {
  const { note, reason, code, save = true } = opts;
  const current = booking.status;

  if (!ALLOWED_TRANSITIONS[current]) {
    throw new StatusError(`Unknown booking status '${current}'`);
  }

  const isAdminForce = actor.role === 'admin';

  // Repeating the move that already happened — a double tap, a retry after a
  // dropped response — is not an error. The right person gets the booking back
  // unchanged, with nothing written and nobody notified twice. Anyone else
  // still meets the ownership checks.
  if (current === nextStatus && !isAdminForce) {
    assertSameActor(booking, nextStatus, actor);
    return booking;
  }

  // A customer grant is checked against CUSTOMER_TRANSITIONS rather than the
  // main graph, so widening what a CUSTOMER may do never widens what a
  // PROVIDER may do. ALLOWED_TRANSITIONS still forbids ACCEPTED → COMPLETED;
  // only the booking's own customer may take that shortcut, and only to close
  // out a job — see CUSTOMER_TRANSITIONS for why that shortcut exists.
  const customerGrant =
    actor.role === 'customer' && (CUSTOMER_TRANSITIONS[current] || []).includes(nextStatus);

  if (!isAdminForce && !customerGrant && !ALLOWED_TRANSITIONS[current].includes(nextStatus)) {
    // A booking that has already ended gets a sentence a person can act on,
    // not the state machine's internals.
    const ended = endedMessage(booking);
    if (ended) throw new StatusError(ended, 409);
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
      code: code || null,
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

  if (!save) {
    // The caller saves. Carry the precondition onto that save, and leave the
    // announcements to the caller too (announceTransition) — telling anyone
    // about a change that has not been written yet is how a notification ends
    // up describing a transition that then lost a race.
    booking.$where = { ...(booking.$where || {}), status: current };
    return booking;
  }

  await saveIfStillIn(booking, current);
  await announceTransition(booking, nextStatus, actor, { reason, note, code });
  return booking;
}

function idOf(ref) {
  return ref && ref._id ? ref._id : ref;
}

/** "Sat 27 Sep, 02:00 PM" in Pakistan time, or '' when unscheduled. */
function whenLabel(booking) {
  if (!booking.scheduledFor) return '';
  try {
    const day = new Date(booking.scheduledFor).toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'Asia/Karachi',
    });
    return booking.scheduledTime ? `${day}, ${booking.scheduledTime}` : day;
  } catch (e) {
    return '';
  }
}

/**
 * The push for a transition, addressed to whoever did NOT cause it — or null
 * when a push would be noise (the two of them are standing together, or the
 * platform tidied up a request nobody was waiting on).
 *
 * The in-app notification (notificationService) and the room event reach a
 * person who has the app open. This is for everyone else: a customer who
 * booked and put the phone away learns their provider accepted, set off and
 * arrived without having to keep checking.
 */
function pushFor(booking, nextStatus, actor, ctx) {
  const provider = ctx.providerName || 'Your provider';
  const customer = ctx.customerName || 'The customer';
  const service = (ctx.service || 'service').toLowerCase();
  const when = whenLabel(booking);
  const toCustomer = (title, body) => ({
    userId: idOf(booking.customer),
    role: 'user',
    type: 'booking_update',
    title,
    body,
  });
  const toProvider = (type, title, body) => ({
    userId: idOf(booking.provider),
    role: 'provider',
    type,
    title,
    body,
  });

  switch (nextStatus) {
    case STATUS.ACCEPTED:
      return toCustomer(
        'Booking accepted',
        `${provider} accepted your ${service} booking${when ? ` for ${when}` : ''}.`
      );
    case STATUS.REJECTED:
      return toCustomer('Booking declined', `${provider} can't take this job. Pick another provider.`);
    case STATUS.EN_ROUTE:
      return toCustomer('On the way', `${provider} is on the way to you.`);
    case STATUS.ARRIVED:
      return toCustomer('Your provider has arrived', `${provider} is at your address.`);
    case STATUS.COMPLETED:
      return actor.role === 'customer'
        ? toProvider('booking_update', 'Job confirmed', `${customer} confirmed the ${service} job is done.`)
        : toCustomer('Job completed', `${provider} finished the job. Review the bill and pay when you're ready.`);
    case STATUS.CANCELLED:
      return actor.role === 'customer'
        ? toProvider('booking_cancelled', 'Booking cancelled', `${customer} cancelled the ${service} booking${when ? ` for ${when}` : ''}.`)
        : null;
    default:
      return null;
  }
}

/**
 * Everything that follows a saved transition: the completed-jobs counter, the
 * live room event, the durable notification and the push. All best-effort —
 * the booking is already written, so none of these may fail the request — and
 * run side by side, so the slowest one bounds the wait instead of the sum of
 * them (each publish can take up to 2s).
 */
async function announceTransition(booking, nextStatus, actor, { reason, note, code } = {}) {
  const ctx = {
    customerName: booking.customer?.fullName,
    providerName: booking.provider?.fullName,
    service: booking.serviceSubCategory || booking.serviceCategory,
  };
  const tasks = [];

  // Once per completion, whoever completed it. This used to live in the two
  // provider completion handlers only, so a job the CUSTOMER confirmed never
  // counted towards the provider's completed jobs.
  if (nextStatus === STATUS.COMPLETED && isRealId(idOf(booking.provider))) {
    const Provider = require('../../../models/Provider');
    tasks.push(
      Provider.updateOne({ _id: idOf(booking.provider) }, { $inc: { completedBookings: 1 } })
    );
  }

  // Real-time fan-out. Published to the realtime service, which owns the only
  // socket; this process holds none. Capped at 2s inside the publisher.
  tasks.push(
    (async () => {
      const { emitToBooking } = require('../../../sockets');
      await emitToBooking(booking._id, 'booking_status_changed', {
        bookingId: String(booking._id),
        roomId: String(booking._id),
        status: nextStatus,
        changedAt: new Date().toISOString(),
      });
    })()
  );

  // Durable notification: what the other party finds in their list later, and
  // what backs the unread badge. Swallows its own errors.
  tasks.push(
    (async () => {
      const notify = require('./notificationService');
      if (nextStatus === STATUS.CANCELLED) {
        await notify.notifyBookingCancelled(booking, actor.id, {
          ...ctx,
          byRole: actor.role,
          reason: reason || note || '',
          code,
        });
      } else {
        await notify.notifyBookingStatus(booking, nextStatus, ctx);
      }
    })()
  );

  const push = pushFor(booking, nextStatus, actor, ctx);
  if (push && isRealId(push.userId)) {
    tasks.push(
      (async () => {
        const { pushToUser } = require('../../../sockets');
        await pushToUser(push.userId, push.role, {
          type: push.type,
          title: push.title,
          body: push.body,
          data: {
            bookingId: String(booking._id),
            roomType: 'homeservice',
            status: nextStatus,
            audience: push.role === 'provider' ? 'provider' : 'customer',
          },
        });
      })()
    );
  }

  const results = await Promise.allSettled(tasks);
  results.forEach((r) => {
    if (r.status === 'rejected') {
      console.error(`[booking] post-transition task failed booking=${booking._id}: ${r.reason && r.reason.message}`);
    }
  });
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
      await transition(rival, STATUS.CANCELLED, { id: null, role: 'system' }, { reason, code: 'released' });
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
  announceTransition,
  saveIfStillIn,
  releaseCompetingRequests,
  StatusError,
  CONFLICT_MESSAGE,
  CUSTOMER_CANCELLABLE_FROM,
};
