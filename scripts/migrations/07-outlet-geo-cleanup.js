/**
 * 07 — outlets without coordinates carry no GeoJSON point (Oct 2026).
 *
 * The Outlet schema used to default geo.type to 'Point', so every outlet saved
 * without coordinates stored { geo: { type: 'Point' } } — a point with no
 * coordinates. The 2dsphere index on geo cannot read that: creating such an
 * outlet failed once the index existed, and building the index
 * (scripts/sync-indexes.js) fails over documents already stored that way.
 *
 * This unsets geo on outlets whose point has no coordinates. Outlets with real
 * coordinates are untouched; the schema no longer writes the empty point.
 *
 * Idempotent: a second run finds nothing to change. Run it BEFORE sync-indexes.
 * Rollback: none needed — the removed field held no data.
 */
const { runMigration } = require('./lib');
const Outlet = require('../../src/modules/shopping/models/Outlet');

const EMPTY_POINT = {
  geo: { $exists: true },
  $or: [{ 'geo.coordinates': { $exists: false } }, { 'geo.coordinates': { $size: 0 } }, { 'geo.coordinates': null }],
};

async function up({ dry, log = () => {} }) {
  const outlets = Outlet.collection;
  const count = await outlets.countDocuments(EMPTY_POINT);
  if (!dry && count) await outlets.updateMany(EMPTY_POINT, { $unset: { geo: '' } });
  log(`outlets with an empty GeoJSON point: ${count}`);
  return { emptyPoints: count };
}

if (require.main === module) runMigration('07-outlet-geo-cleanup', up);

module.exports = { up, EMPTY_POINT };
