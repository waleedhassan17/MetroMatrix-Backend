/**
 * Home-service history for one provider (Ahmad Khan, electrician).
 *
 * Mirrors the real flows (bookingService, homeservice paymentService,
 * admin payout approval):
 *   wallet payment -> customer debit homeservice_payment + provider credit
 *                     homeservice_earning, one settle_* transfer group
 *   cash payment   -> no ledger rows (payment.method 'cash')
 *   payout approve -> provider debit payout (relatedTo PayoutRequest)
 * Past bookings end COMPLETED, CANCELLED or REJECTED only: the expiry sweep
 * (services/expiryService.js) would auto-cancel a past PENDING/ACCEPTED one
 * and count it as a no-show against the provider.
 */
const Booking = require('../../../src/modules/homeservice/models/Booking');
const ProviderReview = require('../../../src/modules/homeservice/models/ProviderReview');
const ChatMessage = require('../../../src/modules/homeservice/models/ChatMessage');
const PayoutRequest = require('../../../src/modules/homeservice/models/PayoutRequest');
const SavedAddress = require('../../../src/modules/homeservice/models/SavedAddress');
const ServiceCategory = require('../../../src/modules/homeservice/models/ServiceCategory');
const { STATUS } = require('../../../src/modules/homeservice/services/statusMap');
const { recomputeProviderCounters } = require('../../../src/modules/homeservice/services/providerCounters');
const { makeRng, pickRepeat, pkt, addMin, eachDayKey, weekdayOf, dateKeyOf, shiftKey, todayKey, oidAt, shortHex, HOUR } = require('./common');

// bookingController.js TIME_SLOTS
const TIME_LABELS = [
  ['09:00 AM', '09:00'],
  ['10:00 AM', '10:00'],
  ['11:00 AM', '11:00'],
  ['12:00 PM', '12:00'],
  ['02:00 PM', '14:00'],
  ['04:00 PM', '16:00'],
  ['05:00 PM', '17:00'],
  ['06:00 PM', '18:00'],
  ['07:00 PM', '19:00'],
];

// [title, minPrice, maxPrice, minMinutes, maxMinutes]
const JOBS = [
  ['Ceiling fan installation', 800, 1500, 45, 90],
  ['Replace a faulty switchboard', 600, 1200, 30, 60],
  ['UPS and battery wiring for two rooms', 2000, 3500, 120, 180],
  ['Main breaker keeps tripping', 900, 1800, 45, 120],
  ['Install LED panel lights in the lounge', 1200, 2500, 60, 120],
  ['Kitchen socket sparking — repair', 700, 1300, 30, 60],
  ['Replace a DB board breaker', 1000, 2000, 45, 90],
  ['Doorbell and intercom wiring', 600, 1200, 45, 75],
  ['Electric geyser thermostat wiring', 900, 1600, 45, 90],
  ['Exhaust fan installation', 700, 1200, 40, 70],
  ['Dedicated line for an inverter AC', 2500, 4000, 120, 200],
  ['Full house wiring inspection', 1500, 2500, 90, 150],
];

const AREAS = [
  ['Gulberg III', 31.509, 74.3444],
  ['Model Town', 31.4833, 74.3231],
  ['Johar Town', 31.4676, 74.2665],
  ['Garden Town', 31.5004, 74.3176],
  ['Faisal Town', 31.4784, 74.3045],
  ['DHA Phase 3', 31.4795, 74.3936],
];

const INSTRUCTIONS = ['Please call when you reach the gate.', 'Parking is available in front of the house.', 'Ring the bell twice.', ''];
const CANCEL_REASONS = ['Schedule changed', 'Issue fixed itself', 'Booked another time', 'Travelling that day'];
const REVIEW_COMMENTS = {
  5: [
    'Very professional — found the fault in minutes and explained the fix.',
    'On time, neat work, and cleaned up afterwards. Will book again.',
    'Excellent work on the wiring. Fair price too.',
  ],
  4: ['Good work, arrived about 15 minutes late but called ahead.', 'Solved the problem; had to fetch a part, so it took longer.'],
  3: ['Job done, but it took longer than expected.'],
  2: ['Fixed it, but arrived late and did not call.'],
};
const GOOD_TAGS = ['Professional', 'On Time', 'Clean Work', 'Good Value', 'Friendly', 'Knowledgeable'];

const roundTo = (n, step) => Math.round(n / step) * step;

function addressSnapshot(saved, rng) {
  if (saved) {
    return { label: saved.label || 'Home', line1: saved.line1, city: saved.city || 'Lahore', icon: saved.icon || 'home', coordinates: saved.coordinates };
  }
  const [area, lat, lng] = rng.pick(AREAS);
  return {
    label: 'Home',
    line1: `House ${rng.int(2, 220)}, ${area}`,
    city: 'Lahore',
    icon: 'home',
    coordinates: { type: 'Point', coordinates: [lng, lat] },
  };
}

function chatThread(kind, label, dateText) {
  if (kind === 'cancelled') {
    return [
      ['provider', `Assalam o Alaikum! Booking accepted — I will reach at ${label}.`],
      ['user', 'Sorry, something came up and I need to cancel this one. I will rebook soon.'],
      ['provider', 'No problem at all. Feel free to book again anytime.'],
    ];
  }
  if (kind === 'upcoming') {
    return [
      ['provider', `Assalam o Alaikum! Your booking is confirmed for ${dateText} at ${label}.`],
      ['user', 'Thank you. Please call when you reach.'],
      ['provider', 'Sure, I will call 15 minutes before.'],
    ];
  }
  return [
    ['provider', 'Assalam o Alaikum! I have accepted your booking. Could you send a photo of the problem area?'],
    ['user', 'Walaikum Assalam. Sending it now — the board is in the corridor.'],
    ['provider', `Got it, I will bring the parts. See you at ${label}.`],
    ['provider', 'On my way, should reach in about 20 minutes.'],
    ['user', 'Great, the gate will be open.'],
  ];
}

async function seedBooking(ctx, env, spec) {
  const { now } = ctx;
  const { provider, providerWallet, category } = env;
  const { key, customer, rng, day, labelPair, outcome, job, payMethod, review, chat, address, createdAt } = spec;
  if (ctx.has(`${key}:booking`)) {
    ctx.count('hsbookings', 'skipped');
    return null;
  }
  const [label, hm] = labelPair;
  const scheduledFor = pkt(day, hm);
  const [title, minP, maxP, minD, maxD] = job;
  const estimate = roundTo(rng.int(minP, maxP), 50);
  const finalPrice = rng.chance(0.25) ? estimate + roundTo(rng.int(200, 800), 50) : estimate;
  const bookingId = oidAt(createdAt);

  const history = [{ status: STATUS.PENDING, changedBy: { id: customer._id, role: 'customer' }, changedAt: createdAt, note: 'Booking created' }];
  const pushH = (status, at, role, note) =>
    history.push({ status, changedBy: { id: role === 'customer' ? customer._id : provider._id, role }, changedAt: at, ...(note ? { note } : {}) });
  const acceptedAt = addMin(createdAt, rng.int(10, 90));

  let work = {};
  let cancellation = {};
  let completedAt = null;
  if (outcome === STATUS.REJECTED) {
    pushH(STATUS.REJECTED, addMin(createdAt, rng.int(10, 90)), 'provider', 'Not available at the requested time');
  } else if (outcome === STATUS.CANCELLED) {
    let at = addMin(createdAt, rng.int(40, 240));
    if (rng.chance(0.6) || spec.acceptedBeforeCancel) {
      pushH(STATUS.ACCEPTED, acceptedAt, 'provider');
      at = new Date(Math.max(at.getTime(), addMin(acceptedAt, 30).getTime()));
    }
    if (at >= scheduledFor) at = addMin(scheduledFor, -rng.int(60, 180));
    const reason = spec.cancelReason || rng.pick(CANCEL_REASONS);
    pushH(STATUS.CANCELLED, at, 'customer', reason);
    cancellation = { by: 'customer', reason, at, code: null };
  } else if (outcome === STATUS.ACCEPTED) {
    pushH(STATUS.ACCEPTED, acceptedAt, 'provider');
  } else if (outcome === STATUS.COMPLETED) {
    const enRoute = addMin(scheduledFor, -rng.int(30, 45));
    pushH(STATUS.ACCEPTED, acceptedAt < enRoute ? acceptedAt : addMin(createdAt, 5), 'provider');
    pushH(STATUS.EN_ROUTE, enRoute, 'provider');
    const arrived = addMin(scheduledFor, rng.chance(0.1) ? rng.int(20, 40) : rng.int(-10, 12));
    pushH(STATUS.ARRIVED, arrived, 'provider');
    const started = addMin(arrived, rng.int(5, 12));
    pushH(STATUS.IN_PROGRESS, started, 'provider');
    const minutes = rng.int(minD, maxD);
    completedAt = addMin(started, minutes);
    pushH(STATUS.COMPLETED, completedAt, 'provider');
    work = { startedAt: started, endedAt: completedAt, actualDurationMinutes: minutes, notes: 'Work completed and tested.' };
  }

  const paidAt = completedAt ? addMin(completedAt, payMethod === 'cash' ? rng.int(3, 10) : rng.int(5, 40)) : null;
  const paid = Boolean(paidAt) && paidAt <= now;
  const payTxnId = paid && payMethod === 'wallet' ? oidAt(paidAt) : null;
  const lastAt = paid ? paidAt : history[history.length - 1].changedAt;

  await ctx.put(Booking, `${key}:booking`, {
    _id: bookingId,
    customer: customer._id,
    provider: provider._id,
    serviceCategory: category.slug,
    serviceSubCategory: provider.profession || 'Electrician',
    description: title,
    images: [],
    scheduledFor,
    scheduledTime: label,
    address,
    status: outcome,
    statusHistory: history,
    pricing: { estimatedPrice: estimate, finalPrice: completedAt ? finalPrice : null, currency: 'PKR' },
    payment: {
      status: paid ? 'paid' : 'unpaid',
      method: paid ? payMethod : null,
      walletTransactionId: payTxnId,
      requestedAmount: paid ? finalPrice : null,
      paidAt: paid ? paidAt : undefined,
    },
    cancellation,
    instructions: rng.pick(INSTRUCTIONS),
    work,
    createdAt,
    updatedAt: lastAt,
  });

  if (paid && payMethod === 'wallet') {
    const customerWallet = await ctx.wallet(customer._id, 'User', spec.walletLabel || customer.email);
    const tg = `settle_${shortHex(8)}`;
    const description = `Home service payment — booking ${bookingId}`;
    await ctx.customerDebit(`${key}:pay`, customerWallet, {
      _id: payTxnId,
      amount: finalPrice,
      source: 'homeservice_payment',
      description,
      relatedTo: { kind: 'Booking', id: bookingId },
      counterparty: { id: provider._id, type: 'Provider' },
      transferGroupId: tg,
      at: paidAt,
    });
    await ctx.ledger(`${key}:earn`, providerWallet, {
      type: 'credit',
      amount: finalPrice,
      source: 'homeservice_earning',
      description,
      relatedTo: { kind: 'Booking', id: bookingId },
      counterparty: { id: customer._id, type: 'User' },
      transferGroupId: tg,
      metadata: { grossAmount: finalPrice, commission: 0, commissionRate: 0 },
      at: paidAt,
    });
    const month = dateKeyOf(paidAt).slice(0, 7);
    env.walletEarningsByMonth[month] = (env.walletEarningsByMonth[month] || 0) + finalPrice;
  }

  if (paid && review) {
    const reviewAt = addMin(paidAt, rng.int(60, 2 * 1440));
    if (reviewAt < now) {
      const tags = review >= 4 ? GOOD_TAGS.filter(() => rng.chance(0.35)).slice(0, 3) : review === 3 ? ['Good Value'] : [];
      await ctx.put(ProviderReview, `${key}:review`, {
        booking: bookingId,
        customer: customer._id,
        provider: provider._id,
        rating: review,
        comment: rng.pick(REVIEW_COMMENTS[review]),
        tags: tags.length || review < 4 ? tags : ['Professional'],
        createdAt: reviewAt,
      });
    }
  }

  if (chat) {
    const kind = outcome === STATUS.CANCELLED ? 'cancelled' : outcome === STATUS.ACCEPTED ? 'upcoming' : 'completed';
    const thread = chatThread(kind, label, day);
    let t = addMin(acceptedAt, 3);
    for (let i = 0; i < thread.length; i += 1) {
      const [role, text] = thread[i];
      if (kind === 'completed' && i === 3) t = addMin(scheduledFor, -rng.int(25, 35)); // the "on my way" pair
      else t = addMin(t, rng.int(2, 25));
      if (t > now) break;
      const isLast = i === thread.length - 1;
      await ctx.put(ChatMessage, `${key}:chat:${i}`, {
        booking: bookingId,
        sender: role === 'provider' ? provider._id : customer._id,
        senderRole: role,
        text,
        readAt: kind === 'upcoming' && isLast ? null : addMin(t, rng.int(1, 15)),
        createdAt: t,
      });
    }
  }
  return { outcome, paid };
}

// Ubaid's own bookings with Ahmad Khan.
const PRIMARY_BOOKINGS = [
  { day: '2026-08-25', label: 4, job: 0, outcome: STATUS.COMPLETED, pay: 'wallet', review: 5 },
  { day: '2026-09-18', label: 6, job: 2, outcome: STATUS.COMPLETED, pay: 'wallet', review: 4 },
  { day: '2026-10-05', label: 1, job: 3, outcome: STATUS.COMPLETED, pay: 'cash', review: 5 },
  { day: '2026-10-21', label: 5, job: 4, outcome: STATUS.CANCELLED, cancelReason: 'Schedule changed — exams that week' },
  { day: '2026-10-28', label: 5, job: 4, outcome: STATUS.COMPLETED, pay: 'wallet', review: 5 },
];

async function seedHomeService(ctx, { primary, provider, customers, fromKey, toKey }) {
  const { now } = ctx;
  const category = (await ServiceCategory.findOne({ providerSubType: provider.providerSubType, isActive: true }).lean()) || {
    slug: 'electricians',
  };
  const env = {
    provider,
    category,
    providerWallet: await ctx.wallet(provider._id, 'Provider', 'Ahmad Khan (home services)'),
    walletEarningsByMonth: {},
  };
  const summary = { primary: 0, past: 0, upcoming: 0, payouts: 0 };

  // Ubaid's home address for home services (his shop address, if he has one)
  let primaryAddress = await SavedAddress.findOne({ user: primary._id }).sort({ isDefault: -1 }).lean();
  if (!primaryAddress) {
    const Address = require('../../../src/modules/shopping/models/Address');
    const shop = await Address.findOne({ userId: primary._id }).sort({ isDefault: -1 }).lean();
    const line1 = shop ? [shop.addressLine1, shop.area].filter(Boolean).join(', ') : 'Model Town';
    const res = await ctx.put(SavedAddress, 'hs:primary:address', {
      user: primary._id,
      label: 'Home',
      line1,
      city: (shop && shop.city) || 'Lahore',
      icon: 'home',
      isDefault: true,
      coordinates: { type: 'Point', coordinates: [74.3231, 31.4833] },
      coordinatesSource: 'pin',
      createdAt: pkt('2026-08-24', '21:10'),
    });
    primaryAddress = res.doc || (await SavedAddress.findById(res._id).lean());
  }

  for (let i = 0; i < PRIMARY_BOOKINGS.length; i += 1) {
    const b = PRIMARY_BOOKINGS[i];
    const key = `hs:primary:${String(i + 1).padStart(2, '0')}`;
    const rng = makeRng(key);
    const labelPair = TIME_LABELS[b.label];
    const scheduledFor = pkt(b.day, labelPair[1]);
    if (scheduledFor.getTime() > now.getTime() - 4 * HOUR) continue;
    const res = await seedBooking(ctx, env, {
      key,
      customer: primary,
      rng,
      day: b.day,
      labelPair,
      outcome: b.outcome,
      job: JOBS[b.job],
      payMethod: b.pay,
      review: b.review,
      chat: true,
      cancelReason: b.cancelReason,
      acceptedBeforeCancel: true,
      address: addressSnapshot(primaryAddress, rng),
      createdAt: addMin(scheduledFor, -rng.int(18 * 60, 2 * 1440)),
      walletLabel: 'Ubaid (customer)',
    });
    if (res) summary.primary += 1;
  }

  const addressCache = new Map();
  const savedFor = async (user) => {
    const id = String(user._id);
    if (!addressCache.has(id)) addressCache.set(id, await SavedAddress.findOne({ user: user._id }).sort({ isDefault: -1 }).lean());
    return addressCache.get(id);
  };

  // The trade: past bookings across the window
  const days = eachDayKey(fromKey, toKey);
  for (let d = 0; d < days.length; d += 1) {
    const day = days[d];
    const progress = days.length > 1 ? d / (days.length - 1) : 1;
    const dayRng = makeRng(`hs:day:${day}`);
    const lambda = (0.32 + 0.38 * progress) * (weekdayOf(day) >= 6 ? 1.2 : 1);
    const count = Math.floor(lambda + dayRng.next());
    const usedLabels = new Set();
    for (let i = 0; i < count; i += 1) {
      const key = `hs:b:${day}:${i}`;
      const rng = makeRng(key);
      let labelPair = rng.pick(TIME_LABELS);
      while (usedLabels.has(labelPair[0])) labelPair = rng.pick(TIME_LABELS);
      usedLabels.add(labelPair[0]);
      const scheduledFor = pkt(day, labelPair[1]);
      if (scheduledFor.getTime() > now.getTime() - 4 * HOUR) continue;
      const customer = pickRepeat(rng, customers);
      const outcome = rng.weighted([[STATUS.COMPLETED, 84], [STATUS.CANCELLED, 9], [STATUS.REJECTED, 7]]);
      const res = await seedBooking(ctx, env, {
        key,
        customer,
        rng,
        day,
        labelPair,
        outcome,
        job: rng.pick(JOBS),
        payMethod: rng.chance(0.7) ? 'wallet' : 'cash',
        review: outcome === STATUS.COMPLETED && rng.chance(0.7) ? rng.weighted([[5, 55], [4, 30], [3, 10], [2, 5]]) : null,
        chat: false,
        address: addressSnapshot(await savedFor(customer), rng),
        createdAt: addMin(scheduledFor, -rng.int(8 * 60, 3 * 1440)),
      });
      if (res) summary.past += 1;
    }
  }

  // Upcoming: three accepted jobs and one new request
  const today = todayKey();
  const UPCOMING = [
    { n: 0, offset: 1, outcome: STATUS.ACCEPTED },
    { n: 1, offset: 2, outcome: STATUS.PENDING },
    { n: 2, offset: 3, outcome: STATUS.ACCEPTED },
    { n: 3, offset: 5, outcome: STATUS.ACCEPTED },
  ];
  for (const u of UPCOMING) {
    const key = `hs:up:${u.n}`;
    const rng = makeRng(key);
    const day = shiftKey(today, u.offset);
    const customer = pickRepeat(rng, customers);
    const res = await seedBooking(ctx, env, {
      key,
      customer,
      rng,
      day,
      labelPair: rng.pick(TIME_LABELS),
      outcome: u.outcome,
      job: rng.pick(JOBS),
      payMethod: null,
      review: null,
      chat: u.outcome === STATUS.ACCEPTED,
      address: addressSnapshot(await savedFor(customer), rng),
      createdAt: addMin(now, -rng.int(90, 30 * 60)),
    });
    if (res) summary.upcoming += 1;
  }

  // Monthly payouts of wallet earnings (approved), plus one pending request
  const months = Object.keys(env.walletEarningsByMonth).sort();
  const currentMonth = dateKeyOf(now).slice(0, 7);
  for (const month of months) {
    if (month >= currentMonth) continue;
    const key = `hs:payout:${month}`;
    if (ctx.has(`${key}:request`)) {
      ctx.count('hspayoutrequests', 'skipped');
      continue;
    }
    const rng = makeRng(key);
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const requestAt = pkt(`${month}-${String(lastDay).padStart(2, '0')}`, `${16 + rng.int(0, 2)}:${String(rng.int(0, 59)).padStart(2, '0')}`);
    const decidedAt = addMin(requestAt, rng.int(18 * 60, 30 * 60));
    const amount = Math.min(Math.floor((env.walletEarningsByMonth[month] * 0.8) / 500) * 500, Math.floor(ctx.balanceOf(env.providerWallet) / 500) * 500);
    if (amount < 500 || decidedAt > now) continue;
    const payoutId = oidAt(requestAt);
    const txnId = oidAt(decidedAt);
    await ctx.put(PayoutRequest, `${key}:request`, {
      _id: payoutId,
      provider: provider._id,
      amount,
      method: 'bank',
      accountDetails: { bankName: 'Meezan Bank', accountTitle: provider.fullName, accountNumber: '•••• 4821' },
      status: 'approved',
      decidedAt,
      walletTransactionId: txnId,
      createdAt: requestAt,
      updatedAt: decidedAt,
    });
    await ctx.ledger(`${key}:debit`, env.providerWallet, {
      _id: txnId,
      type: 'debit',
      amount,
      source: 'payout',
      description: 'Payout approved (bank)',
      relatedTo: { kind: 'PayoutRequest', id: payoutId },
      metadata: { payoutRequestId: String(payoutId) },
      at: decidedAt,
    });
    summary.payouts += 1;
  }
  const pendingExists = await PayoutRequest.exists({ provider: provider._id, status: 'pending' });
  const pendingAt = addMin(now, -26 * 60);
  const pendingAmount = Math.min(2000, Math.floor((ctx.balanceOf(env.providerWallet) * 0.3) / 500) * 500);
  if ((!pendingExists || ctx.has('hs:payout:pending:request')) && pendingAmount >= 500) {
    await ctx.put(PayoutRequest, 'hs:payout:pending:request', {
      provider: provider._id,
      amount: pendingAmount,
      method: 'bank',
      accountDetails: { bankName: 'Meezan Bank', accountTitle: provider.fullName, accountNumber: '•••• 4821' },
      status: 'pending',
      createdAt: pendingAt,
    });
  }

  // Rating, review count and job counters from the real reviews/bookings.
  if (!ctx.dryRun) await recomputeProviderCounters({ _id: provider._id });
  return summary;
}

module.exports = { seedHomeService };
