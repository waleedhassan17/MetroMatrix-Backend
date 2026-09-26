const asyncHandler = require('express-async-handler');
const Booking = require('../models/Booking');
const HSNotification = require('../models/HSNotification');
const Provider = require('../../../models/Provider');
const { transition, releaseCompetingRequests } = require('../services/bookingService');
const { STATUS, toJobBucket } = require('../services/statusMap');
const { toJob, toDashboardJob, toProviderCard, avatar } = require('../services/serializers');
const { expireStale } = require('../services/expiryService');
const { billOf, parseProviderAmount, assertPriceEditable, AmountError } = require('../services/money');
const { pktDayBounds } = require('../services/time');
const { outcomeStats } = require('../services/providerStats');
const { getHomeserviceSettings } = require('../services/settingsService');
const {
  servicesFor,
  weeklyAvailability,
  parseAvailabilityPatch,
} = require('../services/catalogue');

const ok = (res, data, message, pagination) =>
  res.json({ success: true, data, message, ...(pagination ? { pagination } : {}) });

function paginate(page, limit, total) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    currentPage: page,
    totalPages,
    totalItems: total,
    itemsPerPage: limit,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  };
}

// GET /api/provider/jobs?status=&page=&limit= — status is a DISPLAY BUCKET
const listJobs = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 15;
  const bucket = req.query.status;

  await expireStale({ provider: req.user._id });

  const all = await Booking.find({ provider: req.user._id })
    .populate('customer', 'fullName phoneNumber profilePhoto')
    .sort({ scheduledFor: -1 });

  const now = new Date();
  const withBuckets = all
    .map((b) => ({ b, bucket: toJobBucket(b.status, b.scheduledFor, now) }))
    .sort(byJobPriority);

  // One count per bucket toJobBucket can produce. 'available' and 'active'
  // were missing, and 'available' is the one that matters most: it is the
  // number of customers waiting on an answer from this provider. The app
  // declares both in its JobStats type and was hardcoding them to 0, so the
  // Jobs tab could not show a New-requests count even though the jobs were in
  // the payload.
  const countBucket = (name) => withBuckets.filter((x) => x.bucket === name).length;
  const stats = {
    total: all.length,
    available: countBucket('available'),
    upcoming: countBucket('upcoming'),
    today: countBucket('today'),
    active: countBucket('active'),
    completed: countBucket('completed'),
    cancelled: countBucket('cancelled'),
  };

  let filtered = withBuckets;
  if (bucket && bucket !== 'all') {
    filtered = withBuckets.filter((x) => x.bucket === bucket);
  }
  const total = filtered.length;
  const slice = filtered.slice((page - 1) * limit, page * limit);

  ok(res, {
    jobs: slice.map((x) => toJob(x.b, now)),
    stats,
    pagination: paginate(page, limit, total),
  }, 'Jobs fetched');
});

// Work that needs the provider comes first — a job under way, then requests
// waiting on an answer, then today's and later bookings, soonest first — and
// history after it, most recent first. The list used to be one flat
// newest-scheduled-first sort, so a request due in an hour could sit below a
// month of completed jobs.
const BUCKET_RANK = { active: 0, available: 1, today: 2, upcoming: 3, completed: 4, cancelled: 5 };
function byJobPriority(a, b) {
  const ra = BUCKET_RANK[a.bucket] ?? 9;
  const rb = BUCKET_RANK[b.bucket] ?? 9;
  if (ra !== rb) return ra - rb;
  const ta = a.b.scheduledFor ? new Date(a.b.scheduledFor).getTime() : 0;
  const tb = b.b.scheduledFor ? new Date(b.b.scheduledFor).getTime() : 0;
  return ra <= BUCKET_RANK.upcoming ? ta - tb : tb - ta;
}

// GET /api/provider/jobs/:jobId — JobDetail
const getJobDetail = asyncHandler(async (req, res) => {
  const b = req.booking;
  const job = toJob(b);
  ok(res, {
    ...job,
    customerName: job.customer,
    estimatedPrice: b.pricing.estimatedPrice,
    canonicalStatus: b.status,
    payment: { status: b.payment.status, method: b.payment.method, amount: billOf(b) },
    cancellation: b.cancellation && b.cancellation.by ? b.cancellation : null,
  }, 'Job detail fetched');
});

const makeTransitionHandler = (nextStatus, message) =>
  asyncHandler(async (req, res) => {
    await transition(req.booking, nextStatus, { id: req.user._id, role: 'provider' }, {
      note: req.body && req.body.reason,
      reason: req.body && req.body.reason,
    });
    ok(res, { success: true, status: req.booking.status }, message);
  });

// POST /reject /start(EN_ROUTE) /arrived
const rejectJob = makeTransitionHandler(STATUS.REJECTED, 'Job rejected');
const startJob = makeTransitionHandler(STATUS.EN_ROUTE, 'En route to job');
const arriveJob = makeTransitionHandler(STATUS.ARRIVED, 'Arrival confirmed');

// POST /accept — PENDING → ACCEPTED, and the race is over.
//
// Not a plain makeTransitionHandler because accepting is the one provider
// action with a consequence beyond this booking: the customer may have sent
// the same job to several providers, and this one just won it. Every other
// PENDING request for that job is released here — see
// releaseCompetingRequests for exactly which bookings that means and why the
// scope is narrow.
//
// The release runs AFTER the transition has saved, and cannot fail it: a
// provider who accepted a job has accepted it, whatever happens to the rivals.
const acceptJob = asyncHandler(async (req, res) => {
  await transition(req.booking, STATUS.ACCEPTED, { id: req.user._id, role: 'provider' }, {
    note: req.body && req.body.reason,
  });

  let released = [];
  try {
    released = await releaseCompetingRequests(req.booking);
  } catch (e) {
    console.error(`[job] releasing rivals failed booking=${req.booking._id}: ${e.message}`);
  }

  ok(res, {
    success: true,
    status: req.booking.status,
    // The customer's other requests for this job, now withdrawn. Returned so
    // the provider app can say what happened rather than the rows silently
    // changing shape on next fetch.
    releasedRequests: released,
  }, 'Job accepted');
});

// POST /start-work — ARRIVED → IN_PROGRESS, returns startTime
const startWork = asyncHandler(async (req, res) => {
  await transition(req.booking, STATUS.IN_PROGRESS, { id: req.user._id, role: 'provider' });
  ok(res, { startTime: req.booking.work.startedAt.toISOString() }, 'Work started');
});

// POST /complete-work — IN_PROGRESS → COMPLETED, returns duration
const completeWork = asyncHandler(async (req, res) => {
  // The completed-jobs counter is bumped inside transition(), once, whoever
  // completes the job.
  await transition(req.booking, STATUS.COMPLETED, { id: req.user._id, role: 'provider' });
  ok(res, {
    endTime: (req.booking.work.endedAt || new Date()).toISOString(),
    duration: req.booking.work.actualDurationMinutes || 0,
  }, 'Work completed');
});

// POST /complete — completion with final amount + notes + photos
//
// The final amount is validated (a positive number of rupees within this
// job's ceiling — see services/money.js) and is fixed once the customer has
// paid. It used to take any value, negative included, and could be rewritten
// after payment.
const completeJob = asyncHandler(async (req, res) => {
  const { finalAmount, notes, photos } = req.body || {};
  const b = req.booking;

  let amount = null;
  if (finalAmount !== undefined && finalAmount !== null && finalAmount !== '') {
    try {
      assertPriceEditable(b);
      amount = parseProviderAmount(finalAmount, b, 'Final amount');
    } catch (e) {
      if (e instanceof AmountError) {
        res.status(e.statusCode);
        throw new Error(e.message);
      }
      throw e;
    }
  }

  const priceChanged = amount !== null && amount !== billOf(b);
  if (amount !== null) {
    b.pricing.finalPrice = amount;
    // An open payment request follows the price, so the bill never has two answers.
    if (b.payment.requestedAmount) b.payment.requestedAmount = amount;
  }
  if (notes) b.work.notes = String(notes).slice(0, 2000);
  if (Array.isArray(photos)) b.work.photos = photos.filter((p) => typeof p === 'string').slice(0, 10);

  if (b.status !== STATUS.COMPLETED) {
    // One conditional save carries the price and the completion together.
    await transition(b, STATUS.COMPLETED, { id: req.user._id, role: 'provider' });
  } else {
    await b.save();
    if (priceChanged && b.payment.status === 'requested') {
      // The customer is looking at a bill that just changed.
      try {
        const { emitToBooking } = require('../../../sockets');
        await emitToBooking(b._id, 'payment_requested', {
          bookingId: String(b._id),
          roomId: String(b._id),
          amount: billOf(b),
        });
      } catch (e) {
        console.error(`[job] price-change publish failed booking=${b._id}: ${e.message}`);
      }
    }
  }
  ok(res, { success: true, finalAmount: billOf(b) }, 'Job completed');
});

// POST /finalize — provider confirms completion flow finished
const finalizeJob = asyncHandler(async (req, res) => {
  const b = req.booking;
  if (b.status !== STATUS.COMPLETED) {
    res.status(400);
    throw new Error('Job is not completed yet');
  }
  ok(res, { completed: true }, 'Job marked as completed');
});

// GET /awaiting-approval — data for the provider's awaiting screen
const getAwaitingApproval = asyncHandler(async (req, res) => {
  const b = req.booking;
  ok(res, {
    jobId: String(b._id),
    serviceType: b.serviceSubCategory || b.serviceCategory,
    customerName: b.customer.fullName,
    address: [b.address.line1, b.address.city].filter(Boolean).join(', '),
    actualDuration: b.work.actualDurationMinutes,
    estimatedPrice: billOf(b),
  }, 'Awaiting approval data fetched');
});

// GET /approval-status — has the customer signed off on this job?
//
// The provider screen this feeds says "Awaiting Customer Approval / The
// customer has approved your work", so it means approval of the WORK. This
// used to answer `payment.status === 'paid'`, which is a different question and
// a later one — the provider was told to wait for approval before requesting
// payment, while the endpoint only said yes once payment had already happened.
//
// There are exactly two things a customer can do that constitute signing off,
// and either is a real, deliberate action:
//   1. Confirm completion themselves. `transition()` stamps changedBy.role on
//      every status-history entry, so a customer-performed IN_PROGRESS →
//      COMPLETED is distinguishable from the provider completing their own job.
//   2. Pay. Paying is the strongest possible sign-off.
// The provider never advances on anything but one of these.
const getApprovalStatus = asyncHandler(async (req, res) => {
  const b = req.booking;

  const customerConfirmed = (b.statusHistory || []).find(
    (h) => h.status === STATUS.COMPLETED && h.changedBy && h.changedBy.role === 'customer'
  );
  const paid = b.payment.status === 'paid';

  ok(res, {
    isApproved: !!customerConfirmed || paid,
    approvalTime:
      (customerConfirmed && customerConfirmed.changedAt
        ? customerConfirmed.changedAt.toISOString()
        : undefined) || (b.payment.paidAt ? b.payment.paidAt.toISOString() : undefined),
    // Which of the two it was, so the screen can word itself honestly.
    paid,
  }, 'Approval status fetched');
});

// GET /in-progress — JobInProgressData
const getInProgressData = asyncHandler(async (req, res) => {
  const b = req.booking;
  ok(res, {
    jobId: String(b._id),
    serviceType: b.serviceSubCategory || b.serviceCategory,
    category: b.serviceCategory,
    customerName: b.customer.fullName,
    customerPhone: b.customer.phoneNumber || '',
    address: b.address.line1,
    city: b.address.city || '',
    specialInstructions: b.instructions || b.description || '',
    estimatedPrice: b.pricing.estimatedPrice,
    coordinates: {
      latitude: b.address.coordinates.coordinates[1],
      longitude: b.address.coordinates.coordinates[0],
    },
  }, 'Job in progress data fetched');
});

// GET /completion — JobCompletionData
const getCompletionData = asyncHandler(async (req, res) => {
  const b = req.booking;
  const provider = await Provider.findById(req.user._id);
  ok(res, {
    jobId: String(b._id),
    serviceType: b.serviceSubCategory || b.serviceCategory,
    customerName: b.customer.fullName,
    actualDuration: b.work.actualDurationMinutes || 0,
    earnings: billOf(b),
    paymentMethod: b.payment.method === 'cash' ? 'cash' : 'online',
    transactionId: b.payment.walletTransactionId
      ? String(b.payment.walletTransactionId)
      : `PENDING-${b._id}`,
    stats: {
      totalJobsDone: provider.completedBookings || 0,
      averageRating: provider.ratings ? provider.ratings.average || 0 : 0,
      levelProgress: Math.min(100, (provider.completedBookings || 0) * 2),
    },
  }, 'Job completion data fetched');
});

// GET /navigation — NavigationParams for the map screen
const getNavigationData = asyncHandler(async (req, res) => {
  const b = req.booking;
  ok(res, {
    jobId: String(b._id),
    destination: {
      latitude: b.address.coordinates.coordinates[1],
      longitude: b.address.coordinates.coordinates[0],
    },
    destinationAddress: b.address.line1,
    destinationCity: b.address.city || '',
    customerName: b.customer.fullName,
    customerPhone: b.customer.phoneNumber || '',
    serviceType: b.serviceSubCategory || b.serviceCategory,
  }, 'Navigation data fetched');
});

// GET /api/provider/dashboard — DashboardData
const getDashboard = asyncHandler(async (req, res) => {
  await expireStale({ provider: req.user._id });

  const [provider, settings] = await Promise.all([
    Provider.findById(req.user._id),
    getHomeserviceSettings(),
  ]);
  const all = await Booking.find({ provider: provider._id })
    .populate('customer', 'fullName phoneNumber profilePhoto')
    .sort({ scheduledFor: 1 });

  const now = new Date();
  // Pakistan's today, not the server's (UTC) today.
  const { start: startOfDay, end: endOfDay } = pktDayBounds(now);
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000);
  const keep = 1 - settings.commissionPercent / 100;

  const pending = all.filter((b) => b.status === STATUS.PENDING);
  const today = all.filter(
    (b) =>
      b.scheduledFor >= startOfDay &&
      b.scheduledFor < endOfDay &&
      ![STATUS.PENDING, STATUS.REJECTED, STATUS.CANCELLED].includes(b.status)
  );
  const upcoming = all.filter(
    (b) => b.status === STATUS.ACCEPTED && b.scheduledFor >= endOfDay
  );

  // Completed = when the work ended, not whenever the document last changed.
  const endedAt = (b) => (b.work && b.work.endedAt) || b.updatedAt;
  const weekCompleted = all.filter((b) => b.status === STATUS.COMPLETED && endedAt(b) >= weekAgo);

  // What the provider actually took home: paid jobs, net of commission.
  const paidBetween = (from, to) =>
    all
      .filter((b) => b.payment.status === 'paid' && b.payment.paidAt >= from && b.payment.paidAt < to)
      .reduce((sum, b) => sum + billOf(b), 0);
  const weekEarnings = Math.round(paidBetween(weekAgo, now) * keep);
  const lastWeekEarnings = Math.round(paidBetween(twoWeeksAgo, weekAgo) * keep);
  const earningsTrend =
    weekEarnings > lastWeekEarnings ? 'up' : weekEarnings < lastWeekEarnings ? 'down' : 'neutral';

  const outcomes = await outcomeStats(provider._id);
  // A provider with no track record yet has not let anyone down.
  const completionRate = outcomes.completionRate === null ? 100 : outcomes.completionRate;

  const recentActivity = all
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
    .map((b, i) => ({
      id: String(i + 1),
      bookingId: String(b._id),
      type:
        b.payment.status === 'paid'
          ? 'payment'
          : b.status === STATUS.PENDING
          ? 'booking'
          : 'job',
      message:
        b.payment.status === 'paid'
          ? `Received Rs. ${billOf(b).toLocaleString('en-PK')} from ${b.customer.fullName}`
          : b.status === STATUS.PENDING
          ? `New booking request from ${b.customer.fullName}`
          : `${b.serviceSubCategory || b.serviceCategory} — ${ACTIVITY_LABEL[b.status] || b.status.toLowerCase()} (${b.customer.fullName})`,
      time: b.updatedAt.toISOString(),
    }));

  // A REAL unread count. This was `pending.length` — the number of pending
  // booking requests, reported under a notifications label and rendered on a
  // bell icon. Nothing it counted was a notification, so reading them could
  // never clear it.
  const unreadNotifications = await HSNotification.countDocuments({
    recipient: provider._id,
    isRead: false,
  }).catch(() => 0);

  const rating = provider.ratings ? Math.round((provider.ratings.average || 0) * 10) / 10 : 0;

  ok(res, {
    profile: {
      id: String(provider._id),
      name: provider.fullName,
      avatar: avatar(provider.fullName, provider.profilePhoto),
      rating,
      isOnline: !!provider.isOnline,
      isPro: (provider.completedBookings || 0) >= 50,
      unreadNotifications,
    },
    stats: {
      todayJobs: today.length,
      weekJobs: weekCompleted.length,
      completionRate,
    },
    // Trends are only claimed where there is something to compare: earnings
    // against the week before. Rating and completion have no history to
    // compare against, so they are reported flat instead of a permanent "up".
    insights: [
      {
        id: '1',
        title: 'This Week',
        value: `Rs. ${weekEarnings.toLocaleString('en-PK')}`,
        trend: earningsTrend,
        color: '#10B981',
        bgColor: '#D1FAE5',
      },
      {
        id: '2',
        title: 'Rating',
        value: rating ? rating.toFixed(1) : 'New',
        trend: 'neutral',
        color: '#3B82F6',
        bgColor: '#DBEAFE',
      },
      {
        id: '3',
        title: 'Completion',
        value: `${completionRate}%`,
        trend: 'neutral',
        color: '#F59E0B',
        bgColor: '#FEF3C7',
      },
    ],
    jobs: {
      pending: pending.map(toDashboardJob),
      today: today.map(toDashboardJob),
      upcoming: upcoming.map(toDashboardJob),
    },
    recentActivity,
  }, 'Dashboard data fetched');
});

/** Plain words for the activity feed instead of the raw lifecycle enum. */
const ACTIVITY_LABEL = {
  [STATUS.ACCEPTED]: 'accepted',
  [STATUS.EN_ROUTE]: 'on the way',
  [STATUS.ARRIVED]: 'arrived',
  [STATUS.IN_PROGRESS]: 'in progress',
  [STATUS.COMPLETED]: 'completed',
  [STATUS.REJECTED]: 'declined',
  [STATUS.CANCELLED]: 'cancelled',
};

// GET /api/provider/profile — own profile, ProviderDetails shape
const getProviderProfile = asyncHandler(async (req, res) => {
  const p = await Provider.findById(req.user._id);
  ok(res, {
    ...toProviderCard(p),
    servicesOffered: servicesFor(p),
    availability: weeklyAvailability(p),
    gallery: [],
    reviewsList: [],
    serviceRadius: p.serviceRadius || 15,
  }, 'Profile fetched');
});

const MAX_VISIT_CHARGE = 100000;
const RADIUS_RANGE = [1, 50];

// PATCH /api/provider/profile — { name?, bio?, price?, city?, experience?,
// serviceRadius?, availability? }. Everything validated: this is what
// customers are shown and what bookings are priced and scheduled from.
const updateProviderProfile = asyncHandler(async (req, res) => {
  const p = await Provider.findById(req.user._id);
  const { name, bio, price, city, experience, serviceRadius, availability } = req.body || {};
  const fail = (message) => {
    res.status(400);
    throw new Error(message);
  };

  if (name !== undefined) {
    const n = String(name).trim();
    if (n.length < 2 || n.length > 60) fail('Name must be between 2 and 60 characters');
    p.fullName = n;
  }
  if (bio !== undefined) p.briefDescription = String(bio).trim().slice(0, 500);
  if (price !== undefined) {
    const n = Number(price);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_VISIT_CHARGE) {
      fail(`Visit charge must be between Rs. 1 and Rs. ${MAX_VISIT_CHARGE.toLocaleString('en-PK')}`);
    }
    p.basePrice = Math.round(n);
  }
  if (city !== undefined && String(city).trim()) p.city = String(city).trim().slice(0, 60);
  if (experience !== undefined && String(experience).trim()) {
    p.experience = String(experience).trim().slice(0, 30);
  }
  if (serviceRadius !== undefined) {
    const r = Number(serviceRadius);
    if (!Number.isFinite(r) || r < RADIUS_RANGE[0] || r > RADIUS_RANGE[1]) {
      fail(`Service radius must be between ${RADIUS_RANGE[0]} and ${RADIUS_RANGE[1]} km`);
    }
    p.serviceRadius = Math.round(r);
  }
  if (availability !== undefined) {
    let hours;
    try {
      hours = parseAvailabilityPatch(availability);
    } catch (e) {
      fail(e.message);
    }
    for (const [day, value] of Object.entries(hours)) {
      p.set(`availability.${day}`, value);
    }
  }
  await p.save();
  ok(res, {
    ...toProviderCard(p),
    serviceRadius: p.serviceRadius || 15,
    availability: weeklyAvailability(p),
    servicesOffered: servicesFor(p),
  }, 'Profile updated');
});

// PATCH /api/provider/status  and  /api/provider/online-status — { isOnline }
const updateOnlineStatus = asyncHandler(async (req, res) => {
  const { isOnline } = req.body;
  await Provider.updateOne(
    { _id: req.user._id },
    { isOnline: !!isOnline, lastSeen: new Date() }
  );
  ok(res, { isOnline: !!isOnline }, 'Status updated');
});

module.exports = {
  listJobs,
  getJobDetail,
  acceptJob,
  rejectJob,
  startJob,
  arriveJob,
  startWork,
  completeWork,
  completeJob,
  finalizeJob,
  getAwaitingApproval,
  getApprovalStatus,
  getInProgressData,
  getCompletionData,
  getNavigationData,
  getDashboard,
  getProviderProfile,
  updateProviderProfile,
  updateOnlineStatus,
};
