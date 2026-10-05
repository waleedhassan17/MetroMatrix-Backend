/**
 * Re-ranking the top of a provider search with the learned model.
 *
 * Stage 1 (MongoDB, cached): $geoNear + the weighted heuristic picks and
 * orders the candidates. Stage 2 (here, per request): the model scores them.
 *
 *   heuristic  stage 1 order, untouched (the default)
 *   shadow     model scores are computed and logged with the impression, but
 *              the heuristic order is served — to measure before switching
 *   blend      alpha·model + (1−alpha)·heuristic
 *   model      model order
 *
 * New providers (fewer than 3 jobs) get a small exploration boost under
 * blend/model, so a model trained on past bookings cannot lock newcomers out.
 * Any failure, or a model slower than the budget, falls back to the heuristic.
 */
const { rawFeatures, toVector, median } = require('./featureSpec');
const { predict } = require('./tfRuntime');

const MODES = ['heuristic', 'shadow', 'blend', 'model'];
const BUDGET_MS = 50;

function withFeatures(items, hasLocation) {
  const medianPrice = median(items.map((p) => Number(p.basePrice) || 0));
  return items.map((p) => ({ p, features: rawFeatures(p, { hasLocation, medianPrice }) }));
}

/**
 * @returns {Promise<{items: object[], rankingSource: string, scored: {features, heuristicScore, modelScore}[]}>}
 */
async function rerank(items, { mode = 'heuristic', blendAlpha = 0.7, explorationBoost = 0.05, model = null, hasLocation }) {
  const rows = withFeatures(items, hasLocation);
  const base = {
    items,
    rankingSource: 'heuristic',
    scored: rows.map((r) => ({ features: r.features, heuristicScore: r.p.matchingScore, modelScore: null })),
  };
  if (mode === 'heuristic' || !model || !items.length) return base;

  let scores;
  try {
    const started = Date.now();
    scores = await Promise.race([
      predict(model.model, rows.map((r) => toVector(r.features, model.spec))),
      new Promise((_, reject) => setTimeout(() => reject(new Error('model over budget')), BUDGET_MS)),
    ]);
    if (Date.now() - started > BUDGET_MS) throw new Error('model over budget');
  } catch (e) {
    return base;
  }

  const scored = rows.map((r, i) => ({ features: r.features, heuristicScore: r.p.matchingScore, modelScore: scores[i] }));
  if (mode === 'shadow') return { ...base, scored, rankingSource: `heuristic (shadow ${model.version})` };

  const a = Math.min(Math.max(Number(blendAlpha) || 0, 0), 1);
  const final = rows.map((r, i) => {
    const m = scores[i] + (r.features.is_new ? explorationBoost : 0);
    const s = mode === 'model' ? m : a * m + (1 - a) * (r.p.matchingScore || 0);
    return { i, s };
  });
  // Stable: equal scores keep the heuristic's order.
  final.sort((x, y) => y.s - x.s || x.i - y.i);
  return {
    items: final.map((f) => ({ ...items[f.i], modelScore: Math.round(scores[f.i] * 1000) / 1000 })),
    scored: final.map((f) => scored[f.i]),
    rankingSource: `model:${model.version}${mode === 'blend' ? ` (blend ${a})` : ''}`,
  };
}

module.exports = { rerank, withFeatures, MODES };
