/**
 * Writing the interaction log (ml_events).
 *
 * Client batches are untrusted input: every field is whitelisted, truncated
 * and type-checked here, and anything malformed is dropped rather than
 * failing the batch — the app sends these best-effort and never retries.
 */
const mongoose = require('mongoose');
const MlEvent = require('../models/MlEvent');

const MAX_BATCH = 50;
const META_KEYS = ['position', 'searchId', 'context', 'screen', 'category', 'score'];
const FEATURE_LIMIT = 40; // numeric features per impression

function cleanString(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.trim().slice(0, max);
  return s || null;
}

function cleanMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const out = {};
  for (const key of META_KEYS) {
    const v = meta[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'string' && v.length <= 64) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanFeatures(features) {
  if (!features || typeof features !== 'object' || Array.isArray(features)) return undefined;
  const out = {};
  let n = 0;
  for (const [key, v] of Object.entries(features)) {
    if (n >= FEATURE_LIMIT) break;
    if (/^[a-z][a-z0-9_]{0,31}$/i.test(key) && typeof v === 'number' && Number.isFinite(v)) {
      out[key] = v;
      n += 1;
    }
  }
  return n ? out : undefined;
}

/**
 * Normalise one raw event. Returns null when it cannot be stored.
 * `actor` is { userId, role } from the verified token (or nulls).
 */
function sanitizeEvent(raw, actor = {}, now = new Date()) {
  if (!raw || typeof raw !== 'object') return null;
  if (!MlEvent.MODULES.includes(raw.module)) return null;
  if (!MlEvent.TYPES.includes(raw.type)) return null;

  let ts = now;
  if (raw.ts) {
    const t = new Date(raw.ts);
    // Accept client clocks within the last day; anything else gets server time.
    if (!Number.isNaN(t.getTime()) && t <= now && now - t < 24 * 60 * 60 * 1000) ts = t;
  }

  const refId = cleanString(raw.refId, 64);
  return {
    userId: actor.userId && mongoose.isValidObjectId(actor.userId) ? actor.userId : null,
    role: actor.role || null,
    module: raw.module,
    type: raw.type,
    refId,
    query: cleanString(raw.query, 120),
    meta: cleanMeta(raw.meta),
    features: raw.type === 'impression' ? cleanFeatures(raw.features) : undefined,
    source: 'app',
    ts,
  };
}

async function recordEvents(rawEvents, actor) {
  const list = Array.isArray(rawEvents) ? rawEvents.slice(0, MAX_BATCH) : [];
  const docs = list.map((e) => sanitizeEvent(e, actor)).filter(Boolean);
  if (!docs.length) return 0;
  await MlEvent.insertMany(docs, { ordered: false });
  return docs.length;
}

/**
 * Server-side event at a moment that matters (booking created, order placed…).
 * Fire-and-forget: never throws, never delays the caller's response.
 */
function recordServerEvent({ userId, role = 'user', module, type, refId, meta }) {
  setImmediate(() => {
    MlEvent.create({
      userId: userId || null,
      role,
      module,
      type,
      refId: refId ? String(refId) : null,
      meta: cleanMeta(meta),
      source: 'server',
    }).catch((err) => console.warn('[ml] event not recorded:', err.message));
  });
}

module.exports = { sanitizeEvent, recordEvents, recordServerEvent, MAX_BATCH };
