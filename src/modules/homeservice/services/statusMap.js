/**
 * Canonical Home-Services booking lifecycle and its display mappings.
 *
 * WHY THIS FILE EXISTS: the frontend grew four different status vocabularies
 * (models/serviceProviders/booking.ts, serviceStatus.ts, tracking.ts, job.ts +
 * dashboard.ts) before any backend existed. The backend stores ONE canonical
 * status; every screen-facing shape is derived here — and only here — so the
 * vocabularies can never drift apart again. See HOMESERVICE_SPEC.md §2 in the
 * frontend repo.
 */

const STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  EN_ROUTE: 'EN_ROUTE',
  ARRIVED: 'ARRIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
};

const ALL_STATUSES = Object.values(STATUS);

const TERMINAL_STATUSES = [STATUS.COMPLETED, STATUS.REJECTED, STATUS.CANCELLED];

/**
 * Everything that is NOT terminal — a booking the customer still has running
 * with a provider. This is the definition of "already requested": a customer
 * may hold one active booking per provider at a time, so a second Book tap on
 * the same provider reopens the first request instead of creating a duplicate.
 * Derived from TERMINAL_STATUSES rather than listed by hand, so a status added
 * to the lifecycle later counts as active until someone says otherwise.
 */
const ACTIVE_STATUSES = ALL_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s));

const ALLOWED_TRANSITIONS = {
  [STATUS.PENDING]: [STATUS.ACCEPTED, STATUS.REJECTED, STATUS.CANCELLED],
  [STATUS.ACCEPTED]: [STATUS.EN_ROUTE, STATUS.CANCELLED],
  [STATUS.EN_ROUTE]: [STATUS.ARRIVED, STATUS.CANCELLED],
  [STATUS.ARRIVED]: [STATUS.IN_PROGRESS, STATUS.CANCELLED],
  [STATUS.IN_PROGRESS]: [STATUS.COMPLETED],
  [STATUS.COMPLETED]: [],
  [STATUS.REJECTED]: [],
  [STATUS.CANCELLED]: [],
};

// Transitions only the assigned provider may perform
const PROVIDER_TRANSITIONS = [
  STATUS.ACCEPTED,
  STATUS.REJECTED,
  STATUS.EN_ROUTE,
  STATUS.ARRIVED,
  STATUS.IN_PROGRESS,
  STATUS.COMPLETED,
];

/**
 * Transitions the CUSTOMER may perform, keyed by the status being moved FROM.
 *
 * COMPLETED is in PROVIDER_TRANSITIONS above and stays there — the provider
 * still completes their own jobs. This map is an additional grant for the
 * CUSTOMER only, and bookingService checks it INSTEAD of the main graph, so
 * nothing here widens what a provider may do.
 *
 * The customer may close out a job from any point after a provider committed
 * to it. That is deliberate, not lax: the lifecycle only advances when the
 * provider drives it (EN_ROUTE → ARRIVED → IN_PROGRESS), and a provider who
 * does the work but never touches those buttons would otherwise strand the
 * customer on a booking they cannot finish — and strand the provider too,
 * since they stay unbookable while it is live. Cancelling is the wrong escape
 * there; it records a job that happened as one that never did.
 *
 * PENDING is excluded: nobody has agreed to the job yet, so there is no work
 * to call finished. Cancellation covers that case.
 *
 * Keyed by source status rather than a flat list so each grant is explicit.
 *
 * Cancellation is NOT here — it has its own branch in bookingService with its
 * own CUSTOMER_CANCELLABLE_FROM window.
 */
const CUSTOMER_TRANSITIONS = {
  [STATUS.ACCEPTED]: [STATUS.COMPLETED],
  [STATUS.EN_ROUTE]: [STATUS.COMPLETED],
  [STATUS.ARRIVED]: [STATUS.COMPLETED],
  [STATUS.IN_PROGRESS]: [STATUS.COMPLETED],
};

// → booking.ts / UserBooking ('pending'|'confirmed'|'in_progress'|'completed'|'cancelled')
function toBookingStatus(status) {
  switch (status) {
    case STATUS.PENDING:
      return 'pending';
    case STATUS.ACCEPTED:
    case STATUS.EN_ROUTE:
    case STATUS.ARRIVED:
      return 'confirmed';
    case STATUS.IN_PROGRESS:
      return 'in_progress';
    case STATUS.COMPLETED:
      return 'completed';
    default:
      return 'cancelled'; // REJECTED + CANCELLED
  }
}

// → BookingConfirmation.status ('waiting'|'confirmed'|'rejected'|'cancelled')
function toConfirmationStatus(status) {
  switch (status) {
    case STATUS.PENDING:
      return 'waiting';
    case STATUS.REJECTED:
      return 'rejected';
    case STATUS.CANCELLED:
      return 'cancelled';
    default:
      return 'confirmed';
  }
}

// → serviceStatus.ts ('arrived'|'in_progress'|'completed')
function toServiceStatus(status) {
  switch (status) {
    case STATUS.IN_PROGRESS:
      return 'in_progress';
    case STATUS.COMPLETED:
      return 'completed';
    default:
      return 'arrived'; // screen is only reachable from ARRIVED onwards
  }
}

// → tracking.ts ('en_route'|'nearby'|'arrived'|'in_progress'|'completed')
function toTrackingStatus(status, distanceMeters = null) {
  switch (status) {
    case STATUS.EN_ROUTE:
      return distanceMeters !== null && distanceMeters < 500 ? 'nearby' : 'en_route';
    case STATUS.ARRIVED:
      return 'arrived';
    case STATUS.IN_PROGRESS:
      return 'in_progress';
    case STATUS.COMPLETED:
      return 'completed';
    default:
      return 'en_route';
  }
}

/**
 * → job.ts display buckets ('available'|'today'|'upcoming'|'active'|'completed'|'cancelled').
 * Buckets are computed per request from status + schedule; they are filters,
 * never stored.
 */
function toJobBucket(status, scheduledFor, now = new Date()) {
  switch (status) {
    case STATUS.PENDING:
      return 'available';
    case STATUS.ACCEPTED: {
      // Calendar days in Pakistan time — the server runs in UTC, and
      // comparing local getDate()s filed the first five hours after PKT
      // midnight under the previous day. A job whose day has already passed
      // but which is still accepted (not yet started, not yet expired) is due
      // now, so it belongs with today's work, not with the future.
      const { pktDateString } = require('./time');
      const day = pktDateString(scheduledFor ? new Date(scheduledFor) : now);
      return day > pktDateString(now) ? 'upcoming' : 'today';
    }
    case STATUS.EN_ROUTE:
    case STATUS.ARRIVED:
    case STATUS.IN_PROGRESS:
      return 'active';
    case STATUS.COMPLETED:
      return 'completed';
    default:
      return 'cancelled';
  }
}

// → dashboard.ts DashboardJob.status ('pending'|'accepted'|'in_progress'|'completed')
function toDashboardStatus(status) {
  switch (status) {
    case STATUS.PENDING:
      return 'pending';
    case STATUS.ACCEPTED:
    case STATUS.EN_ROUTE:
    case STATUS.ARRIVED:
      return 'accepted';
    case STATUS.IN_PROGRESS:
      return 'in_progress';
    default:
      return 'completed';
  }
}

module.exports = {
  STATUS,
  ALL_STATUSES,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  ALLOWED_TRANSITIONS,
  PROVIDER_TRANSITIONS,
  CUSTOMER_TRANSITIONS,
  toBookingStatus,
  toConfirmationStatus,
  toServiceStatus,
  toTrackingStatus,
  toJobBucket,
  toDashboardStatus,
};
