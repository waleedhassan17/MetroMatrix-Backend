/**
 * Location data hygiene — a dry run unless you pass --apply.
 *
 * Two schema defaults used to stand in for "unknown location": Lahore centre
 * on every provider and every saved address. Search treated them as real, so
 * every customer with a saved address was matched from the city centre and
 * every provider who never set a base looked a few hundred metres away.
 *
 * Steps (each reports what it would do, and does it only with --apply):
 *   1. Saved addresses still at the Lahore placeholder (and never located on
 *      purpose) → [0, 0], the "not located" placeholder. The app then asks the
 *      customer to pin the address the next time they book.
 *   2. Home-service providers written before `locationSource` existed:
 *        - a real (non-placeholder) point  → source 'seed' (demo data);
 *        - the placeholder + a known city → that city's centroid, source 'city'
 *          (search shows an approximate "~" distance);
 *        - the placeholder, no known city → source 'default' (distance unknown).
 *      Providers who already have a source are left alone.
 *   3. Report clinics still at [0, 0] — doctors who never placed their clinic.
 *      They cannot be fixed here; they are simply excluded from "nearest".
 * Historical bookings are not touched.
 *
 * Run:  node scripts/geo-hygiene.js            (dry run)
 *       node scripts/geo-hygiene.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Provider = require('../src/models/Provider');
const SavedAddress = require('../src/modules/homeservice/models/SavedAddress');
const Clinic = require('../src/modules/healthcare/models/Clinic');
const { LAHORE_CENTRE, centroidFor } = require('../src/modules/homeservice/services/geo');

const APPLY = process.argv.includes('--apply');
const say = (m) => console.log(`  ${m}`);

const placeholder = { 'coordinates.coordinates': LAHORE_CENTRE };

async function addresses() {
  console.log('\n1. Saved addresses at the Lahore placeholder');
  const filter = { ...placeholder, coordinatesSource: { $in: [null, undefined] } };
  const n = await SavedAddress.countDocuments(filter);
  say(`${n} address(es) ${APPLY ? 'reset' : 'would be reset'} to "not located"`);
  if (APPLY && n) {
    await SavedAddress.updateMany(filter, { $set: { 'coordinates.coordinates': [0, 0], coordinatesSource: null } });
  }
}

async function providers() {
  console.log('\n2. Home-service provider service bases');
  const rows = await Provider.find({ providerType: 'home_service', locationSource: { $exists: false } })
    .select('_id fullName city address currentLocation')
    .lean();
  const counts = { seed: 0, city: 0, default: 0 };
  for (const p of rows) {
    const c = (p.currentLocation && p.currentLocation.coordinates) || [];
    const isPlaceholder = c.length === 2 && c[0] === LAHORE_CENTRE[0] && c[1] === LAHORE_CENTRE[1];
    let set;
    if (c.length === 2 && !isPlaceholder) {
      set = { locationSource: 'seed' };
    } else {
      const centroid = centroidFor(p.city || (p.address && p.address.city));
      set = centroid
        ? { locationSource: 'city', currentLocation: { type: 'Point', coordinates: centroid } }
        : { locationSource: 'default' };
    }
    counts[set.locationSource] += 1;
    if (APPLY) await Provider.updateOne({ _id: p._id }, { $set: set });
  }
  const verb = APPLY ? 'marked' : 'would be marked';
  say(`${rows.length} provider(s) without a location source:`);
  say(`  ${counts.seed} ${verb} 'seed' (real demo point)`);
  say(`  ${counts.city} ${verb} 'city' (city centroid, approximate distance)`);
  say(`  ${counts.default} ${verb} 'default' (distance unknown until they set a base)`);
}

async function clinics() {
  console.log('\n3. Clinics without a location');
  const n = await Clinic.countDocuments({ isActive: true, 'location.coordinates': [0, 0] });
  say(`${n} active clinic(s) at [0, 0] — excluded from "nearest" until the doctor places them`);
}

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  console.log(APPLY ? 'APPLYING location hygiene' : 'DRY RUN — nothing will be written (pass --apply)');
  await addresses();
  await providers();
  await clinics();
  await mongoose.disconnect();
  console.log('\nDone.');
})().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
