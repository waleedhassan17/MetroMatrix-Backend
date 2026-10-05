/**
 * Setting a provider's service base (Provider.currentLocation).
 *
 * Precedence: a base the provider pinned on purpose ('profile') is never
 * overwritten by the automatic go-online sample unless they opted in to that
 * (autoUpdateBaseOnOnline). Every write is coarsened to the ~500 m grid and
 * replaces the previous point — there is no history to leak.
 */
const Provider = require('../../../models/Provider');
const { coarsen, round6, parseLatLng } = require('./geo');

const SOURCES = ['profile', 'go_online', 'city'];

/** The provider-facing view of their own base. */
function serviceBaseOf(p) {
  const src = (p && p.locationSource) || 'default';
  if (!p || src === 'default' || !p.currentLocation || !Array.isArray(p.currentLocation.coordinates)) {
    return { latitude: null, longitude: null, source: 'default', updatedAt: null };
  }
  const [lng, lat] = p.currentLocation.coordinates;
  return {
    latitude: lat,
    longitude: lng,
    source: src,
    updatedAt: p.locationUpdatedAt ? new Date(p.locationUpdatedAt).toISOString() : null,
  };
}

/**
 * Decide whether a base write should happen, and what it writes.
 * Pure — returns the $set, or null when precedence forbids the write.
 */
function planBaseWrite(current, input, source, now = new Date()) {
  if (!SOURCES.includes(source)) throw new Error(`Unknown base source "${source}"`);
  const { lat, lng } = parseLatLng(input, { requirePakistan: true });
  if (
    source === 'go_online' &&
    current &&
    current.locationSource === 'profile' &&
    !current.autoUpdateBaseOnOnline
  ) {
    return null; // a deliberate pin wins over an automatic sample
  }
  return {
    currentLocation: { type: 'Point', coordinates: [round6(coarsen(lng)), round6(coarsen(lat))] },
    locationSource: source,
    locationUpdatedAt: now,
  };
}

async function setServiceBase(providerId, input, source) {
  const current = await Provider.findById(providerId)
    .select('locationSource autoUpdateBaseOnOnline currentLocation locationUpdatedAt')
    .lean();
  if (!current) throw new Error('Provider not found');
  const set = planBaseWrite(current, input, source);
  if (!set) return { written: false, base: serviceBaseOf(current) };
  await Provider.updateOne({ _id: providerId }, { $set: set });
  return { written: true, base: serviceBaseOf({ ...current, ...set }) };
}

module.exports = { serviceBaseOf, planBaseWrite, setServiceBase };
