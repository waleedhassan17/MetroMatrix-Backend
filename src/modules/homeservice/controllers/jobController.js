const asyncHandler = require('express-async-handler');
const Booking = require('../models/Booking');
const Provider = require('../../../models/Provider');
const { transition } = require('../services/bookingService');
const { STATUS, toJobBucket } = require('../services/statusMap');
const { toJob, toDashboardJob, toProviderCard, avatar } = require('../services/serializers');

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

  const all = await Booking.find({ provider: req.user._id })
    .populate('customer', 'fullName phoneNumber profilePhoto')
    .sort({ scheduledFor: -1 });

  const now = new Date();
  const withBuckets = all.map((b) => ({ b, bucket: toJobBucket(b.status, b.scheduledFor, now) }));

  const stats = {
    total: all.length,
    upcoming: withBuckets.filter((x) => x.bucket === 'upcoming').length,
    today: withBuckets.filter((x) => x.bucket === 'today').length,
    completed: withBuckets.filter((x) => x.bucket === 'completed').length,
    cancelled: withBuckets.filter((x) => x.bucket === 'cancelled').length,
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

// GET /api/provider/jobs/:jobId — JobDetail
const getJobDetail = asyncHandler(async (req, res) => {
  const b = req.booking;
  const job = toJob(b);
  ok(res, {
    ...job,
    customerName: job.customer,
    estimatedPrice: b.pricing.estimatedPrice,
    canonicalStatus: b.status,
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

// POST /accept /reject /start(EN_ROUTE) /arrived
const acceptJob = makeTransitionHandler(STATUS.ACCEPTED, 'Job accepted');
const rejectJob = makeTransitionHandler(STATUS.REJECTED, 'Job rejected');
const startJob = makeTransitionHandler(STATUS.EN_ROUTE, 'En route to job');
const arriveJob = makeTransitionHandler(STATUS.ARRIVED, 'Arrival confirmed');

// POST /start-work — ARRIVED → IN_PROGRESS, returns startTime
const startWork = asyncHandler(async (req, res) => {
  await transition(req.booking, STATUS.IN_PROGRESS, { id: req.user._id, role: 'provider' });
  ok(res, { startTime: req.booking.work.startedAt.toISOString() }, 'Work started');
});

// POST /complete-work — IN_PROGRESS → COMPLETED, returns duration
const completeWork = asyncHandler(async (req, res) => {
  await transition(req.booking, STATUS.COMPLETED, { id: req.user._id, role: 'provider' });
  await Provider.updateOne({ _id: req.user._id }, { $inc: { completedBookings: 1 } });
  ok(res, {
    endTime: req.booking.work.endedAt.toISOString(),
    duration: req.booking.work.actualDurationMinutes || 0,
  }, 'Work completed');
});

// POST /complete — completion with final amount + notes + photos
const completeJob = asyncHandler(async (req, res) => {
  const { finalAmount, notes, photos } = req.body;
  const b = req.booking;
  if (b.status !== STATUS.COMPLETED) {
    await transition(b, STATUS.COMPLETED, { id: req.user._id, role: 'provider' }, { save: false });
    await Provider.updateOne({ _id: req.user._id }, { $inc: { completedBookings: 1 } });
  }
  if (finalAmount) b.pricing.finalPrice = Number(finalAmount);
  if (notes) b.work.notes = notes;
  if (Array.isArray(photos)) b.work.photos = photos;
  await b.save();
  ok(res, { success: true }, 'Job completed');
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
    estimatedPrice: b.pricing.finalPrice || b.pricing.estimatedPrice,
  }, 'Awaiting approval data fetched');
});

// GET /approval-status — customer "approval" = payment made
const getApprovalStatus = asyncHandler(async (req, res) => {
  const b = req.booking;
  ok(res, {
    isApproved: b.payment.status === 'paid',
    approvalTime: b.payment.paidAt ? b.payment.paidAt.toISOString() : undefined,
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
    earnings: b.pricing.finalPrice || b.pricing.estimatedPrice,
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
  const provider = await Provider.findById(req.user._id);
  const all = await Booking.find({ provider: provider._id })
    .populate('customer', 'fullName phoneNumber profilePhoto')
    .sort({ scheduledFor: 1 });

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 86400000);
  const weekAgo = new Date(now.getTime() - 7 * 86400000);

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
  const weekCompleted = all.filter(
    (b) => b.status === STATUS.COMPLETED && b.updatedAt >= weekAgo
  );
  const weekEarnings = weekCompleted.reduce(
    (sum, b) => sum + (b.pricing.finalPrice || b.pricing.estimatedPrice || 0),
    0
  );
  const decided = all.filter((b) =>
    [STATUS.COMPLETED, STATUS.CANCELLED, STATUS.REJECTED].includes(b.status)
  );
  const completionRate = decided.length
    ? Math.round(
        (decided.filter((b) => b.status === STATUS.COMPLETED).length / decided.length) * 100
      )
    : 100;

  const recentActivity = all
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
    .map((b, i) => ({
      id: String(i + 1),
      type:
        b.payment.status === 'paid'
          ? 'payment'
          : b.status === STATUS.PENDING
          ? 'booking'
          : 'job',
      message:
        b.payment.status === 'paid'
          ? `Received Rs. ${b.pricing.finalPrice || b.pricing.estimatedPrice} from ${b.customer.fullName}`
          : b.status === STATUS.PENDING
          ? `New booking request from ${b.customer.fullName}`
          : `${b.serviceSubCategory || b.serviceCategory} — ${b.status.toLowerCase()} (${b.customer.fullName})`,
      time: b.updatedAt.toISOString(),
    }));

  ok(res, {
    profile: {
      id: String(provider._id),
      name: provider.fullName,
      avatar: avatar(provider.fullName, provider.profilePhoto),
      rating: provider.ratings ? provider.ratings.average || 0 : 0,
      isOnline: !!provider.isOnline,
      isPro: (provider.completedBookings || 0) >= 50,
      unreadNotifications: pending.length,
    },
    stats: {
      todayJobs: today.length,
      weekJobs: weekCompleted.length,
      completionRate,
    },
    insights: [
      {
        id: '1',
        title: 'This Week',
        value: `Rs. ${weekEarnings.toLocaleString('en-PK')}`,
        trend: 'up',
        color: '#10B981',
        bgColor: '#D1FAE5',
      },
      {
        id: '2',
        title: 'Rating',
        value: String(provider.ratings ? provider.ratings.average || 0 : 0),
        trend: 'up',
        color: '#3B82F6',
        bgColor: '#DBEAFE',
      },
      {
        id: '3',
        title: 'Completion',
        value: `${completionRate}%`,
        trend: 'up',
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

// GET /api/provider/profile — own profile, ProviderDetails shape
const getProviderProfile = asyncHandler(async (req, res) => {
  const p = await Provider.findById(req.user._id);
  ok(res, {
    ...toProviderCard(p),
    servicesOffered: [],
    availability: [],
    gallery: [],
    reviewsList: [],
    serviceRadius: p.serviceRadius || 15,
  }, 'Profile fetched');
});

// PATCH /api/provider/profile
const updateProviderProfile = asyncHandler(async (req, res) => {
  const p = await Provider.findById(req.user._id);
  const { name, bio, price, city, experience, serviceRadius } = req.body;
  if (name) p.fullName = name;
  if (bio !== undefined) p.briefDescription = bio;
  if (price !== undefined) p.basePrice = Number(price);
  if (city) p.city = city;
  if (experience) p.experience = experience;
  if (serviceRadius !== undefined) p.serviceRadius = Number(serviceRadius);
  await p.save();
  ok(res, toProviderCard(p), 'Profile updated');
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
