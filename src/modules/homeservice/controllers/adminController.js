const asyncHandler = require('express-async-handler');
const Booking = require('../models/Booking');
const Dispute = require('../models/Dispute');
const PayoutRequest = require('../models/PayoutRequest');
const ServiceCategory = require('../models/ServiceCategory');
const ProviderReview = require('../models/ProviderReview');
const User = require('../../../models/User');
const WalletService = require('../../../services/walletService');
const { DEFAULT_TIMEZONE } = require('../../../utils/time');
const { refundBookingToCustomer, refundState } = require('../services/bookingRefunds');
const { transition } = require('../services/bookingService');
const { STATUS } = require('../services/statusMap');
const {
  getHomeserviceSettings,
  updateHomeserviceSettings,
} = require('../services/settingsService');
const { avatar } = require('../services/serializers');
const auditService = require('../../../services/auditService');
const { homeserviceDashboard } = require('../services/adminDashboardService');
const AppError = require('../../../utils/AppError');
const { ERROR_CODES } = require('../../../utils/errorCodes');
const apiResponse = require('../../../utils/apiResponse');
const { isAdminRequest } = require('../../../utils/adminScope');
const { clampInt, MAX_PAGE_SIZE } = require('../../../utils/pagination');

// Admin routes answer in the admin console's standard envelope. raiseDispute
// (a customer/provider route that lives in this file) keeps its legacy shape.
const ok = (res, data, message, pagination) => {
  if (isAdminRequest(res.req)) return apiResponse.ok(res, data, pagination);
  return res.json({ success: true, data, message, ...(pagination ? { pagination } : {}) });
};

// Every home-services admin mutation lands in the unified AdminAuditLog
// (module 'homeservice'). The old HSAuditLog was written and never read.
const audit = (req, action, targetType, targetId, before, after, reason) =>
  auditService.audit(req, {
    module: 'homeservice',
    action: `homeservice.${action}`,
    targetType,
    targetId,
    before: before ?? undefined,
    after: after ?? undefined,
    reason,
  });

const paginationOf = (page, limit, total) => ({ page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });

function bookingListItem(b) {
  return {
    id: String(b._id),
    status: b.status,
    serviceCategory: b.serviceCategory,
    serviceType: b.serviceSubCategory || b.serviceCategory,
    customer: b.customer
      ? { id: String(b.customer._id), name: b.customer.fullName, email: b.customer.email }
      : null,
    provider: b.provider
      ? { id: String(b.provider._id), name: b.provider.fullName, email: b.provider.email }
      : null,
    scheduledFor: b.scheduledFor ? b.scheduledFor.toISOString() : null,
    price: b.pricing.finalPrice || b.pricing.estimatedPrice,
    paymentStatus: b.payment.status,
    city: (b.address && b.address.city) || '',
    createdAt: b.createdAt.toISOString(),
  };
}

// ---------- 1. BOOKING OVERSIGHT ----------

// GET /api/admin/bookings
const listBookings = asyncHandler(async (req, res) => {
  const {
    status,
    serviceCategory,
    provider,
    search,
    from,
    to,
    page = 1,
    limit = 20,
  } = req.query;
  const pageN = clampInt(page, 1, 1, 1000000);
  const limitN = clampInt(limit, 20, 1, MAX_PAGE_SIZE);

  const query = {};
  if (status && status !== 'all') query.status = status;
  if (serviceCategory && serviceCategory !== 'all') query.serviceCategory = serviceCategory;
  if (provider) query.provider = provider;
  if (from || to) {
    query.createdAt = {};
    if (from) query.createdAt.$gte = new Date(from);
    if (to) query.createdAt.$lte = new Date(to);
  }
  if (search) {
    const users = await User.find({
      $or: [
        { fullName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ],
    }).select('_id');
    query.customer = { $in: users.map((u) => u._id) };
  }

  const [items, total] = await Promise.all([
    Booking.find(query)
      .populate('customer', 'fullName email')
      .populate('provider', 'fullName email')
      .sort({ createdAt: -1 })
      .skip((pageN - 1) * limitN)
      .limit(limitN),
    Booking.countDocuments(query),
  ]);

  ok(res, items.map(bookingListItem), 'Bookings fetched', paginationOf(pageN, limitN, total));
});

// GET /api/admin/bookings/:id — full detail with statusHistory + payment trail
const getBookingDetail = asyncHandler(async (req, res) => {
  const b = await Booking.findById(req.params.id)
    .populate('customer', 'fullName email phoneNumber profilePhoto')
    .populate('provider', 'fullName email phoneNumber profilePhoto providerSubType ratings')
    .populate('payment.walletTransactionId');
  if (!b) {
    res.status(404);
    throw new Error('Booking not found');
  }
  const [dispute, review, refund] = await Promise.all([
    Dispute.findOne({ booking: b._id }),
    ProviderReview.findOne({ booking: b._id }),
    refundState(b),
  ]);
  ok(res, {
    ...bookingListItem(b),
    description: b.description,
    instructions: b.instructions,
    address: b.address,
    statusHistory: b.statusHistory.map((h) => ({
      status: h.status,
      role: h.changedBy ? h.changedBy.role : 'system',
      changedById: h.changedBy && h.changedBy.id ? String(h.changedBy.id) : null,
      changedAt: h.changedAt ? h.changedAt.toISOString() : null,
      note: h.note || '',
    })),
    payment: {
      status: b.payment.status,
      method: b.payment.method,
      requestedAmount: b.payment.requestedAmount,
      paidAt: b.payment.paidAt ? b.payment.paidAt.toISOString() : null,
      transaction: b.payment.walletTransactionId || null,
    },
    work: b.work,
    cancellation: b.cancellation && b.cancellation.by ? b.cancellation : null,
    dispute: dispute
      ? { id: String(dispute._id), status: dispute.status, reason: dispute.reason }
      : null,
    review: review ? { rating: review.rating, comment: review.comment } : null,
    // { paid, refunded, remaining } — what an admin refund can still return.
    refund,
  }, 'Booking detail fetched');
});

// PATCH /api/admin/bookings/:id/status — force-transition, MANDATORY reason
const forceBookingStatus = asyncHandler(async (req, res) => {
  const { status, reason } = req.body;
  const b = await Booking.findById(req.params.id);
  if (!b) {
    res.status(404);
    throw new Error('Booking not found');
  }
  const before = b.status;
  await transition(b, status, { id: req.user._id, role: 'admin' }, { reason });
  await audit(req, 'booking.force-status', 'booking', b._id,
    { status: before }, { status: b.status }, reason);
  ok(res, { bookingId: String(b._id), status: b.status }, 'Status forced');
});

// POST /api/admin/bookings/:id/refund — manual wallet refund with audit
const refundBooking = asyncHandler(async (req, res) => {
  const { amount, reason } = req.body;
  if (!reason || !String(reason).trim()) {
    res.status(400);
    throw new Error('A reason is required for refunds');
  }
  const b = await Booking.findById(req.params.id);
  if (!b) {
    res.status(404);
    throw new Error('Booking not found');
  }
  // Capped at what the customer paid minus refunds already issued
  // (services/bookingRefunds.js); omitting the amount refunds the remainder.
  const { amount: refundAmount, transaction: tx, remainingAfter } = await refundBookingToCustomer(b, {
    amount,
    description: `Admin refund — booking ${b._id}: ${reason}`,
    metadata: { bookingId: String(b._id), adminId: String(req.user._id) },
  });

  await audit(req, 'booking.refund', 'booking', b._id,
    { paymentStatus: b.payment.status },
    { refundAmount, transactionId: String(tx._id) }, reason);

  ok(res, { refunded: true, amount: refundAmount, remainingRefundable: remainingAfter, transactionId: String(tx._id) }, 'Refund issued');
});

// ---------- 2. DISPUTES ----------

// POST /api/bookings/:id/dispute — customer or provider raises one
const raiseDispute = asyncHandler(async (req, res) => {
  const b = req.booking;
  const { reason, description, evidence } = req.body;
  if (!reason || !String(reason).trim()) {
    res.status(400);
    throw new Error('A dispute reason is required');
  }
  if (req.bookingRole === 'admin') {
    res.status(400);
    throw new Error('Admins resolve disputes; participants raise them');
  }
  const existing = await Dispute.findOne({
    booking: b._id,
    status: { $in: ['open', 'investigating'] },
  });
  if (existing) {
    res.status(400);
    throw new Error('An open dispute already exists for this booking');
  }
  const dispute = await Dispute.create({
    booking: b._id,
    raisedBy: { id: req.user._id, role: req.bookingRole },
    againstRole: req.bookingRole === 'customer' ? 'provider' : 'customer',
    reason,
    description: description || '',
    evidence: Array.isArray(evidence) ? evidence : [],
  });
  await require('../../../services/notificationService').notifyDisputeOpened(dispute);
  ok(res, { disputeId: String(dispute._id), status: dispute.status }, 'Dispute raised');
});

// GET /api/admin/disputes
const listDisputes = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const pageN = clampInt(page, 1, 1, 1000000);
  const limitN = clampInt(limit, 20, 1, MAX_PAGE_SIZE);
  const query = {};
  if (status && status !== 'all') query.status = status;

  const [items, total] = await Promise.all([
    Dispute.find(query)
      .populate({
        path: 'booking',
        populate: [
          { path: 'customer', select: 'fullName email' },
          { path: 'provider', select: 'fullName email' },
        ],
      })
      .sort({ createdAt: -1 })
      .skip((pageN - 1) * limitN)
      .limit(limitN),
    Dispute.countDocuments(query),
  ]);

  ok(res, items.map((d) => ({
    id: String(d._id),
    bookingId: d.booking ? String(d.booking._id) : null,
    customer: d.booking && d.booking.customer ? d.booking.customer.fullName : '',
    provider: d.booking && d.booking.provider ? d.booking.provider.fullName : '',
    raisedByRole: d.raisedBy.role,
    againstRole: d.againstRole,
    reason: d.reason,
    description: d.description,
    evidence: d.evidence,
    status: d.status,
    resolution: d.resolution || null,
    refundAmount: d.refundAmount || 0,
    createdAt: d.createdAt.toISOString(),
  })), 'Disputes fetched', paginationOf(pageN, limitN, total));
});

// PATCH /api/admin/disputes/:id — resolve with optional refund/penalty
const resolveDispute = asyncHandler(async (req, res) => {
  const { status, resolution, refundAmount, penalizeProvider, reason } = req.body;
  // Deciding a dispute needs canManageHomeServices (route guard); moving money
  // as part of the decision — a refund or a provider penalty — also needs
  // canManageFinance.
  const movesMoney = (refundAmount && Number(refundAmount) > 0) || !!penalizeProvider;
  if (movesMoney && !req.user.hasPermission('canManageFinance')) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Refunds and penalties need the 'canManageFinance' permission", {
      details: { permission: 'canManageFinance' },
    });
  }
  const d = await Dispute.findById(req.params.id).populate('booking');
  if (!d) {
    res.status(404);
    throw new Error('Dispute not found');
  }
  const before = { status: d.status, resolution: d.resolution };

  if (status) d.status = status;
  if (resolution !== undefined) d.resolution = resolution;
  if (['resolved', 'rejected'].includes(d.status)) {
    d.resolvedBy = req.user._id;
    d.resolvedAt = new Date();
  }

  if (refundAmount && Number(refundAmount) > 0 && d.booking) {
    // Same cap as the admin refund: a dispute refund on top of an earlier
    // refund cannot pay out more than the customer paid.
    await refundBookingToCustomer(d.booking, {
      amount: Number(refundAmount),
      description: `Dispute refund — booking ${d.booking._id}`,
      metadata: { disputeId: String(d._id), adminId: String(req.user._id) },
    });
    d.refundAmount = (d.refundAmount || 0) + Number(refundAmount);
  }

  if (penalizeProvider && Number(penalizeProvider) > 0 && d.booking) {
    // debitOrDefer reports whether the money actually moved, so an
    // uncollectable penalty is recorded 'pending' rather than 'completed'.
    // (The old guard `pWallet.balance >= 0` was always true — every penalty
    // read as collected even when the provider could not cover it.)
    await WalletService.debitOrDefer({
      ownerType: 'Provider',
      ownerId: d.booking.provider,
      amount: Number(penalizeProvider),
      relatedTo: { kind: 'Booking', id: d.booking._id },
      description: `Dispute penalty — booking ${d.booking._id}`,
      metadata: { disputeId: String(d._id), adminId: String(req.user._id) },
    });
  }

  await d.save();
  await audit(req, 'dispute.resolve', 'dispute', d._id, before,
    { status: d.status, resolution: d.resolution, refundAmount: d.refundAmount },
    reason || resolution || 'Dispute decision');

  ok(res, { disputeId: String(d._id), status: d.status }, 'Dispute updated');
});

// ---------- 3. PAYOUTS ----------

// GET /api/admin/payout-requests
const listPayoutRequests = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const pageN = clampInt(page, 1, 1, 1000000);
  const limitN = clampInt(limit, 20, 1, MAX_PAGE_SIZE);
  const query = {};
  if (status && status !== 'all') query.status = status;

  const [items, total] = await Promise.all([
    PayoutRequest.find(query)
      .populate('provider', 'fullName email profilePhoto completedBookings ratings')
      .sort({ createdAt: -1 })
      .skip((pageN - 1) * limitN)
      .limit(limitN),
    PayoutRequest.countDocuments(query),
  ]);

  const withBalance = await Promise.all(
    items.map(async (p) => {
      const wallet = p.provider
        ? await WalletService.getOrCreateWallet(p.provider._id, 'Provider')
        : null;
      return {
        id: String(p._id),
        provider: p.provider
          ? {
              id: String(p.provider._id),
              name: p.provider.fullName,
              email: p.provider.email,
              avatar: avatar(p.provider.fullName, p.provider.profilePhoto),
              completedJobs: p.provider.completedBookings || 0,
              rating: p.provider.ratings ? p.provider.ratings.average || 0 : 0,
              walletBalance: wallet ? wallet.balance : 0,
            }
          : null,
        amount: p.amount,
        method: p.method,
        status: p.status,
        rejectionReason: p.rejectionReason || null,
        createdAt: p.createdAt.toISOString(),
        decidedAt: p.decidedAt ? p.decidedAt.toISOString() : null,
      };
    })
  );

  ok(res, withBalance, 'Payout requests fetched', paginationOf(pageN, limitN, total));
});

// PATCH /api/admin/payout-requests/:id — approve (debit ledger) or reject
const decidePayoutRequest = asyncHandler(async (req, res) => {
  const { action, reason } = req.body; // 'approve' | 'reject'
  const p = await PayoutRequest.findById(req.params.id);
  if (!p) {
    res.status(404);
    throw new Error('Payout request not found');
  }
  if (p.status !== 'pending') {
    res.status(400);
    throw new Error(`Payout request is already ${p.status}`);
  }

  if (action === 'approve') {
    const wallet = await WalletService.getOrCreateWallet(p.provider, 'Provider');
    if (wallet.balance < p.amount) {
      res.status(400);
      throw new Error('Provider balance no longer covers this payout');
    }
    // Through the shared primitive so the debit and its ledger row move as
    // one unit, and an approval replayed by a double-click is idempotent.
    const { payerTransaction: tx } = await WalletService.payWithSettle({
      payerType: 'Provider',
      payerId: p.provider,
      amount: p.amount,
      source: 'payout',
      relatedTo: { kind: 'PayoutRequest', id: p._id },
      description: `Payout approved (${p.method})`,
      idempotencyKey: `hspayout-${p._id}`,
      metadata: { payoutRequestId: String(p._id), adminId: String(req.user._id) },
    });
    p.status = 'approved';
    p.walletTransactionId = tx._id;
  } else if (action === 'reject') {
    if (!reason || !String(reason).trim()) {
      res.status(400);
      throw new Error('A reason is required to reject a payout');
    }
    p.status = 'rejected';
    p.rejectionReason = reason;
  } else {
    res.status(400);
    throw new Error("action must be 'approve' or 'reject'");
  }

  p.decidedBy = req.user._id;
  p.decidedAt = new Date();
  await p.save();

  await audit(req, `payout.${action}`, 'payout', p._id,
    { status: 'pending' }, { status: p.status }, reason || `Payout ${action}d`);

  ok(res, { payoutId: String(p._id), status: p.status }, `Payout ${p.status}`);
});

// ---------- 4. SERVICE CATEGORIES ----------

const listCategories = asyncHandler(async (req, res) => {
  const cats = await ServiceCategory.find().sort({ sortOrder: 1 });
  ok(res, cats.map(catShape), 'Categories fetched');
});

function catShape(c) {
  return {
    id: String(c._id),
    name: c.name,
    slug: c.slug,
    providerSubType: c.providerSubType,
    icon: c.icon,
    badge: c.badge,
    badgeColor: c.badgeColor,
    image: c.image,
    description: c.description,
    basePrice: c.basePrice,
    isActive: c.isActive,
    sortOrder: c.sortOrder,
  };
}

const createCategory = asyncHandler(async (req, res) => {
  const { name, slug, providerSubType, icon, badge, badgeColor, image, description, basePrice, isActive, sortOrder } = req.body;
  if (!name || !slug || !providerSubType) {
    res.status(400);
    throw new Error('name, slug and providerSubType are required');
  }
  const c = await ServiceCategory.create({
    name, slug, providerSubType, icon, badge, badgeColor, image, description,
    basePrice, isActive, sortOrder,
  });
  await audit(req, 'category.create', 'category', c._id, null, catShape(c), 'Category created');
  ok(res, catShape(c), 'Category created');
});

const updateCategory = asyncHandler(async (req, res) => {
  const c = await ServiceCategory.findById(req.params.id);
  if (!c) {
    res.status(404);
    throw new Error('Category not found');
  }
  const before = catShape(c);
  ['name', 'slug', 'providerSubType', 'icon', 'badge', 'badgeColor', 'image',
    'description', 'basePrice', 'isActive', 'sortOrder'].forEach((k) => {
    if (req.body[k] !== undefined) c[k] = req.body[k];
  });
  await c.save();
  await audit(req, 'category.update', 'category', c._id, before, catShape(c),
    req.body.reason || 'Category updated');
  ok(res, catShape(c), 'Category updated');
});

const deleteCategory = asyncHandler(async (req, res) => {
  const c = await ServiceCategory.findByIdAndDelete(req.params.id);
  if (!c) {
    res.status(404);
    throw new Error('Category not found');
  }
  await audit(req, 'category.delete', 'category', c._id, catShape(c), null,
    req.body.reason || 'Category deleted');
  ok(res, { deleted: true }, 'Category deleted');
});

// Public GET /api/service-categories — customer home + search read this
const publicCategories = asyncHandler(async (req, res) => {
  const cats = await ServiceCategory.find({ isActive: true }).sort({ sortOrder: 1 });
  ok(res, cats.map(catShape), 'Categories fetched');
});

// ---------- 5. DASHBOARD + ANALYTICS ----------

// GET /api/admin/homeservice/dashboard
const dashboard = asyncHandler(async (req, res) => {
  ok(res, await homeserviceDashboard(), 'Dashboard fetched');
});

// GET /api/admin/homeservice/analytics?from&to
const analytics = asyncHandler(async (req, res) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(to.getTime() - 30 * 86400000);
  const settings = await getHomeserviceSettings();
  const range = { createdAt: { $gte: from, $lte: to } };
  const grossExpr = { $ifNull: ['$pricing.finalPrice', '$pricing.estimatedPrice'] };

  const [overTime, byCategory, byStatus, revenueAgg, completionAgg, topProviders] =
    await Promise.all([
      Booking.aggregate([
        { $match: range },
        {
          $group: {
            // Pakistan days, not UTC: a booking at 02:00 PKT belongs to that day.
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: DEFAULT_TIMEZONE } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Booking.aggregate([
        { $match: range },
        { $group: { _id: '$serviceCategory', count: { $sum: 1 }, gross: { $sum: grossExpr } } },
      ]),
      Booking.aggregate([
        { $match: range },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Booking.aggregate([
        { $match: { ...range, 'payment.status': 'paid' } },
        { $group: { _id: null, revenue: { $sum: grossExpr }, count: { $sum: 1 } } },
      ]),
      Booking.aggregate([
        { $match: { ...range, status: STATUS.COMPLETED, 'work.actualDurationMinutes': { $gt: 0 } } },
        { $group: { _id: null, avgMinutes: { $avg: '$work.actualDurationMinutes' } } },
      ]),
      Booking.aggregate([
        { $match: { ...range, status: STATUS.COMPLETED } },
        { $group: { _id: '$provider', jobs: { $sum: 1 }, gross: { $sum: grossExpr } } },
        { $sort: { jobs: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: 'providers',
            localField: '_id',
            foreignField: '_id',
            as: 'p',
          },
        },
        {
          $project: {
            jobs: 1,
            gross: 1,
            name: { $arrayElemAt: ['$p.fullName', 0] },
            rating: { $arrayElemAt: ['$p.ratings.average', 0] },
          },
        },
      ]),
    ]);

  const totalInRange = byStatus.reduce((s, x) => s + x.count, 0);
  const cancelled = byStatus
    .filter((x) => [STATUS.CANCELLED, STATUS.REJECTED].includes(x._id))
    .reduce((s, x) => s + x.count, 0);
  const revenue = (revenueAgg[0] && revenueAgg[0].revenue) || 0;

  ok(res, {
    from: from.toISOString(),
    to: to.toISOString(),
    bookingsOverTime: overTime.map((x) => ({ date: x._id, count: x.count })),
    byCategory: byCategory.map((x) => ({ category: x._id, count: x.count, gross: x.gross })),
    byStatus: byStatus.map((x) => ({ status: x._id, count: x.count })),
    revenue,
    commission: Math.round(revenue * (settings.commissionPercent / 100)),
    // null, not 0, when there is nothing to measure: "0 min" and "0 %" read as facts.
    averageCompletionMinutes: completionAgg[0] ? Math.round(completionAgg[0].avgMinutes) : null,
    cancellationRate: totalInRange ? Math.round((cancelled / totalInRange) * 100) : null,
    timezone: DEFAULT_TIMEZONE,
    topProviders: topProviders.map((x) => ({
      id: String(x._id),
      name: x.name || 'Provider',
      jobs: x.jobs,
      gross: x.gross,
      rating: typeof x.rating === 'number' ? x.rating : null,
    })),
  }, 'Analytics fetched');
});

// ---------- 6. SETTINGS ----------

const getSettings = asyncHandler(async (req, res) => {
  ok(res, await getHomeserviceSettings(), 'Settings fetched');
});

const patchSettings = asyncHandler(async (req, res) => {
  const before = await getHomeserviceSettings();
  const allowed = [
    'commissionPercent',
    'defaultSearchRadiusKm',
    'matchingWeights',
    'minPayoutAmount',
    'avgUrbanSpeedKmh',
  ];
  const patch = {};
  allowed.forEach((k) => {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  });
  const after = await updateHomeserviceSettings(patch);
  await audit(req, 'settings.update', 'settings',
    null,
    before, after, req.body.reason || 'Settings updated');
  ok(res, after, 'Settings updated');
});

module.exports = {
  listBookings,
  getBookingDetail,
  forceBookingStatus,
  refundBooking,
  raiseDispute,
  listDisputes,
  resolveDispute,
  listPayoutRequests,
  decidePayoutRequest,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  publicCategories,
  dashboard,
  analytics,
  getSettings,
  patchSettings,
};
