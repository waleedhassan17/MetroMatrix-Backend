/**
 * Serving recommendations for all three modules.
 *
 * Reads what the nightly job computed (ml_user_recs, ml_item_similarities,
 * ml_popular) and re-checks every item against what customers may see TODAY
 * (published, approved, brand active; doctor verified; provider searchable) —
 * a product hidden after the batch ran must never be recommended. Each module
 * has an honest fallback, labelled as such: "Popular right now", "Similar
 * items", "Top-rated near you". Cached per user for 10 minutes; the nightly
 * job bumps the namespace (POST /api/internal/ml/refresh).
 */
const mongoose = require('mongoose');
const { getOrSet, ns } = require('../../../lib/cache');
const { k } = require('../../../lib/redis');
const { MlUserRecs, MlItemSimilarity, MlPopular } = require('../models/MlRecs');

const CACHE_SEC = 600;
const SHELF = 12;

const oid = (id) => (mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(String(id)) : null);

async function cacheKey(...parts) {
  return k('c', 'recs', `v${await ns('recs')}`, ...parts);
}

// ── shopping ────────────────────────────────────────────────────────────────

async function visibleProducts(ids) {
  const Product = require('../../shopping/models/Product');
  const Brand = require('../../shopping/models/Brand');
  const { CUSTOMER_VISIBLE } = require('../../shopping/services/catalogService');
  const oids = ids.map(oid).filter(Boolean);
  if (!oids.length) return new Map();
  const products = await Product.find({ _id: { $in: oids }, ...CUSTOMER_VISIBLE });
  const brandIds = [...new Set(products.map((p) => String(p.brandId)))];
  const active = new Set(
    (await Brand.find({ _id: { $in: brandIds }, status: 'active', isDeleted: false }).select('_id').lean()).map((b) => String(b._id))
  );
  return new Map(products.filter((p) => active.has(String(p.brandId))).map((p) => [String(p._id), p.toJSON()]));
}

/** Best sellers of the last 30 days, live — the fallback when no batch has run. */
async function livePopular(limit = 30, brandId = null) {
  const Order = require('../../shopping/models/Order');
  const rows = await Order.aggregate([
    {
      $match: {
        createdAt: { $gte: new Date(Date.now() - 30 * 86400000) },
        orderStatus: { $nin: ['cancelled'] },
        ...(brandId ? { brandId: oid(brandId) } : {}),
      },
    },
    { $unwind: '$items' },
    { $group: { _id: '$items.productId', n: { $sum: '$items.quantity' } } },
    { $sort: { n: -1 } },
    { $limit: limit },
  ]);
  return rows.map((r) => ({ id: String(r._id), score: r.n, reason: 'Popular right now' }));
}

/** A store's best-rated products — tops up a storefront shelf with thin history. */
async function topRated(brandId, limit = SHELF) {
  const Product = require('../../shopping/models/Product');
  const { CUSTOMER_VISIBLE } = require('../../shopping/services/catalogService');
  const rows = await Product.find({ brandId: oid(brandId), ...CUSTOMER_VISIBLE })
    .sort({ rating: -1, totalReviews: -1 })
    .limit(limit)
    .select('_id')
    .lean();
  return rows.map((p) => ({ id: String(p._id), score: 0, reason: 'Top rated in this store' }));
}

async function popularList(brandId = null) {
  const row = await MlPopular.findOne({ domain: 'shopping', segment: 'all' }).sort({ generatedAt: -1 }).lean();
  const batch = row && row.items && row.items.length ? row.items : null;
  // The batch list is platform-wide; inside one store it is only a start.
  if (!brandId) return batch || livePopular();
  return [...(batch || []), ...(await livePopular(30, brandId)), ...(await topRated(brandId))];
}

/**
 * Candidates → product cards: de-duplicated, re-checked against today's
 * visibility, and kept to one store when the shopper is inside one.
 */
async function shelf(candidates, { exclude = new Set(), brandId = null } = {}) {
  const seen = new Set(exclude);
  const unique = candidates.filter((c) => !seen.has(c.id) && seen.add(c.id));
  const products = await visibleProducts(unique.map((c) => c.id));
  return unique
    .filter((c) => products.has(c.id) && (!brandId || products.get(c.id).brandId === String(brandId)))
    .slice(0, SHELF)
    .map((c) => ({ product: products.get(c.id), reason: c.reason, score: c.score }));
}

async function shoppingForUser(userId, { brandId = null } = {}) {
  return getOrSet(await cacheKey('shop', String(userId || 'anon'), String(brandId || 'all')), CACHE_SEC, async () => {
    const pop = await popularList(brandId);
    if (!userId) return { source: 'popular', items: await shelf(pop, { brandId }) };
    const Order = require('../../shopping/models/Order');
    const [personal, boughtIds] = await Promise.all([
      MlUserRecs.findOne({ userId: String(userId), domain: 'shopping' }).lean(),
      Order.distinct('items.productId', { userId: oid(userId) }),
    ]);
    const mine = personal && personal.items ? personal.items : [];
    // The popular top-up must not offer back what this shopper already bought.
    const items = await shelf([...mine, ...pop], { brandId, exclude: new Set(boughtIds.map(String)) });
    const mineIds = new Set(mine.map((m) => m.id));
    return { source: items.some((i) => mineIds.has(i.product.productId)) ? 'personal' : 'popular', items };
  });
}

async function similarProducts(productId, { brandId = null } = {}) {
  return getOrSet(await cacheKey('similar', String(productId), String(brandId || 'all')), CACHE_SEC, async () => {
    const row = await MlItemSimilarity.findOne({ domain: 'shopping', itemId: String(productId) }).lean();
    let candidates = row && row.neighbors ? row.neighbors.map((n) => ({ ...n, reason: n.reason === 'bought_together' ? 'Bought together' : 'Similar' })) : [];
    if (candidates.length < 4) {
      // Content fallback: same category, then same brand, best rated first.
      const Product = require('../../shopping/models/Product');
      const me = await Product.findById(oid(productId)).select('categoryId brandId').lean();
      if (me) {
        const { CUSTOMER_VISIBLE } = require('../../shopping/services/catalogService');
        const more = await Product.find({
          _id: { $ne: me._id },
          ...CUSTOMER_VISIBLE,
          $or: [{ categoryId: me.categoryId }, { brandId: me.brandId }],
        })
          .sort({ rating: -1, totalReviews: -1 })
          .limit(SHELF)
          .select('_id categoryId')
          .lean();
        candidates = candidates.concat(
          more.map((p) => ({ id: String(p._id), score: 0, reason: String(p.categoryId) === String(me.categoryId) ? 'Similar' : 'From the same brand' }))
        );
      }
    }
    return { items: await shelf(candidates, { exclude: new Set([String(productId)]), brandId }) };
  });
}

async function trending({ brandId = null } = {}) {
  return getOrSet(await cacheKey('trending', String(brandId || 'all')), CACHE_SEC, async () => ({
    items: await shelf(await popularList(brandId), { brandId }),
  }));
}

// ── home services ───────────────────────────────────────────────────────────

const CATEGORY_WORD = { electricians: 'an electrician', plumbers: 'a plumber', 'ac-repairers': 'an AC technician' };

/**
 * Providers through the SAME discovery pipeline search uses — same visibility,
 * same reach, same availableNow, same card — so a recommendation can never
 * show someone search would hide, or say "available" when search would not.
 */
async function discover(match, origin, settings, limitN, { availableOnly = false } = {}) {
  const Provider = require('../../../models/Provider');
  const { buildDiscoveryPipeline } = require('../../homeservice/services/discoveryPipeline');
  const { toDiscoveryCard } = require('../../homeservice/controllers/providerSearchController');
  const hasLocation = Boolean(origin);
  const [res] = await Provider.aggregate(
    buildDiscoveryPipeline({
      centre: hasLocation ? [origin.lng, origin.lat] : null,
      hasLocation,
      radiusMeters: (settings.defaultSearchRadiusKm || 15) * 1000,
      match,
      weights: settings.matchingWeights,
      sort: 'best',
      staleMinutes: settings.onlineStaleMinutes,
      availableOnly,
      pageN: 1,
      limitN,
    })
  );
  return (res ? res.items : []).map((p) => toDiscoveryCard(p, { hasLocation, avgSpeed: settings.avgUrbanSpeedKmh }));
}

/** Top providers of one category ('electricians'…) — the search box's preview. */
async function discoverProviders(category, origin, { availableOnly = false, limit = 3 } = {}) {
  const { searchableProviderFilter } = require('../../homeservice/services/providerVisibility');
  const { CATEGORY_TO_SUBTYPE } = require('../../homeservice/services/serializers');
  const { getHomeserviceSettings } = require('../../homeservice/services/settingsService');
  const subtype = CATEGORY_TO_SUBTYPE[category];
  if (!subtype) return [];
  const settings = await getHomeserviceSettings({ cached: true });
  return discover(searchableProviderFilter(subtype), origin, settings, limit, { availableOnly });
}

async function homeserviceForUser(userId, origin) {
  const cell = origin ? `${origin.lat.toFixed(2)},${origin.lng.toFixed(2)}` : 'anywhere';
  return getOrSet(await cacheKey('hs', String(userId), cell), CACHE_SEC, async () => {
    const Booking = require('../../homeservice/models/Booking');
    const ProviderReview = require('../../homeservice/models/ProviderReview');
    const { searchableProviderFilter } = require('../../homeservice/services/providerVisibility');
    const { CATEGORY_TO_SUBTYPE } = require('../../homeservice/services/serializers');
    const { getHomeserviceSettings } = require('../../homeservice/services/settingsService');
    const settings = await getHomeserviceSettings({ cached: true });
    const out = [];
    const taken = new Set();
    const add = (provider, reason) => {
      if (taken.has(provider.id)) return;
      taken.add(provider.id);
      out.push({ provider, reason });
    };

    // "Book again": providers this customer rated 4★ or more.
    const liked = await ProviderReview.find({ customer: oid(userId), rating: { $gte: 4 } }).sort({ createdAt: -1 }).limit(10).lean();
    if (liked.length) {
      const stars = new Map(liked.map((r) => [String(r.provider), r.rating]));
      const cards = await discover({ _id: { $in: liked.map((r) => r.provider) }, ...searchableProviderFilter() }, origin, settings, 3);
      cards.forEach((c) => add(c, `You rated them ${stars.get(c.id)}★ — book again`));
    }

    // Categories this customer books — the batch's affinity, else straight from bookings.
    const batch = await MlUserRecs.findOne({ userId: String(userId), domain: 'homeservice' }).lean();
    let categories = batch && batch.items ? batch.items.map((i) => i.id) : [];
    if (!categories.length) {
      const rows = await Booking.aggregate([
        { $match: { customer: oid(userId) } },
        { $group: { _id: '$serviceCategory', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 2 },
      ]);
      categories = rows.map((r) => r._id).filter(Boolean);
    }
    for (const cat of categories.slice(0, 2)) {
      const subtype = CATEGORY_TO_SUBTYPE[cat];
      if (!subtype) continue;
      const cards = await discover(searchableProviderFilter(subtype), origin, settings, 4);
      cards.forEach((c) => add(c, `Because you booked ${CATEGORY_WORD[cat] || cat}`));
    }
    return { source: out.length ? 'personal' : 'none', items: out.slice(0, 6) };
  });
}

// ── healthcare ──────────────────────────────────────────────────────────────

async function doctorsForUser(userId, origin) {
  const cell = origin ? `${origin.lat.toFixed(2)},${origin.lng.toFixed(2)}` : 'anywhere';
  return getOrSet(await cacheKey('hc', String(userId), cell), CACHE_SEC, async () => {
    const Doctor = require('../../healthcare/models/Doctor');
    require('../../../models/Provider');
    require('../../healthcare/models/Specialty');
    const batch = await MlUserRecs.findOne({ userId: String(userId), domain: 'healthcare' }).lean();
    let picks = batch && batch.items ? batch.items : [];
    let source = picks.length ? 'personal' : 'none';
    if (!picks.length) {
      // Live fallback: best-rated verified doctors in the specialties this patient has seen.
      const Appointment = require('../../healthcare/models/Appointment');
      const seen = await Appointment.find({ patientId: oid(userId) }).sort({ createdAt: -1 }).limit(20).select('doctorId').lean();
      const specialtyIds = (await Doctor.find({ _id: { $in: seen.map((a) => a.doctorId) } }).select('specialtyId').lean()).map((d) => d.specialtyId);
      if (specialtyIds.length) {
        const top = await Doctor.find({ specialtyId: { $in: specialtyIds }, verificationStatus: 'verified', isActive: true })
          .sort({ rating: -1, totalReviews: -1 })
          .limit(8)
          .select('_id')
          .lean();
        picks = top.map((d) => ({ id: String(d._id), reason: 'Top-rated in a specialty you have seen' }));
        source = 'history';
      }
    }
    if (!picks.length) return { source: 'none', items: [] };
    const docs = await Doctor.find({ _id: { $in: picks.map((p) => oid(p.id)).filter(Boolean) }, verificationStatus: 'verified', isActive: true })
      .populate('providerId', 'fullName profilePhoto')
      .populate('specialtyId', 'name icon')
      .lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    let near = new Map();
    if (origin) {
      const { nearestClinics } = require('../../healthcare/services/doctorService');
      near = await nearestClinics({ ...origin, radiusKm: 50 });
    }
    return {
      source,
      items: picks
        .filter((p) => byId.has(p.id))
        .slice(0, 8)
        .map((p) => {
          const d = byId.get(p.id);
          const n = near.get(p.id);
          return { doctor: { ...d, id: d._id, distanceKm: n ? n.distanceKm : null, nearestClinic: n ? n.clinic : null }, reason: p.reason };
        }),
    };
  });
}

module.exports = { shoppingForUser, similarProducts, trending, homeserviceForUser, doctorsForUser, discoverProviders, livePopular };
