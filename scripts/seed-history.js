/**
 * Three months of history for the demo accounts — orders, appointments,
 * bookings, wallet activity, reviews — so every history list, dashboard and
 * earnings chart in the app has real content.
 *
 *   primary customer   SEED_USER_EMAIL (kept out of this public repo)
 *   doctor             doctor1.hc@metromatrix.pk        (Dr. Imran Qureshi)
 *   vendor             vendor.outfitters@metromatrix.pk (Outfitters)
 *   home services      provider1.hs@metromatrix.pk      (Ahmad Khan)
 * plus the existing demo customers/patients as the providers' other clients.
 *
 * IDEMPOTENT: every row is recorded in `seed_history_registry` under a stable
 * key, so a re-run creates nothing new (and a run on a later day only adds
 * the days since). Wallet balances move only together with a matching ledger
 * row, so the seed never adds balance/ledger drift — the run ends by proving
 * that for every wallet it touched.
 *
 * Depends on the module seeds (seed:healthcare, seed:homeservice,
 * seed:shopping) having created the providers. NOTE: `seed:shopping` purges
 * every shopping order — re-run this script after it.
 *
 * Flags:
 *   --confirm-db=<db name>   required (scripts/lib/seedSafety.js)
 *   --dry-run                plan and count only; writes nothing
 *   --purge                  remove everything this script created and
 *                            reverse its wallet effects
 *   --only=shopping,healthcare,homeservice
 *   --from=YYYY-MM-DD        window start (default 2026-08-18)
 *
 * Env: SEED_USER_EMAIL (required). SEED_USER_NAME / SEED_USER_PASSWORD /
 * SEED_USER_PHONE are used only if that account does not exist yet.
 *
 * Run: SEED_USER_EMAIL=… node scripts/seed-history.js --confirm-db=<db name>
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { assertSafeSeedTarget } = require('./lib/seedSafety');

const User = require('../src/models/User');
const Provider = require('../src/models/Provider');
const Wallet = require('../src/models/Wallet');
const Brand = require('../src/modules/shopping/models/Brand');
const Product = require('../src/modules/shopping/models/Product');
const Doctor = require('../src/modules/healthcare/models/Doctor');
const Clinic = require('../src/modules/healthcare/models/Clinic');
const { recomputeProviderCounters } = require('../src/modules/homeservice/services/providerCounters');

const { SeedContext, walletDrift, pkt, todayKey, REGISTRY } = require('./lib/history/common');
const { seedShopping, recomputeProductRatings } = require('./lib/history/shopping');
const { seedHealthcare, recomputeDoctorRating } = require('./lib/history/healthcare');
const { seedHomeService } = require('./lib/history/homeservice');

const DOCTOR_EMAIL = 'doctor1.hc@metromatrix.pk';
const VENDOR_EMAIL = 'vendor.outfitters@metromatrix.pk';
const HS_PROVIDER_EMAIL = 'provider1.hs@metromatrix.pk';

const range = (prefix, n, suffix) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}${suffix}`);
const SHOP_CLIENTS = [
  ...range('shopper', 3, '.qa@metromatrix.pk'),
  ...range('user', 3, '@metromatrix.pk'),
  ...range('customer', 8, '.hs@metromatrix.pk'),
  ...range('patient', 5, '.hc@metromatrix.pk'),
];
const HC_CLIENTS = [
  ...range('patient', 5, '.hc@metromatrix.pk'),
  ...range('user', 3, '@metromatrix.pk'),
  ...range('customer', 4, '.hs@metromatrix.pk'),
  'shopper1.qa@metromatrix.pk',
];
const HS_CLIENTS = [
  ...range('customer', 8, '.hs@metromatrix.pk'),
  ...range('user', 3, '@metromatrix.pk'),
  ...range('patient', 2, '.hc@metromatrix.pk'),
];

// Ubaid's wallet top-ups across the window.
const PRIMARY_TOPUPS = [
  ['2026-08-19', '20:15', 20000],
  ['2026-09-15', '19:40', 15000],
  ['2026-10-14', '21:05', 15000],
  ['2026-11-10', '20:30', 10000],
];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const argValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const fail = (msg) => {
  console.error(`\n✋ ${msg}\n`);
  process.exit(1);
};

async function findUsers(emails) {
  const users = await User.find({ email: { $in: emails } }).lean();
  const byEmail = new Map(users.map((u) => [u.email, u]));
  return emails.map((e) => byEmail.get(e)).filter(Boolean);
}

async function resolvePrimary(dryRun) {
  const email = (process.env.SEED_USER_EMAIL || '').trim().toLowerCase();
  if (!email) fail('Set SEED_USER_EMAIL — the primary customer account the history is built around.');
  const existing = await User.findOne({ email }).lean();
  if (existing) return existing;

  const { SEED_USER_NAME: fullName, SEED_USER_PASSWORD: password, SEED_USER_PHONE: phoneNumber } = process.env;
  if (!fullName || !password || !phoneNumber) {
    fail(`${email} does not exist. Set SEED_USER_NAME, SEED_USER_PASSWORD and SEED_USER_PHONE to create it.`);
  }
  if (dryRun) fail(`${email} does not exist — a real run would create it. Re-run without --dry-run.`);
  const user = new User({ email, fullName, phoneNumber, isActive: true, isVerified: true, emailVerified: true });
  user.password = password; // hashed by the pre-save hook
  await user.save();
  console.log(`  created primary customer ${email}`);
  return user.toObject();
}

async function resolveProviders() {
  const [doctorProvider, vendor, hsProvider] = await Promise.all([
    Provider.findOne({ email: DOCTOR_EMAIL }).lean(),
    Provider.findOne({ email: VENDOR_EMAIL }).lean(),
    Provider.findOne({ email: HS_PROVIDER_EMAIL }).lean(),
  ]);
  const missing = [
    !doctorProvider && `${DOCTOR_EMAIL} (npm run seed:healthcare)`,
    !vendor && `${VENDOR_EMAIL} (npm run seed:shopping)`,
    !hsProvider && `${HS_PROVIDER_EMAIL} (npm run seed:homeservice)`,
  ].filter(Boolean);
  if (missing.length) fail(`Missing provider account(s): ${missing.join(', ')}. Run the module seed first.`);

  const doctor = await Doctor.findOne({ providerId: doctorProvider._id }).lean();
  const brand = (await Brand.findOne({ owner: vendor._id, isDeleted: { $ne: true } }).lean()) || (await Brand.findOne({ slug: 'outfitters' }).lean());
  if (!doctor) fail(`${DOCTOR_EMAIL} has no Doctor profile — run npm run seed:healthcare.`);
  if (!brand) fail(`${VENDOR_EMAIL} owns no brand — run npm run seed:shopping.`);
  const clinics = await Clinic.find({ doctorId: doctor._id, isActive: true }).sort({ createdAt: 1 }).limit(2).lean();
  if (!clinics.length) fail(`${DOCTOR_EMAIL} has no active clinic.`);
  return { doctorProvider, doctor, clinics, vendor, brand, hsProvider };
}

async function purge(ctx) {
  const db = mongoose.connection.db;
  const registry = db.collection(REGISTRY);
  const entries = await registry.find({}).toArray();
  if (!entries.length) {
    console.log('Nothing to purge — the registry is empty.');
    return;
  }
  console.log(`Purging ${entries.length} seeded rows…`);

  // 1. Ledger rows: give money back before taking it, so no wallet dips below zero mid-way.
  const ledger = entries.filter((e) => e.kind === 'ledger').sort((a, b) => a.delta - b.delta);
  let reversed = 0;
  for (const e of ledger) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const undo = -e.delta;
        const filter = undo < 0 ? { _id: e.walletId, balance: { $gte: -undo } } : { _id: e.walletId };
        const txn = await db.collection('wallettransactions').findOne({ _id: e.docId }, { session });
        if (txn) {
          const res = await db.collection('wallets').updateOne(filter, { $inc: { balance: undo } }, { session });
          if (!res.modifiedCount) throw new Error(`wallet ${e.walletId} cannot cover reversing ${e._id}`);
          await db.collection('wallettransactions').deleteOne({ _id: e.docId }, { session });
        }
        await registry.deleteOne({ _id: e._id }, { session });
      });
      reversed += 1;
    } catch (err) {
      ctx.warn(`kept ${e._id}: ${err.message}`);
    } finally {
      await session.endSession();
    }
  }
  console.log(`  wallet transactions reversed: ${reversed}/${ledger.length}`);

  // 2. Template slots this seed booked go back to available.
  const booked = entries.filter((e) => e.kind === 'booked');
  for (const e of booked) {
    await db.collection('slots').updateOne({ _id: e.docId, status: 'booked' }, { $set: { status: 'available', bookedCount: 0 } });
    await registry.deleteOne({ _id: e._id });
  }
  console.log(`  slots released: ${booked.length}`);

  // 3. Everything else, per collection.
  const byColl = new Map();
  entries
    .filter((e) => e.kind === 'doc')
    .forEach((e) => {
      if (!byColl.has(e.coll)) byColl.set(e.coll, []);
      byColl.get(e.coll).push(e);
    });
  for (const [coll, list] of byColl) {
    const res = await db.collection(coll).deleteMany({ _id: { $in: list.map((e) => e.docId) } });
    await registry.deleteMany({ _id: { $in: list.map((e) => e._id) } });
    console.log(`  ${coll}: ${res.deletedCount} removed`);
  }

  // 4. Counters that were derived from the removed rows.
  const providers = await resolveProviders();
  await recomputeDoctorRating(providers.doctor._id);
  await recomputeProviderCounters({ _id: providers.hsProvider._id });
  const productIds = (await Product.find({ brandId: providers.brand._id }).select('_id').lean()).map((p) => p._id);
  await recomputeProductRatings(productIds);
  console.log('  doctor rating, provider counters and product ratings recomputed');
}

async function main() {
  assertSafeSeedTarget();
  const dryRun = flag('dry-run');
  const doPurge = flag('purge');
  const only = (argValue('only') || 'shopping,healthcare,homeservice').split(',').map((s) => s.trim());
  const fromKey = argValue('from') || '2026-08-18';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromKey)) fail('--from must be YYYY-MM-DD');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`✓ MongoDB connected${dryRun ? '  (DRY RUN — nothing will be written)' : ''}`);
  const ctx = new SeedContext({ dryRun, now: new Date() });
  await ctx.load();

  if (doPurge) {
    if (dryRun) fail('--purge and --dry-run together: run --purge alone.');
    await purge(ctx);
    ctx.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
    await mongoose.disconnect();
    return;
  }

  const toKey = todayKey();
  console.log(`=== History seed: ${fromKey} → ${toKey} ===`);
  const primary = await resolvePrimary(dryRun);
  const providers = await resolveProviders();
  const [shopClients, hcClients, hsClients] = await Promise.all([findUsers(SHOP_CLIENTS), findUsers(HC_CLIENTS), findUsers(HS_CLIENTS)]);
  console.log(`  primary: ${primary.fullName} · clients found: shop ${shopClients.length}, health ${hcClients.length}, home ${hsClients.length}`);
  const fallback = (list) => (list.length ? list : [primary]);

  // Wallet drift before (balance − ledger), for every wallet this run can touch.
  const ownerIds = [primary, ...shopClients, ...hcClients, ...hsClients].map((u) => u._id);
  const providerIds = [providers.doctorProvider._id, providers.vendor._id, providers.hsProvider._id];
  const walletsBefore = await Wallet.find({
    $or: [{ owner: { $in: ownerIds }, ownerType: 'User' }, { owner: { $in: providerIds }, ownerType: 'Provider' }],
  })
    .select('_id')
    .lean();
  const driftBefore = await walletDrift(walletsBefore.map((w) => w._id));

  // Ubaid's top-ups
  const primaryWallet = await ctx.wallet(primary._id, 'User', 'Ubaid (customer)');
  for (let i = 0; i < PRIMARY_TOPUPS.length; i += 1) {
    const [day, time, amount] = PRIMARY_TOPUPS[i];
    const at = pkt(day, time);
    if (at > ctx.now) continue;
    await ctx.ledger(`wallet:primary:topup:${i + 1}`, primaryWallet, {
      type: 'credit',
      amount,
      source: 'admin_adjustment',
      description: 'Wallet top-up',
      at,
    });
  }

  const results = {};
  if (only.includes('shopping')) {
    console.log('\n— Shopping (Outfitters)');
    results.shopping = await seedShopping(ctx, {
      primary,
      vendor: providers.vendor,
      brand: providers.brand,
      others: fallback(shopClients),
      fromKey,
      toKey,
    });
    console.log(`  orders: Ubaid ${results.shopping.primary}, other customers ${results.shopping.others}`);
  }
  if (only.includes('healthcare')) {
    console.log('\n— Healthcare (Dr. Imran Qureshi)');
    results.healthcare = await seedHealthcare(ctx, {
      primary,
      doctor: providers.doctor,
      clinics: providers.clinics,
      doctorProvider: providers.doctorProvider,
      patients: fallback(hcClients),
      fromKey,
      toKey,
    });
    const h = results.healthcare;
    console.log(`  appointments: Ubaid ${h.primary}, past ${h.past}, upcoming ${h.upcoming}`);
  }
  if (only.includes('homeservice')) {
    console.log('\n— Home services (Ahmad Khan)');
    results.homeservice = await seedHomeService(ctx, {
      primary,
      provider: providers.hsProvider,
      customers: fallback(hsClients),
      fromKey,
      toKey,
    });
    const s = results.homeservice;
    console.log(`  bookings: Ubaid ${s.primary}, past ${s.past}, upcoming ${s.upcoming} · payouts ${s.payouts}`);
  }

  console.log('\n=== Rows ===');
  Object.keys(ctx.stats)
    .sort()
    .forEach((coll) => {
      const { created, skipped } = ctx.stats[coll];
      console.log(`  ${coll.padEnd(26)} ${dryRun ? 'planned' : 'created'} ${String(created).padStart(4)}   already there ${String(skipped).padStart(4)}`);
    });

  // Proof: the seed changed balances only together with ledger rows.
  if (!dryRun) {
    const ids = new Set([...walletsBefore.map((w) => String(w._id)), ...ctx.touchedWallets.keys()]);
    const driftAfter = await walletDrift([...ids]);
    console.log('\n=== Wallets (balance − ledger must not change) ===');
    let bad = 0;
    for (const [id, label] of ctx.touchedWallets) {
      const before = driftBefore.get(id) || { balance: 0, drift: 0 };
      const after = driftAfter.get(id);
      const ok = after && Math.abs(after.drift - before.drift) < 0.01;
      if (!ok) bad += 1;
      console.log(
        `  ${String(label).padEnd(34)} balance ${String(before.balance).padStart(8)} → ${String(after ? after.balance : '?').padStart(8)}   drift ${before.drift} → ${after ? after.drift : '?'}  ${ok ? '✓' : '✗ CHANGED'}`
      );
    }
    for (const id of ids) {
      if (ctx.touchedWallets.has(id)) continue;
      const before = driftBefore.get(id);
      const after = driftAfter.get(id);
      if (before && after && Math.abs(after.drift - before.drift) >= 0.01) bad += 1;
    }
    if (bad) {
      console.error(`\n✗ ${bad} wallet(s) changed drift — investigate before using this data.`);
      process.exitCode = 1;
    } else {
      console.log('  ✓ no wallet gained drift');
    }
  } else {
    console.log('\n=== Wallet balances after a real run (simulated) ===');
    for (const [id, label] of ctx.touchedWallets) console.log(`  ${String(label).padEnd(34)} ${ctx.balances.get(id)}`);
  }

  ctx.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  console.log('\n=== Done ===');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('History seed failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
