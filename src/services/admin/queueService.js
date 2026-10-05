const mongoose = require('mongoose');
const Provider = require('../../models/Provider');
const WalletAdjustment = require('../../models/WalletAdjustment');
const Doctor = require('../../modules/healthcare/models/Doctor');
const { PENDING_DOCTOR_STATUSES } = require('../../modules/healthcare/services/adminDashboardService');
const Brand = require('../../modules/shopping/models/Brand');
const ReturnRequest = require('../../modules/shopping/models/ReturnRequest');
const Dispute = require('../../modules/homeservice/models/Dispute');
const PayoutRequest = require('../../modules/homeservice/models/PayoutRequest');
const { stateFilter } = require('./providerStatus');
const AppError = require('../../utils/AppError');
const { ERROR_CODES } = require('../../utils/errorCodes');
const { MAX_PAGE_SIZE, clampInt } = require('../../utils/pagination');

/**
 * The admin work queue: everything waiting for an admin decision, across
 * modules, oldest first. GET /api/admin/queue lists it; GET /api/admin/overview
 * shows the per-type counts.
 *
 * A viewer only sees the work they are permitted to do. Items point at their
 * record with `target: { type, id }` — the app decides which screen that is.
 * Work about a provider (doctor, brand, payout) also carries
 * `target.providerId`, so the app can open that provider.
 */
const idOf = (ref) => (ref ? String(ref._id || ref) : null);
const SOURCES = [
  {
    type: 'provider_approval',
    label: 'Provider applications',
    permission: 'canApproveProviders',
    model: Provider,
    filter: () => stateFilter('pending'),
    timeField: 'submittedAt',
    select: 'fullName providerType providerSubType city submittedAt',
    item: (p) => ({
      title: p.fullName,
      subtitle: [p.providerSubType || p.providerType, p.city].filter(Boolean).join(' · '),
      target: { type: 'Provider', id: String(p._id) },
    }),
  },
  {
    type: 'doctor_approval',
    label: 'Doctor verifications',
    permission: 'canManageHealthcare',
    model: Doctor,
    filter: () => ({ verificationStatus: { $in: PENDING_DOCTOR_STATUSES } }),
    timeField: 'createdAt',
    select: 'providerId specialtyId verificationStatus createdAt',
    populate: [
      { path: 'providerId', select: 'fullName' },
      { path: 'specialtyId', select: 'name' },
    ],
    item: (d) => ({
      title: d.providerId?.fullName || 'Doctor',
      subtitle: d.specialtyId?.name || null,
      target: { type: 'Doctor', id: String(d._id), providerId: idOf(d.providerId) },
    }),
  },
  {
    type: 'brand_approval',
    label: 'Brand applications',
    permission: 'canManageShopping',
    model: Brand,
    filter: () => ({ status: 'pending', isDeleted: false }),
    timeField: 'createdAt',
    select: 'name owner createdAt',
    item: (b) => ({ title: b.name, subtitle: null, target: { type: 'Brand', id: String(b._id), providerId: idOf(b.owner) } }),
  },
  {
    type: 'dispute',
    label: 'Open disputes',
    permission: 'canManageHomeServices',
    model: Dispute,
    filter: () => ({ status: { $in: ['open', 'investigating'] } }),
    timeField: 'createdAt',
    select: 'reason role status booking createdAt',
    item: (d) => ({
      title: d.reason,
      subtitle: `Raised by the ${d.role}${d.status === 'investigating' ? ' · investigating' : ''}`,
      target: { type: 'Dispute', id: String(d._id) },
    }),
  },
  {
    type: 'payout_request',
    label: 'Payout requests',
    permission: 'canManageFinance',
    model: PayoutRequest,
    filter: () => ({ status: 'pending' }),
    timeField: 'createdAt',
    select: 'provider amount createdAt',
    populate: [{ path: 'provider', select: 'fullName' }],
    item: (p) => ({
      title: p.provider?.fullName || 'Provider',
      subtitle: null,
      amount: { value: p.amount, currency: 'PKR' },
      target: { type: 'PayoutRequest', id: String(p._id), providerId: idOf(p.provider) },
    }),
  },
  {
    type: 'return_request',
    label: 'Return requests',
    permission: 'canManageShopping',
    model: ReturnRequest,
    filter: () => ({ status: 'requested' }),
    timeField: 'createdAt',
    select: 'reason order refundAmount createdAt',
    item: (r) => ({
      title: r.reason,
      subtitle: null,
      target: { type: 'ReturnRequest', id: String(r._id), orderId: r.order ? String(r.order) : null },
    }),
  },
  {
    type: 'wallet_adjustment',
    label: 'Wallet adjustments awaiting a second approver',
    permission: 'canManageFinance',
    superAdminOnly: true,
    model: WalletAdjustment,
    filter: () => ({ status: 'pending' }),
    timeField: 'createdAt',
    select: 'direction amount reason createdAt',
    item: (a) => ({
      title: `${a.direction === 'credit' ? 'Credit' : 'Debit'} — ${a.reason}`,
      subtitle: null,
      amount: { value: a.amount, currency: 'PKR' },
      target: { type: 'WalletAdjustment', id: String(a._id) },
    }),
  },
];

const TYPES = SOURCES.map((s) => s.type);

const canSee = (admin, source) => admin.hasPermission(source.permission) && (!source.superAdminOnly || admin.isSuperAdmin);
const visibleSources = (admin) => SOURCES.filter((s) => canSee(admin, s));

/** Per-type counts and oldest waiting time, for the types this admin can act on. */
async function queueSummary(admin) {
  return Promise.all(
    visibleSources(admin).map(async (s) => {
      const filter = s.filter();
      const [count, oldest] = await Promise.all([
        s.model.countDocuments(filter),
        s.model.findOne(filter).sort({ [s.timeField]: 1 }).select(s.timeField).lean(),
      ]);
      return {
        type: s.type,
        label: s.label,
        count,
        oldestAt: oldest?.[s.timeField] || null,
        requiredPermission: s.permission,
      };
    })
  );
}

// ---- cursor: (time, type, id) of the last item returned ----
const encode = (item) => Buffer.from(JSON.stringify({ t: item.waitingSince, k: item.type, id: item.id })).toString('base64url');
function decode(cursor) {
  try {
    const { t, k, id } = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!TYPES.includes(k) || !/^[a-f0-9]{24}$/i.test(id)) throw new Error('bad cursor');
    return { t: t ? new Date(t) : null, k, id };
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Invalid cursor', { details: { fields: [{ field: 'cursor', message: 'Invalid cursor' }] } });
  }
}

// Items of `source` strictly after the cursor in (time, type, id) order.
function afterCursor(source, cursor) {
  if (!cursor) return {};
  const f = source.timeField;
  const id = new mongoose.Types.ObjectId(cursor.id);
  if (source.type > cursor.k) return { [f]: { $gte: cursor.t } };
  if (source.type < cursor.k) return { [f]: { $gt: cursor.t } };
  return { $or: [{ [f]: { $gt: cursor.t } }, { [f]: cursor.t, _id: { $gt: id } }] };
}

/**
 * One page of the queue, oldest first, across every type this admin can act
 * on (or one `type`). k-way merge: fetch up to `limit` from each source after
 * the cursor, merge, keep `limit`.
 */
async function queuePage(admin, { type, cursor, limit } = {}) {
  let sources = visibleSources(admin);
  if (type) {
    if (!TYPES.includes(type)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `type must be one of ${TYPES.join(', ')}`, {
        details: { fields: [{ field: 'type', message: 'Unknown queue type' }] },
      });
    }
    sources = sources.filter((s) => s.type === type);
  }
  const size = clampInt(limit, 20, 1, MAX_PAGE_SIZE);
  const after = cursor ? decode(cursor) : null;

  const batches = await Promise.all(
    sources.map(async (s) => {
      let q = s.model
        .find({ $and: [s.filter(), afterCursor(s, after)] })
        .sort({ [s.timeField]: 1, _id: 1 })
        .limit(size)
        .select(s.select);
      if (s.populate) q = q.populate(s.populate);
      const docs = await q.lean();
      return docs.map((d) => ({
        type: s.type,
        id: String(d._id),
        waitingSince: d[s.timeField] || null,
        requiredPermission: s.permission,
        ...s.item(d),
      }));
    })
  );

  // Plain code-point comparison — the same order afterCursor() uses in the
  // database, so pages never skip or repeat an item.
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const merged = batches
    .flat()
    .sort(
      (a, b) =>
        new Date(a.waitingSince || 0) - new Date(b.waitingSince || 0) || cmp(a.type, b.type) || cmp(a.id, b.id)
    )
    .slice(0, size);
  return {
    items: merged,
    nextCursor: merged.length === size ? encode(merged[merged.length - 1]) : null,
    types: sources.map((s) => ({ type: s.type, label: s.label })),
  };
}

module.exports = { SOURCES, TYPES, queueSummary, queuePage, visibleSources };
