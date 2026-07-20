/**
 * Home Services module seed — realistic demo dataset. IDEMPOTENT: every
 * entity is upserted by a stable natural key (email, category slug, seeded
 * booking marker), so running twice never duplicates.
 *
 * Creates:
 *   - 4 service categories (electricians, plumbers, ac-repairers + one extra
 *     to prove the catalogue is genuinely data, not the old hardcoded enum)
 *   - 15 approved home-service providers across them at real Lahore
 *     coordinates, varied ratings and online states
 *   - 8 customers with saved addresses and wallet balances
 *   - 25 bookings covering EVERY status in the state machine, including
 *     cancellations at different stages
 *   - chat threads on active bookings, reviews on completed ones
 *   - 2 open disputes, 3 pending payout requests, matching wallet transactions
 *
 * Run: node scripts/seed-homeservice.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../src/models/User');
const Provider = require('../src/models/Provider');
const WalletService = require('../src/services/walletService');

const Booking = require('../src/modules/homeservice/models/Booking');
const SavedAddress = require('../src/modules/homeservice/models/SavedAddress');
const ServiceCategory = require('../src/modules/homeservice/models/ServiceCategory');
const ChatMessage = require('../src/modules/homeservice/models/ChatMessage');
const ProviderReview = require('../src/modules/homeservice/models/ProviderReview');
const Dispute = require('../src/modules/homeservice/models/Dispute');
const PayoutRequest = require('../src/modules/homeservice/models/PayoutRequest');
const { STATUS } = require('../src/modules/homeservice/services/statusMap');

const log = (m) => console.log(`  ${m}`);
const DAY = 86400000;

const CATEGORIES = [
  ['Electricians', 'electricians', 'electrician', 'flash-outline', 'ELECTRICAL', '#F59E0B', 500],
  ['Plumbers', 'plumbers', 'plumber', 'water-outline', 'PLUMBING', '#3B82F6', 450],
  ['AC Repairers', 'ac-repairers', 'ac_repairer', 'snow-outline', 'AC REPAIR', '#06B6D4', 600],
  // Extra category on the SAME 'electrician' provider pool — proves the
  // catalogue is data-driven (HS5), not the old hardcoded 3-value enum.
  ['Appliance Technicians', 'appliance-technicians', 'electrician', 'construct-outline', 'APPLIANCE', '#8B5CF6', 550],
];

const LAHORE = [
  ['Gulberg III', 31.509, 74.3444],
  ['DHA Phase 5', 31.4697, 74.4077],
  ['Model Town', 31.4833, 74.3231],
  ['Johar Town', 31.4676, 74.2665],
  ['Bahria Town', 31.368, 74.1826],
  ['Wapda Town', 31.4308, 74.2708],
];

// [name, subType, basePrice, experience, ratingAvg, ratingCount, isOnline]
const PROVIDERS = [
  ['Ahmad Khan', 'electrician', 500, '5 years', 4.8, 62, true],
  ['Bilal Ahmed', 'electrician', 450, '3 years', 4.3, 28, true],
  ['Usman Tariq', 'electrician', 600, '8 years', 4.9, 110, false],
  ['Hassan Raza', 'electrician', 400, '2 years', 3.9, 14, true],
  ['Fahad Malik', 'electrician', 550, '6 years', 4.6, 71, false],
  ['Usman Ali', 'plumber', 450, '4 years', 4.5, 45, true],
  ['Kashif Iqbal', 'plumber', 500, '7 years', 4.7, 88, true],
  ['Zeeshan Butt', 'plumber', 400, '2 years', 4.0, 19, false],
  ['Adnan Sheikh', 'plumber', 480, '5 years', 4.4, 53, true],
  ['Waqas Nawaz', 'plumber', 520, '9 years', 4.9, 132, false],
  ['Imran Yousuf', 'ac_repairer', 600, '6 years', 4.7, 76, true],
  ['Tariq Javed', 'ac_repairer', 550, '4 years', 4.2, 33, true],
  ['Salman Farooq', 'ac_repairer', 700, '10 years', 4.9, 145, false],
  ['Noman Aslam', 'ac_repairer', 500, '1 year', 3.7, 8, true],
  ['Rizwan Chaudhry', 'ac_repairer', 620, '5 years', 4.5, 60, false],
];

const CUSTOMERS = [
  ['customer1.hs@metromatrix.pk', 'Sarah Malik', '03008880001'],
  ['customer2.hs@metromatrix.pk', 'Ali Khan', '03008880002'],
  ['customer3.hs@metromatrix.pk', 'Maria Javed', '03008880003'],
  ['customer4.hs@metromatrix.pk', 'Ahmed Raza', '03008880004'],
  ['customer5.hs@metromatrix.pk', 'Kiran Butt', '03008880005'],
  ['customer6.hs@metromatrix.pk', 'Danish Iqbal', '03008880006'],
  ['customer7.hs@metromatrix.pk', 'Hina Sheikh', '03008880007'],
  ['customer8.hs@metromatrix.pk', 'Omar Farooq', '03008880008'],
];

/**
 * 25 bookings covering the full lifecycle. `n` is the seed marker
 * (SEED-HS-nn in instructions). Each entry: target canonical status +
 * whether it should carry chat/review/dispute/payment extras.
 */
const BOOKING_PLAN = [
  // Terminal: COMPLETED, paid, reviewed (10)
  ...Array.from({ length: 10 }, (_, i) => ({
    n: i + 1,
    status: STATUS.COMPLETED,
    paid: true,
    review: i < 8,
  })),
  // Terminal: COMPLETED, unpaid (2) — payment screen still pending
  { n: 11, status: STATUS.COMPLETED, paid: false },
  { n: 12, status: STATUS.COMPLETED, paid: false, requested: true },
  // Active mid-lifecycle (5) — with chat threads
  { n: 13, status: STATUS.PENDING, chat: false },
  { n: 14, status: STATUS.ACCEPTED, chat: true },
  { n: 15, status: STATUS.EN_ROUTE, chat: true },
  { n: 16, status: STATUS.ARRIVED, chat: true },
  { n: 17, status: STATUS.IN_PROGRESS, chat: true },
  // Cancellations at different stages (5)
  { n: 18, status: STATUS.CANCELLED, cancelFrom: STATUS.PENDING, by: 'customer' },
  { n: 19, status: STATUS.CANCELLED, cancelFrom: STATUS.ACCEPTED, by: 'customer' },
  { n: 20, status: STATUS.CANCELLED, cancelFrom: STATUS.EN_ROUTE, by: 'customer' },
  { n: 21, status: STATUS.REJECTED, by: 'provider' },
  { n: 22, status: STATUS.CANCELLED, cancelFrom: STATUS.ARRIVED, by: 'customer' },
  // More pending/upcoming to fill out the provider job lists (3)
  { n: 23, status: STATUS.PENDING },
  { n: 24, status: STATUS.ACCEPTED, futureDays: 3 },
  { n: 25, status: STATUS.ACCEPTED, futureDays: 6 },
];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected\n=== Home Services seed ===');

  // 1. Service categories
  const catBySlug = {};
  for (let i = 0; i < CATEGORIES.length; i += 1) {
    const [name, slug, providerSubType, icon, badge, badgeColor, basePrice] = CATEGORIES[i];
    let cat = await ServiceCategory.findOne({ slug });
    if (!cat) {
      cat = await ServiceCategory.create({
        name,
        slug,
        providerSubType,
        icon,
        badge,
        badgeColor,
        description: `Professional ${name.toLowerCase()} services`,
        basePrice,
        isActive: true,
        sortOrder: i,
      });
    }
    catBySlug[slug] = cat;
  }
  log(`service categories ready: ${CATEGORIES.length}`);

  // 2. Providers
  const providers = [];
  for (let i = 0; i < PROVIDERS.length; i += 1) {
    const [fullName, subType, basePrice, experience, ratingAvg, ratingCount, isOnline] =
      PROVIDERS[i];
    const email = `provider${i + 1}.hs@metromatrix.pk`;
    const spot = LAHORE[i % LAHORE.length];

    let provider = await Provider.findOne({ email });
    if (!provider) {
      provider = await Provider.create({
        email,
        password: 'Provider@123',
        fullName,
        phoneNumber: `030099900${String(i + 1).padStart(2, '0')}`,
        providerType: 'home_service',
        providerSubType: subType,
        profession: `${subType[0].toUpperCase()}${subType.slice(1).replace('_', ' ')}`,
        experience,
        briefDescription: `${fullName} is an experienced ${subType.replace('_', ' ')} serving Lahore.`,
        basePrice,
        city: 'Lahore',
        serviceAreas: [spot[0]],
        emailVerified: 'active',
        adminVerified: 'active',
        status: 'approved',
        onboardingStatus: 'approved',
        isVerified: true,
        isActive: true,
        isAvailable: true,
        isOnline,
        serviceRadius: 15,
        currentLocation: { type: 'Point', coordinates: [spot[2], spot[1]] },
        ratings: { average: ratingAvg, count: ratingCount },
        totalBookings: ratingCount,
        completedBookings: Math.round(ratingCount * 0.9),
      });
    } else if (provider.adminVerified !== 'active') {
      provider.adminVerified = 'active';
      provider.emailVerified = 'active';
      provider.isActive = true;
      await provider.save();
    }
    providers.push(provider);
  }
  log(`providers ready: ${providers.length} across ${new Set(PROVIDERS.map((p) => p[1])).size} sub-types (Lahore-located, varied ratings + online states)`);

  // 3. Customers with saved addresses + wallet balances
  const customers = [];
  for (const [email, fullName, phoneNumber] of CUSTOMERS) {
    let user = await User.findOne({ email }).select('+password');
    if (!user) {
      user = new User({ email, fullName, phoneNumber, isActive: true, isEmailVerified: true });
      user.password = '123456';
      await user.save();
    }
    const wallet = await WalletService.getOrCreateWallet(user._id, 'User');
    if (wallet.balance < 10000) {
      const amount = 30000 - wallet.balance;
      await wallet.credit(amount);
      await WalletService.recordTransaction(wallet._id, {
        type: 'credit',
        amount,
        description: 'Seed top-up for home-services demo',
        source: 'admin_adjustment',
        status: 'completed',
      });
    }

    const existingAddr = await SavedAddress.findOne({ user: user._id });
    if (!existingAddr) {
      const spot = LAHORE[customers.length % LAHORE.length];
      await SavedAddress.create({
        user: user._id,
        label: 'Home',
        line1: `House ${10 + customers.length}, ${spot[0]}`,
        city: 'Lahore',
        icon: 'home',
        isDefault: true,
        coordinates: { type: 'Point', coordinates: [spot[2], spot[1]] },
      });
    }
    customers.push(user);
  }
  log(`customers ready: ${customers.length} (123456, wallet-funded + saved address)`);

  // 4. Bookings covering every status
  let created = 0;
  const activeBookings = []; // for chat seeding
  const completedBookings = []; // for review seeding

  for (const plan of BOOKING_PLAN) {
    const marker = `SEED-HS-${String(plan.n).padStart(2, '0')}`;
    const existing = await Booking.findOne({ description: new RegExp(`^${marker}`) });
    if (existing) {
      if ([STATUS.ACCEPTED, STATUS.EN_ROUTE, STATUS.ARRIVED, STATUS.IN_PROGRESS].includes(existing.status) && plan.chat) {
        activeBookings.push(existing);
      }
      if (existing.status === STATUS.COMPLETED) completedBookings.push({ booking: existing, plan });
      continue;
    }

    const provider = providers[plan.n % providers.length];
    const customer = customers[plan.n % customers.length];
    const address = await SavedAddress.findOne({ user: customer._id });
    const cat = Object.values(catBySlug).find((c) => c.providerSubType === provider.providerSubType);

    const isPast = [STATUS.COMPLETED, STATUS.CANCELLED, STATUS.REJECTED].includes(plan.status);
    const dayOffset = plan.futureDays
      ? plan.futureDays
      : isPast
      ? -(plan.n % 12) - 1
      : (plan.n % 3);
    const scheduledFor = new Date(Date.now() + dayOffset * DAY);
    const price = provider.basePrice + (plan.n % 5) * 100;

    const statusHistory = [
      {
        status: STATUS.PENDING,
        changedBy: { id: customer._id, role: 'customer' },
        changedAt: new Date(scheduledFor.getTime() - 3 * DAY),
        note: 'Booking created',
      },
    ];

    // Build the realistic transition trail up to the target status
    const FULL_CHAIN = [
      STATUS.PENDING,
      STATUS.ACCEPTED,
      STATUS.EN_ROUTE,
      STATUS.ARRIVED,
      STATUS.IN_PROGRESS,
      STATUS.COMPLETED,
    ];
    const targetForChain = plan.cancelFrom || plan.status;
    const chainEnd = FULL_CHAIN.indexOf(targetForChain);
    for (let s = 1; s <= chainEnd; s += 1) {
      const role = FULL_CHAIN[s] === STATUS.COMPLETED ? 'provider' : 'provider';
      statusHistory.push({
        status: FULL_CHAIN[s],
        changedBy: { id: provider._id, role },
        changedAt: new Date(scheduledFor.getTime() - (3 - s * 0.4) * DAY),
      });
    }
    if (plan.status === STATUS.REJECTED) {
      statusHistory.push({
        status: STATUS.REJECTED,
        changedBy: { id: provider._id, role: 'provider' },
        changedAt: new Date(scheduledFor.getTime() - 2 * DAY),
        note: 'Provider unavailable at requested time',
      });
    } else if (plan.status === STATUS.CANCELLED) {
      statusHistory.push({
        status: STATUS.CANCELLED,
        changedBy: { id: customer._id, role: 'customer' },
        changedAt: new Date(scheduledFor.getTime() - 1 * DAY),
        note: 'Customer requested cancellation',
      });
    }

    const paid = !!plan.paid;
    const booking = await Booking.create({
      customer: customer._id,
      provider: provider._id,
      serviceCategory: cat.slug,
      serviceSubCategory: provider.profession,
      description: `${marker}: ${cat.name} service — seeded demo booking`,
      images: [],
      scheduledFor,
      scheduledTime: '02:00 PM',
      address: {
        label: address.label,
        line1: address.line1,
        city: address.city,
        icon: address.icon,
        coordinates: address.coordinates,
      },
      status: plan.status,
      statusHistory,
      pricing: {
        estimatedPrice: price,
        finalPrice: plan.status === STATUS.COMPLETED ? price : null,
        currency: 'PKR',
      },
      payment: {
        status: paid ? 'paid' : plan.requested ? 'requested' : 'unpaid',
        method: paid ? (plan.n % 3 === 0 ? 'cash' : 'wallet') : null,
        requestedAmount: plan.requested ? price : null,
        paidAt: paid ? new Date(scheduledFor.getTime() + 3600000) : null,
      },
      cancellation:
        plan.status === STATUS.CANCELLED
          ? { by: plan.by || 'customer', reason: 'Seeded cancellation', at: new Date() }
          : {},
      instructions: 'Ring the doorbell twice. Ask for the seed demo booking.',
      work:
        plan.status === STATUS.COMPLETED
          ? {
              startedAt: new Date(scheduledFor.getTime() - 1800000),
              endedAt: scheduledFor,
              actualDurationMinutes: 45 + (plan.n % 4) * 15,
              notes: 'Job completed as requested.',
            }
          : {},
    });
    created += 1;

    // Debit customer / credit provider wallet for paid bookings, matching
    // the real payment flow's commission math (10% platform default).
    if (paid) {
      const commission = Math.round(price * 0.1);
      const custWallet = await WalletService.getOrCreateWallet(customer._id, 'User');
      const provWallet = await WalletService.getOrCreateWallet(provider._id, 'Provider');
      if (booking.payment.method === 'wallet' && custWallet.balance >= price) {
        await custWallet.debit(price);
        await WalletService.recordTransaction(custWallet._id, {
          type: 'debit',
          amount: price,
          description: `Home service payment — booking ${booking._id}`,
          source: 'service_payment',
          status: 'completed',
        });
      }
      await provWallet.credit(price - commission);
      await WalletService.recordTransaction(provWallet._id, {
        type: 'credit',
        amount: price - commission,
        description: `Earnings — booking ${booking._id}`,
        source: 'service_payment',
        status: 'completed',
      });
    }

    if (
      [STATUS.ACCEPTED, STATUS.EN_ROUTE, STATUS.ARRIVED, STATUS.IN_PROGRESS].includes(plan.status) &&
      plan.chat
    ) {
      activeBookings.push(booking);
    }
    if (plan.status === STATUS.COMPLETED) {
      completedBookings.push({ booking, plan });
    }
  }
  log(`bookings created: ${created} (skipped ${BOOKING_PLAN.length - created} already present) — covers PENDING/ACCEPTED/EN_ROUTE/ARRIVED/IN_PROGRESS/COMPLETED/CANCELLED/REJECTED`);

  // 5. Chat threads on active bookings
  let chatsCreated = 0;
  for (const booking of activeBookings) {
    const exists = await ChatMessage.findOne({ booking: booking._id });
    if (exists) continue;
    const thread = [
      { role: 'provider', text: "Hi! I've received your booking request and I'm getting ready." },
      { role: 'user', text: 'Great, thank you! What time should I expect you?' },
      { role: 'provider', text: "I'll be there within the scheduled window. I'll message when I'm on the way." },
    ];
    for (let i = 0; i < thread.length; i += 1) {
      await ChatMessage.create({
        booking: booking._id,
        sender: thread[i].role === 'provider' ? booking.provider : booking.customer,
        senderRole: thread[i].role,
        text: thread[i].text,
        readAt: i < thread.length - 1 ? new Date() : null,
        createdAt: new Date(Date.now() - (thread.length - i) * 600000),
      });
    }
    chatsCreated += 1;
  }
  log(`chat threads seeded: ${chatsCreated} (on active bookings)`);

  // 6. Reviews on completed, paid, plan.review bookings — atomic rating recompute
  let reviewsCreated = 0;
  for (const { booking, plan } of completedBookings) {
    if (!plan.review) continue;
    const exists = await ProviderReview.findOne({ booking: booking._id });
    if (exists) continue;
    const rating = 3 + (plan.n % 3);
    await ProviderReview.create({
      booking: booking._id,
      customer: booking.customer,
      provider: booking.provider,
      rating,
      comment: rating >= 4 ? 'Professional, on time, and fixed the issue quickly.' : 'Job done but took longer than expected.',
      tags: rating >= 4 ? ['Professional', 'On Time'] : ['Good Value'],
    });
    await Provider.updateOne({ _id: booking.provider }, [
      {
        $set: {
          'ratings.count': { $add: [{ $ifNull: ['$ratings.count', 0] }, 1] },
          'ratings.average': {
            $round: [
              {
                $divide: [
                  {
                    $add: [
                      { $multiply: [{ $ifNull: ['$ratings.average', 0] }, { $ifNull: ['$ratings.count', 0] }] },
                      rating,
                    ],
                  },
                  { $add: [{ $ifNull: ['$ratings.count', 0] }, 1] },
                ],
              },
              2,
            ],
          },
        },
      },
    ]);
    reviewsCreated += 1;
  }
  log(`reviews seeded: ${reviewsCreated} (on completed bookings, atomic rating recompute applied)`);

  // 7. Disputes (2 open) — against two of the completed-but-unhappy bookings
  const disputeCandidates = completedBookings.filter((c) => !c.plan.review).slice(0, 2);
  let disputesCreated = 0;
  for (const { booking } of disputeCandidates) {
    const exists = await Dispute.findOne({ booking: booking._id });
    if (exists) continue;
    await Dispute.create({
      booking: booking._id,
      raisedBy: { id: booking.customer, role: 'customer' },
      againstRole: 'provider',
      reason: 'Overcharged',
      description: 'Seed demo dispute: the amount charged did not match what was agreed before the job.',
      evidence: [],
      status: 'open',
    });
    disputesCreated += 1;
  }
  log(`disputes seeded: ${disputesCreated} (status: open)`);

  // 8. Payout requests (3 pending) — for providers with completed jobs
  const payoutCandidates = providers.filter((p) => p.completedBookings > 0).slice(0, 3);
  let payoutsCreated = 0;
  for (const provider of payoutCandidates) {
    const exists = await PayoutRequest.findOne({ provider: provider._id, status: 'pending' });
    if (exists) continue;
    const wallet = await WalletService.getOrCreateWallet(provider._id, 'Provider');
    const amount = Math.min(2000, Math.max(500, Math.round(wallet.balance * 0.3)));
    if (amount < 500) continue; // below min payout — skip, matches real validation
    await PayoutRequest.create({
      provider: provider._id,
      amount,
      method: 'bank',
      accountDetails: { bankName: 'Seed Bank', accountNumber: '0000-0000-0000' },
      status: 'pending',
    });
    payoutsCreated += 1;
  }
  log(`payout requests seeded: ${payoutsCreated} (status: pending)`);

  console.log('=== Done ===');
  console.log('Logins:');
  console.log('  providers: provider1..15.hs@metromatrix.pk / Provider@123');
  console.log('  customers: customer1..8.hs@metromatrix.pk / 123456');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Home Services seed failed:', err);
  process.exit(1);
});
