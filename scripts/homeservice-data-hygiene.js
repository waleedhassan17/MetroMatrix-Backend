/**
 * Home Services demo-data hygiene — a dry run unless you pass --apply.
 *
 * What a customer browsing the demo used to see: "Wallet Smoke Provider" in the
 * electrician list, six copies of "Smoke test review" on the first provider,
 * an "Appliance Technicians" tile that opened an empty list, profiles reading
 * "4.9 ★ (132 reviews)" above no reviews at all, and provider dashboards full
 * of requests from July that nobody could answer any more. None of it was a
 * code bug on its own — it was test traffic and made-up seed numbers left in
 * the shared database — but every item reads to a customer as a broken app.
 *
 * Steps (each reports what it would do, and does it only with --apply):
 *   1. Hide test/QA provider accounts from customer search (hideFromSearch).
 *      Nothing is deleted; the test harnesses still log in as them.
 *   2. Replace the seed's machine-made trade label "Ac repairer".
 *   3. Delete "Smoke test review" reviews.
 *   4. Deactivate service categories provider search cannot filter.
 *   5. Close bookings whose time passed long ago (the expiry rules in
 *      services/expiryService.js), silently — no notifications about months-
 *      old test bookings.
 *   6. Recompute every provider's rating, review count and job counters from
 *      the reviews and bookings that actually exist.
 *
 * --qa-cleanup additionally removes what scripts/e2e-homeservice.js left
 * behind: its reviews and notifications, and any of its bookings still open.
 * Bookings that moved money stay, with their ledger entries, so the wallet
 * reconciliation (scripts/wallet-reconcile-repair.js --dry) still balances.
 *
 * Run:  node scripts/homeservice-data-hygiene.js              (dry run)
 *       node scripts/homeservice-data-hygiene.js --apply
 *       node scripts/homeservice-data-hygiene.js --apply --qa-cleanup
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Provider = require('../src/models/Provider');
const ServiceCategory = require('../src/modules/homeservice/models/ServiceCategory');
const ProviderReview = require('../src/modules/homeservice/models/ProviderReview');
const HSNotification = require('../src/modules/homeservice/models/HSNotification');
const Booking = require('../src/modules/homeservice/models/Booking');
const Dispute = require('../src/modules/homeservice/models/Dispute');
const PayoutRequest = require('../src/modules/homeservice/models/PayoutRequest');
const { CATEGORY_TO_SUBTYPE } = require('../src/modules/homeservice/services/serializers');
const { STATUS, ACTIVE_STATUSES } = require('../src/modules/homeservice/services/statusMap');
const { expireStale, RULES } = require('../src/modules/homeservice/services/expiryService');
const { recomputeProviderCounters } = require('../src/modules/homeservice/services/providerCounters');

const APPLY = process.argv.includes('--apply');
const QA_CLEANUP = process.argv.includes('--qa-cleanup');

/** Accounts that exist for testing, not for customers to book. */
const TEST_PROVIDER_EMAILS = [
  'wallet-smoke-provider@metromatrix.pk',
  'smoke-provider@example.com',
  'umaisroy@gmail.com', // "Ubaidmistri" — a team test account
];
const TEST_REVIEW_TEXT = /^\s*smoke test review\s*$/i;
const QA_TAG = /\[QA-E2E/;

const say = (m) => console.log(`  ${m}`);
const head = (m) => console.log(`\n${m}`);
const act = async (fn) => (APPLY ? fn() : null);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`=== Home Services data hygiene — ${APPLY ? 'APPLYING' : 'dry run (pass --apply to write)'} ===`);

  // 1. Test accounts out of customer search
  head('1. Test provider accounts');
  const toHide = await Provider.find({
    providerType: 'home_service',
    hideFromSearch: { $ne: true },
    $or: [
      { email: { $in: TEST_PROVIDER_EMAILS } },
      { providerSubType: { $exists: false } },
      { providerSubType: null },
    ],
  }).select('email fullName');
  toHide.forEach((p) => say(`hide from search: ${p.fullName} <${p.email}>`));
  if (!toHide.length) say('none to hide');
  await act(() =>
    Provider.updateMany({ _id: { $in: toHide.map((p) => p._id) } }, { $set: { hideFromSearch: true } })
  );

  // 2. Trade labels
  head('2. Trade labels');
  const badLabels = await Provider.find({
    providerType: 'home_service',
    profession: { $regex: /^ac[ _]repairer$/i },
  }).select('fullName profession');
  badLabels.forEach((p) => say(`${p.fullName}: "${p.profession}" → "AC Technician"`));
  if (!badLabels.length) say('all labels fine');
  await act(() =>
    Provider.updateMany({ _id: { $in: badLabels.map((p) => p._id) } }, { $set: { profession: 'AC Technician' } })
  );

  // 3. Test reviews
  head('3. Test reviews');
  const junkReviews = await ProviderReview.find({ comment: { $regex: TEST_REVIEW_TEXT } }).select('_id provider');
  say(`${junkReviews.length} "Smoke test review" review(s)`);
  await act(() => ProviderReview.deleteMany({ _id: { $in: junkReviews.map((r) => r._id) } }));

  // 4. Categories search cannot serve
  head('4. Service categories');
  const unmapped = await ServiceCategory.find({
    isActive: true,
    slug: { $nin: Object.keys(CATEGORY_TO_SUBTYPE) },
  }).select('slug name');
  unmapped.forEach((c) => say(`deactivate: ${c.name} (${c.slug})`));
  if (!unmapped.length) say('all active categories are searchable');
  await act(() =>
    ServiceCategory.updateMany({ _id: { $in: unmapped.map((c) => c._id) } }, { $set: { isActive: false } })
  );

  // 5. Stale bookings
  head('5. Bookings whose time has passed');
  const now = new Date();
  for (const rule of RULES) {
    const n = await Booking.countDocuments({
      status: rule.from,
      scheduledFor: { $lt: new Date(now.getTime() - rule.graceMs) },
    });
    say(`${n} ${rule.from} booking(s) past their grace period → CANCELLED (${rule.code})`);
  }
  if (APPLY) {
    let closed = 0;
    let round;
    do {
      round = await expireStale({}, new Date(), { announce: false });
      closed += round;
    } while (round > 0);
    say(`closed ${closed}`);
  }

  // Optional: what the E2E harness left behind
  if (QA_CLEANUP) {
    head('QA harness leftovers');
    const tagged = await Booking.find({ instructions: { $regex: QA_TAG } }).select('_id status payment.status');
    const ids = tagged.map((b) => b._id);
    const open = tagged.filter((b) => ACTIVE_STATUSES.includes(b.status));
    const qaReviews = await ProviderReview.countDocuments({ booking: { $in: ids } });
    const qaNotes = await HSNotification.countDocuments({ 'data.bookingId': { $in: ids.map(String) } });
    const qaDisputes = await Dispute.countDocuments({ booking: { $in: ids } });
    const qaPayouts = await PayoutRequest.countDocuments({
      'accountDetails.reference': { $regex: QA_TAG },
      status: 'pending',
    });
    say(
      `${tagged.length} tagged booking(s): ${open.length} still open, ${qaReviews} review(s), ` +
        `${qaNotes} notification(s), ${qaDisputes} dispute(s), ${qaPayouts} pending payout request(s)`
    );
    await act(async () => {
      await ProviderReview.deleteMany({ booking: { $in: ids } });
      await HSNotification.deleteMany({ 'data.bookingId': { $in: ids.map(String) } });
      await Dispute.deleteMany({ booking: { $in: ids } });
      await PayoutRequest.deleteMany({ 'accountDetails.reference': { $regex: QA_TAG }, status: 'pending' });
      const at = new Date();
      await Booking.updateMany(
        { _id: { $in: open.map((b) => b._id) }, status: { $in: ACTIVE_STATUSES } },
        {
          $set: {
            status: STATUS.CANCELLED,
            cancellation: { by: 'system', reason: 'QA run finished', at, code: 'qa_cleanup' },
          },
          $push: {
            statusHistory: {
              status: STATUS.CANCELLED,
              changedBy: { id: null, role: 'system' },
              changedAt: at,
              note: 'QA run finished',
            },
          },
          $inc: { __v: 1 },
        }
      );
    });
  }

  // 6. Counters from real records (after the deletions above)
  head('6. Provider ratings and job counters');
  const changes = await recomputeProviderCounters({ providerType: 'home_service' }, { dryRun: !APPLY });
  changes.forEach((c) =>
    say(
      `${c.name.padEnd(22)} ★ ${c.before.average} (${c.before.count}) → ${c.after.average} (${c.after.count})` +
        `   jobs ${c.before.completed}/${c.before.total} → ${c.after.completed}/${c.after.total}`
    )
  );
  if (!changes.length) say('all counters already match');
  if (!APPLY && junkReviews.length) say('(dry run: counts above still include the test reviews step 3 would delete)');

  console.log(`\n${APPLY ? 'Done.' : 'Dry run complete — nothing was written.'}`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
