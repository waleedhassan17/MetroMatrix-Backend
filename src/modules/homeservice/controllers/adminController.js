const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Dispute = require('../models/Dispute');
const PayoutRequest = require('../models/PayoutRequest');
const ServiceCategory = require('../models/ServiceCategory');
const HSAuditLog = require('../models/HSAuditLog');
const ProviderReview = require('../models/ProviderReview');
const Provider = require('../../../models/Provider');
const User = require('../../../models/User');
const WalletService = require('../../../services/walletService');
const { transition } = require('../services/bookingService');
const { STATUS } = require('../services/statusMap');
const {
  getHomeserviceSettings,
  updateHomeserviceSettings,
} = require('../services/settingsService');
const { avatar } = require('../services/serializers');

const ok = (res, data, message, pagination) =>
  res.json({ success: true, data, message, ...(pagination ? { pagination } : {}) });

async function audit(adminId, action, targetType, targetId, before, after, reason) {
  await HSAuditLog.create({
    admin: adminId,
    action,
    targetType,
    targetId,
    before,
    after,
    reason,
  });
}

function paginationOf(page, limit, total) {
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
  const pageN = parseInt(page, 10) || 1;
  const limitN = parseInt(limit, 10) || 20;

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
  const [dispute, review] = await Promise.all([
    Dispute.findOne({ booking: b._id }),
    ProviderReview.findOne({ booking: b._id }),
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
  await audit(req.user._id, 'booking.force-status', 'booking', b._id,
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
  const refundAmount = Number(amount) || b.pricing.finalPrice || b.pricing.estimatedPrice;
  if (refundAmount <= 0) {
    res.status(400);
    throw new Error('Refund amount must be positive');
  }

  const wallet = await WalletService.getOrCreateWallet(b.customer, 'User');
  await wallet.credit(refundAmount);
  const tx = await WalletService.recordTransaction(wallet._id, {
    type: 'credit',
    amount: refundAmount,
    description: `Admin refund — booking ${b._id}: ${reason}`,
    source: 'refund',
    status: 'completed',
    metadata: { bookingId: String(b._id), adminId: String(req.user._id) },
  });

  await audit(req.user._id, 'booking.refund', 'booking', b._id,
    { paymentStatus: b.payment.status },
    { refundAmount, transactionId: String(tx._id) }, reason);

  ok(res, { refunded: true, amount: refundAmount, transactionId: String(tx._id) }, 'Refund issued');
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
  ok(res, { disputeId: String(dispute._id), status: dispute.status }, 'Dispute raised');
});

// GET /api/admin/disputes
const listDisputes = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const pageN = parseInt(page, 10) || 1;
  const limitN = parseInt(limit, 10) || 20;
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
    const wallet = await WalletService.getOrCreateWallet(d.booking.customer, 'User');
    await wallet.credit(Number(refundAmount));
    await WalletService.recordTransaction(wallet._id, {
      type: 'credit',
      amount: Number(refundAmount),
      description: `Dispute refund — booking ${d.booking._id}`,
      source: 'refund',
      status: 'completed',
      metadata: { disputeId: String(d._id), adminId: String(req.user._id) },
    });
    d.refundAmount = Number(refundAmount);
  }

  if (penalizeProvider && Number(penalizeProvider) > 0 && d.booking) {
    const pWallet = await WalletService.getOrCreateWallet(d.booking.provider, 'Provider');
    const penalty = Number(penalizeProvider);
    if (pWallet.balance >= penalty) await pWallet.debit(penalty);
    await WalletService.recordTransaction(pWallet._id, {
      type: 'debit',
      amount: penalty,
      description: `Dispute penalty — booking ${d.booking._id}`,
      source: 'admin_adjustment',
      status: pWallet.balance >= 0 ? 'completed' : 'pending',
      metadata: { disputeId: String(d._id), adminId: String(req.user._id) },
    });
  }

  await d.save();
  await audit(req.user._id, 'dispute.resolve', 'dispute', d._id, before,
    { status: d.status, resolution: d.resolution, refundAmount: d.refundAmount },
    reason || resolution || 'Dispute decision');

  ok(res, { disputeId: String(d._id), status: d.status }, 'Dispute updated');
});

// ---------- 3. PAYOUTS ----------

// GET /api/admin/payout-requests
const listPayoutRequests = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const pageN = parseInt(page, 10) || 1;
  const limitN = parseInt(limit, 10) || 20;
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
    await wallet.debit(p.amount);
    const tx = await WalletService.recordTransaction(wallet._id, {
      type: 'debit',
      amount: p.amount,
      description: `Payout approved (${p.method})`,
      source: 'payout',
      status: 'completed',
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

  await audit(req.user._id, `payout.${action}`, 'payout', p._id,
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
  await audit(req.user._id, 'category.create', 'category', c._id, null, catShape(c), 'Category created');
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
  await audit(req.user._id, 'category.update', 'category', c._id, before, catShape(c),
    req.body.reason || 'Category updated');
  ok(res, catShape(c), 'Category updated');
});

const deleteCategory = asyncHandler(async (req, res) => {
  const c = await ServiceCategory.findByIdAndDelete(req.params.id);
  if (!c) {
    res.status(404);
    throw new Error('Category not found');
  }
  await audit(req.user._id, 'category.delete', 'category', c._id, catShape(c), null,
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
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [pendingProviders, bookingsToday, gmvAgg, openDisputes, pendingPayouts, onlineProviders] =
    await Promise.all([
      Provider.countDocuments({ providerType: 'home_service', adminVerified: 'pending' }),
      Booking.countDocuments({ createdAt: { $gte: startOfDay } }),
      Booking.aggregate([
        { $match: { 'payment.status': 'paid', 'payment.paidAt': { $gte: startOfDay } } },
        {
          $group: {
            _id: null,
            gmv: { $sum: { $ifNull: ['$pricing.finalPrice', '$pricing.estimatedPrice'] } },
          },
        },
      ]),
      Dispute.countDocuments({ status: { $in: ['open', 'investigating'] } }),
      PayoutRequest.countDocuments({ status: 'pending' }),
      Provider.countDocuments({ providerType: 'home_service', isOnline: true }),
    ]);

  ok(res, {
    pendingProviderApprovals: pendingProviders,
    bookingsToday,
    gmvToday: (gmvAgg[0] && gmvAgg[0].gmv) || 0,
    openDisputes,
    pendingPayouts,
    activeProvidersOnline: onlineProviders,
  }, 'Dashboard fetched');
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
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
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
    averageCompletionMinutes: Math.round((completionAgg[0] && completionAgg[0].avgMinutes) || 0),
    cancellationRate: totalInRange ? Math.round((cancelled / totalInRange) * 100) : 0,
    topProviders: topProviders.map((x) => ({
      id: String(x._id),
      name: x.name || 'Provider',
      jobs: x.jobs,
      gross: x.gross,
      rating: x.rating || 0,
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
    'cancellationWindowHours',
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
  await audit(req.user._id, 'settings.update', 'settings',
    new mongoose.Types.ObjectId('000000000000000000000000'),
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
