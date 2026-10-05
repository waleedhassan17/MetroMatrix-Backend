/**
 * The provider-matching model the API serves, if any.
 *
 * Source of truth: the newest ml_model_registry row for the task with status
 * 'active' (set by the training job's gates, or by an admin's recorded demo
 * activation), its artifact, and its feature spec. Before a model is used it
 * must reproduce the training job's parity fixtures to 1e-4 — a model that
 * disagrees with scikit-learn is quarantined, never served.
 *
 * Kept in memory per serverless instance; the active version is re-checked at
 * most every RECHECK_MS (shared through Redis), so an activation or a nightly
 * retrain reaches every instance within minutes without a redeploy.
 */
const { withRedis, k } = require('../../../lib/redis');
const { modelFromArtifact, predict } = require('./tfRuntime');
const { toVector, FEATURES } = require('./featureSpec');

const TASK = 'provider_matching';
const RECHECK_MS = 5 * 60 * 1000;
const QUARANTINE_MS = 10 * 60 * 1000;
const PARITY_TOL = 1e-4;

let current = null; // { version, model, spec, loadedAt }
let lastCheck = 0;
let loading = null;
const quarantined = new Map(); // version -> until
const status = { lastError: null, lastVersion: null };

async function activeRegistryRow() {
  const cached = await withRedis((r) => r.get(k('ml', 'active', TASK)), null);
  const MlModelRegistry = require('../models/MlModelRegistry');
  if (cached && typeof cached === 'string') {
    if (cached === 'none') return null;
    const row = await MlModelRegistry.findOne({ task: TASK, version: cached }).lean();
    if (row && row.status === 'active') return row;
  }
  const row = await MlModelRegistry.findOne({ task: TASK, status: 'active' }).sort({ createdAt: -1 }).lean();
  withRedis((r) => r.set(k('ml', 'active', TASK), row ? row.version : 'none', { ex: 300 }));
  return row;
}

/** Reproduce the training job's own predictions before trusting the export. */
async function parityCheck(model, spec, fixtures) {
  if (!Array.isArray(fixtures) || !fixtures.length) return { ok: false, reason: 'no parity fixtures' };
  const vectors = fixtures.map((f) => {
    const named = Object.fromEntries((spec.names || FEATURES).map((n, i) => [n, f.raw[i]]));
    return toVector(named, spec);
  });
  const scores = await predict(model, vectors);
  const worst = Math.max(...scores.map((s, i) => Math.abs(s - fixtures[i].p)));
  return worst <= PARITY_TOL ? { ok: true, worst } : { ok: false, reason: `parity off by ${worst.toExponential(2)}` };
}

async function loadFromRow(row) {
  const MlModelArtifact = require('../models/MlModelArtifact');
  const artifact = row.artifactId
    ? await MlModelArtifact.findById(row.artifactId).lean()
    : await MlModelArtifact.findOne({ task: TASK, version: row.version }).lean();
  if (!artifact) throw new Error(`artifact for ${row.version} not found`);
  const model = await modelFromArtifact(artifact);
  const parity = await parityCheck(model, row.featureSpec || {}, row.parityFixtures);
  if (!parity.ok) throw new Error(parity.reason);
  return { version: row.version, model, spec: row.featureSpec, loadedAt: Date.now() };
}

async function refresh() {
  lastCheck = Date.now();
  const row = await activeRegistryRow();
  if (!row) {
    current = null;
    return null;
  }
  if (current && current.version === row.version) return current;
  const until = quarantined.get(row.version);
  if (until && until > Date.now()) return current;
  try {
    current = await loadFromRow(row);
    status.lastVersion = row.version;
    status.lastError = null;
  } catch (e) {
    quarantined.set(row.version, Date.now() + QUARANTINE_MS);
    status.lastError = { version: row.version, message: e.message, at: new Date().toISOString() };
    console.error(`[ml] model ${row.version} not served: ${e.message}`);
  }
  return current;
}

/**
 * The model if it is loaded and ready NOW — never awaited on a request path
 * beyond what is already in memory. A cold instance kicks off the load and
 * answers with the heuristic this time.
 */
function getModelNonBlocking() {
  if (Date.now() - lastCheck > RECHECK_MS && !loading) {
    loading = refresh()
      .catch((e) => {
        status.lastError = { message: e.message, at: new Date().toISOString() };
      })
      .finally(() => {
        loading = null;
      });
  }
  return current;
}

/** For tests and admin "refresh": load synchronously. */
async function getModel({ force = false } = {}) {
  if (force) lastCheck = 0;
  if (Date.now() - lastCheck > RECHECK_MS) await refresh();
  return current;
}

async function invalidate() {
  lastCheck = 0;
  await withRedis((r) => r.del(k('ml', 'active', TASK)), null);
}

function __setForTests(value) {
  current = value;
  lastCheck = value ? Date.now() : 0;
  quarantined.clear();
}

module.exports = { getModel, getModelNonBlocking, invalidate, parityCheck, status, __setForTests, TASK };
