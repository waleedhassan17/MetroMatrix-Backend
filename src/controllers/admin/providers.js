const asyncHandler = require('express-async-handler');
const Provider = require('../../models/Provider');
const AppError = require('../../utils/AppError');
const { ERROR_CODES } = require('../../utils/errorCodes');
const { ok } = require('../../utils/apiResponse');
const { parseListQuery, findPage, searchRegex } = require('../../utils/pagination');
const { audit } = require('../../services/auditService');
const { historyOf } = require('../../services/admin/history');
const status = require('../../services/admin/providerStatus');
const { softDeleteAccount, restoreAccount } = require('../../services/admin/accountDeletion');
const { sendEmail } = require('../../services/emailService');
const { escapeHtml } = require('../../services/adminEmailService');
const logger = require('../../utils/logger');
const { providerAnalytics, RANGES, DEFAULT_RANGE } = require('../../services/admin/providerAnalytics');
const Doctor = require('../../modules/healthcare/models/Doctor');
const Brand = require('../../modules/shopping/models/Brand');

/*
 * Provider management — /api/admin/providers*.
 *
 * One list endpoint with filters replaces the four overlapping ones
 * (/providers, /providers/pending, /providers/:type, /providers/:id/details).
 * States come from services/admin/providerStatus.js; every decision is audited
 * and requires a reason where it takes something away.
 */

const SUMMARY_FIELDS =
  'fullName email phoneNumber providerType providerSubType city profilePhoto verificationStatus isSuspended submittedAt createdAt approvedAt rejectionReason ratings isOnline';

const summary = (p) => ({
  id: String(p._id),
  fullName: p.fullName,
  email: p.email,
  phoneNumber: p.phoneNumber || null,
  providerType: p.providerType,
  providerSubType: p.providerSubType || null,
  city: p.city || null,
  profilePhoto: p.profilePhoto || null,
  state: status.stateOf(p),
  submittedAt: p.submittedAt || null,
  createdAt: p.createdAt,
  approvedAt: p.approvedAt || null,
  rejectionReason: p.rejectionReason || null,
  rating: p.ratings ? { average: p.ratings.average ?? null, count: p.ratings.count ?? 0 } : null,
  isOnline: !!p.isOnline,
});

const detail = (p) => ({
  ...summary(p),
  emailVerified: p.emailVerified === 'active',
  idNumber: p.idNumber || null,
  address: p.address || null,
  experience: p.experience ?? null,
  briefDescription: p.briefDescription || null,
  rate: p.rate ?? null,
  consultationFee: p.consultationFee ?? null,
  professionalName: p.professionalName || null,
  businessName: p.businessName || null,
  specialty: p.specialty || null,
  profession: p.profession || null,
  category: p.category || null,
  documents: p.documents || {},
  adminNotes: p.adminNotes || null,
  suspendedReason: p.suspendedReason || null,
  suspendedAt: p.suspendedAt || null,
  rejectedAt: p.rejectedAt || null,
  approvedBy: p.approvedBy ? String(p.approvedBy) : null,
  isAvailable: p.isAvailable ?? null,
  lastLoginDate: p.lastLoginDate || null,
  counters: {
    totalBookings: p.totalBookings ?? 0,
    completedBookings: p.completedBookings ?? 0,
    cancelledBookings: p.cancelledBookings ?? 0,
  },
});

// The module records behind a provider: a doctor profile, or the brands a
// vendor owns. The app uses them to open the doctor or brand screens.
async function linksOf(p) {
  if (p.providerType === 'doctor') {
    const doc = await Doctor.findOne({ providerId: p._id }).select('_id').lean();
    return { doctorId: doc ? String(doc._id) : null, brands: [] };
  }
  if (p.providerType === 'vendor') {
    const brands = await Brand.find({ owner: p._id, isDeleted: { $ne: true } }).select('_id name').lean();
    return { doctorId: null, brands: brands.map((b) => ({ id: String(b._id), name: b.name })) };
  }
  return { doctorId: null, brands: [] };
}

const present = async (p) => ({
  ...detail(p),
  links: await linksOf(p),
  history: await historyOf('Provider', p._id),
});

// @route GET /api/admin/providers?state=&type=&subType=&city=&search=&sort=&page=&limit=&cursor=
const listProviders = asyncHandler(async (req, res) => {
  const q = req.query;
  const filter = {};
  if (q.state && q.state !== 'all') {
    const f = status.stateFilter(q.state);
    if (!f) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `state must be one of ${status.PROVIDER_STATES.join(', ')}`, {
        details: { fields: [{ field: 'state', message: 'Unknown state' }] },
      });
    }
    Object.assign(filter, f);
  }
  if (q.type && q.type !== 'all') filter.providerType = String(q.type);
  if (q.subType) filter.providerSubType = String(q.subType);
  if (q.city) filter.city = searchRegex(q.city);
  if (q.search) {
    const re = searchRegex(q.search);
    filter.$or = [{ fullName: re }, { email: re }, { phoneNumber: re }, { businessName: re }];
  }

  // The queue is worked oldest first; everything else newest first.
  const list = parseListQuery(q, {
    sortable: ['createdAt', 'submittedAt', 'fullName', 'approvedAt'],
    defaultSort: q.state === 'pending' ? 'submittedAt' : '-createdAt',
  });
  const [{ items, meta }, counts] = await Promise.all([
    findPage(Provider, filter, list, { select: SUMMARY_FIELDS }),
    stateCounts(),
  ]);
  ok(res, items.map(summary), { ...meta, counts });
});

// Number of providers in each state (for the filter chips).
async function stateCounts() {
  const entries = await Promise.all(
    status.PROVIDER_STATES.map(async (s) => [s, await Provider.countDocuments(status.stateFilter(s))])
  );
  return Object.fromEntries(entries);
}

async function loadProvider(req) {
  const provider = await Provider.findById(req.params.providerId);
  if (!provider) throw new AppError(ERROR_CODES.NOT_FOUND, 'Provider not found');
  return provider;
}

// @route GET /api/admin/providers/:providerId
const getProvider = asyncHandler(async (req, res) => {
  const provider = await loadProvider(req);
  ok(res, await present(provider));
});

// @route GET /api/admin/providers/:providerId/analytics?range=30d|90d|12m
const getProviderAnalytics = asyncHandler(async (req, res) => {
  const range = req.query.range || DEFAULT_RANGE;
  if (!RANGES[range]) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `range must be one of ${Object.keys(RANGES).join(', ')}`, {
      details: { fields: [{ field: 'range', message: 'Unknown range' }] },
    });
  }
  const provider = await Provider.findById(req.params.providerId).select('_id providerType').lean();
  if (!provider) throw new AppError(ERROR_CODES.NOT_FOUND, 'Provider not found');
  ok(res, await providerAnalytics(provider, range));
});

const snapshot = (p) => ({ state: status.stateOf(p) });

async function decided(req, res, provider, action, { before, reason }) {
  await provider.save();
  await audit(req, {
    action: `provider.${action}`,
    targetType: 'Provider',
    targetId: provider._id,
    before,
    after: snapshot(provider),
    reason,
  });
  ok(res, await present(provider));
}

async function emailProvider(provider, subject, paragraphs) {
  try {
    await sendEmail({
      email: provider.email,
      subject,
      html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <p>Dear ${escapeHtml(provider.fullName)},</p>
        ${paragraphs.map((p) => `<p>${p}</p>`).join('\n')}
        <p>Best regards,<br/>The MetroMatrix Team</p></div>`,
    });
  } catch (err) {
    logger.error({ err }, 'provider decision email failed');
  }
}

// @route PUT /api/admin/providers/:providerId/approve   { notes? }
const approveProvider = asyncHandler(async (req, res) => {
  const provider = await loadProvider(req);
  const before = snapshot(provider);
  if (before.state === 'approved') throw new AppError(ERROR_CODES.CONFLICT, 'This provider is already approved');
  if (before.state === 'suspended') throw new AppError(ERROR_CODES.CONFLICT, 'This provider is suspended — lift the suspension instead');
  status.approve(provider, { admin: req.user, notes: req.body.notes || req.body.adminNotes });
  await emailProvider(provider, 'Application Approved - Welcome to MetroMatrix!', [
    'Your application has been approved. You can now sign in and start offering your services.',
  ]);
  await decided(req, res, provider, 'approve', { before, reason: req.body.notes || req.body.adminNotes });
});

// @route PUT /api/admin/providers/:providerId/reject   { reason }
const rejectProvider = asyncHandler(async (req, res) => {
  const provider = await loadProvider(req);
  const before = snapshot(provider);
  if (before.state === 'rejected') throw new AppError(ERROR_CODES.CONFLICT, 'This provider is already rejected');
  status.reject(provider, { admin: req.user, reason: req.body.reason, notes: req.body.notes });
  await emailProvider(provider, 'Application Update - MetroMatrix', [
    'After careful review, we are unable to approve your application at this time.',
    `<strong>Reason:</strong> ${escapeHtml(req.body.reason)}`,
    'You may resubmit your application after addressing the issues mentioned above.',
  ]);
  await decided(req, res, provider, 'reject', { before, reason: req.body.reason });
});

// @route PUT /api/admin/providers/:providerId/suspend   { reason }
const suspendProvider = asyncHandler(async (req, res) => {
  const provider = await loadProvider(req);
  const before = snapshot(provider);
  if (before.state === 'suspended') throw new AppError(ERROR_CODES.CONFLICT, 'This provider is already suspended');
  status.suspend(provider, { admin: req.user, reason: req.body.reason });
  await decided(req, res, provider, 'suspend', { before, reason: req.body.reason });
});

// @route PUT /api/admin/providers/:providerId/unsuspend   { reason? }
const unsuspendProvider = asyncHandler(async (req, res) => {
  const provider = await loadProvider(req);
  const before = snapshot(provider);
  if (before.state !== 'suspended') throw new AppError(ERROR_CODES.CONFLICT, 'This provider is not suspended');
  status.unsuspend(provider);
  await decided(req, res, provider, 'unsuspend', { before, reason: req.body.reason });
});

// @route DELETE /api/admin/providers/:providerId   { reason }
const deleteProvider = asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || req.query?.reason || '').trim();
  if (!reason) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'A reason is required to delete an account');
  const provider = await loadProvider(req);
  const { deletedAt } = await softDeleteAccount('Provider', provider, { admin: req.user, reason });
  await audit(req, {
    action: 'provider.delete',
    targetType: 'Provider',
    targetId: provider._id,
    before: { email: provider.email, state: status.stateOf(provider) },
    after: { deletedAt },
    reason,
  });
  ok(res, { id: String(provider._id), deletedAt, restorable: true });
});

// @route POST /api/admin/providers/:providerId/restore   (super admin)
const restoreProvider = asyncHandler(async (req, res) => {
  const restored = await restoreAccount('Provider', req.params.providerId);
  await audit(req, {
    action: 'provider.restore',
    targetType: 'Provider',
    targetId: req.params.providerId,
    before: { deletedAt: restored.deletedAt },
    after: { deletedAt: null, email: restored.restoredEmail },
    reason: String(req.body?.reason || ''),
  });
  ok(res, { id: String(req.params.providerId), restored: true, email: restored.restoredEmail });
});

module.exports = {
  listProviders,
  getProvider,
  getProviderAnalytics,
  approveProvider,
  rejectProvider,
  suspendProvider,
  unsuspendProvider,
  deleteProvider,
  restoreProvider,
  stateCounts,
};
