/**
 * Geography helpers for discovery and tracking — pure, no database.
 *
 * Two placeholder points exist in stored data and must never be mistaken for
 * a real place:
 *   - LAHORE_CENTRE: the schema default every provider and every saved
 *     address used to get when none was supplied. Treating it as real is what
 *     made every customer "search from the city centre" and every unlocated
 *     provider look 0 km away.
 *   - [0, 0]: the booking schema's default (a valid GeoJSON point, so the
 *     2dsphere index accepts it) — in the Gulf of Guinea, never a customer.
 */

const LAHORE_CENTRE = [74.3587, 31.5204]; // [lng, lat]

/** Rough Pakistan bounding box — base locations outside it are rejected. */
const PK_BOUNDS = { minLat: 23.5, maxLat: 37.1, minLng: 60.8, maxLng: 77.9 };

/** City centroids used when a provider has a city but no pinned base. */
const CITY_CENTROIDS = {
  lahore: [74.3587, 31.5204],
  karachi: [67.0011, 24.8607],
  islamabad: [73.0479, 33.6844],
  rawalpindi: [73.0169, 33.5651],
  faisalabad: [73.135, 31.4504],
  multan: [71.5249, 30.1575],
  peshawar: [71.5249, 34.0151],
  gujranwala: [74.1883, 32.1877],
  sialkot: [74.5229, 32.4945],
  quetta: [66.975, 30.1798],
  hyderabad: [68.3737, 25.396],
  bahawalpur: [71.6833, 29.3956],
  sargodha: [72.6861, 32.0836],
};

/** Base locations are stored rounded to this many degrees (~500 m). */
const BASE_GRID_DEG = 0.005;

function pointOf(geo) {
  const c = geo && Array.isArray(geo.coordinates) ? geo.coordinates : null;
  if (!c || c.length !== 2) return null;
  const [lng, lat] = c.map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lng, lat];
}

function samePoint(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

/**
 * Is this GeoJSON point a real place? False for missing/malformed points,
 * [0, 0], and the legacy Lahore-centre default.
 */
function isRealPoint(geo) {
  const p = pointOf(geo);
  if (!p) return false;
  if (p[0] === 0 && p[1] === 0) return false;
  if (samePoint(p, LAHORE_CENTRE)) return false;
  return true;
}

/** { latitude, longitude } for a real point, else null. */
function latLngOrNull(geo) {
  if (!isRealPoint(geo)) return null;
  const [lng, lat] = pointOf(geo);
  return { latitude: lat, longitude: lng };
}

function inPakistan(lat, lng) {
  return (
    lat >= PK_BOUNDS.minLat && lat <= PK_BOUNDS.maxLat && lng >= PK_BOUNDS.minLng && lng <= PK_BOUNDS.maxLng
  );
}

/** Round to the base grid — a provider's base is an area, never their doorstep. */
function coarsen(value, step = BASE_GRID_DEG) {
  return Math.round(Number(value) / step) * step;
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Validate a client-supplied { latitude, longitude }.
 * Returns { lat, lng } or throws an Error with a message fit to show.
 */
function parseLatLng(input, { requirePakistan = false } = {}) {
  const lat = Number(input && (input.latitude ?? input.lat));
  const lng = Number(input && (input.longitude ?? input.lng));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error('A valid latitude and longitude are required');
  }
  if (lat === 0 && lng === 0) throw new Error('A valid latitude and longitude are required');
  if (requirePakistan && !inPakistan(lat, lng)) {
    throw new Error('That location is outside the area MetroMatrix serves');
  }
  return { lat, lng };
}

function centroidFor(city) {
  const key = String(city || '').trim().toLowerCase();
  return CITY_CENTROIDS[key] || null;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

module.exports = {
  LAHORE_CENTRE,
  CITY_CENTROIDS,
  BASE_GRID_DEG,
  PK_BOUNDS,
  pointOf,
  isRealPoint,
  latLngOrNull,
  inPakistan,
  coarsen,
  round6,
  parseLatLng,
  centroidFor,
  haversineMeters,
};
