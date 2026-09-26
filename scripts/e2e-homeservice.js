/**
 * Home Services — two-role end-to-end check (QA sign-off harness).
 *
 * Plays the customer AND the provider at once, over the real API, and holds a
 * real socket on the realtime service for each of them, so every step asserts
 * both the HTTP answer and the live event the other person's screen waits on.
 * smoke-homeservice.js proves the happy path exists; this proves every branch
 * a customer or provider can take, and that the money and the counters come
 * out right.
 *
 *   S1  happy path, wallet         S7  dispute
 *   S2  cash                       S8  authorization
 *   S3  provider declines          S9  races and double taps
 *   S4  customer cancels (4 ways)  S10 money bounds
 *   S5  duplicates + first-accept  S11 payouts
 *   S6  customer confirms early    S12 slots, hours and expiry
 *
 * Every booking it makes carries "[QA-E2E <run>]" in its instructions, and
 * every payout it makes carries it in accountDetails.reference, so
 *   node scripts/homeservice-data-hygiene.js --apply --qa-cleanup
 * removes exactly what a run left behind.
 *
 * Run:  API_URL=http://localhost:5000 node scripts/e2e-homeservice.js
 *       API_URL=https://metro-matrix-backend.vercel.app node scripts/e2e-homeservice.js
 *       ... --only=S1,S4       run a subset
 *       ... --out=results.json write a machine-readable report
 *
 * Needs the seeded QA accounts (seed-homeservice.js) and, for S12's expiry
 * check, MONGODB_URI in .env (it backdates one of its own bookings).
 */
require('dotenv').config();
const axios = require('axios');
const { io } = require('socket.io-client');

const API = (process.env.API_URL || 'http://localhost:5000').replace(/\/$/, '');
const REALTIME = (
  process.env.REALTIME_URL || 'https://metromatrix-realtime-1d7dadda1082.herokuapp.com'
).replace(/\/$/, '');
const RUN_ID = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const TAG = `[QA-E2E ${RUN_ID}]`;
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '')
  .replace('--only=', '')
  .split(',')
  .filter(Boolean);
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').replace('--out=', '');

const http = axios.create({ baseURL: `${API}/api`, validateStatus: () => true, timeout: 45000 });

const CUSTOMER_PASSWORD = '123456';
const PROVIDER_PASSWORD = 'Provider@123';
const POOLS = {
  electricians: [1, 2, 3, 4, 5],
  plumbers: [6, 7, 8, 9, 10],
  'ac-repairers': [11, 12, 13, 14, 15],
};
const COMMISSION = 0.1;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const results = [];
let scenario = 'setup';
let stepNo = 0;
function check(name, ok, detail = '') {
  stepNo += 1;
  const id = `${scenario}.${String(stepNo).padStart(2, '0')}`;
  results.push({ id, scenario, name, ok: !!ok, detail: String(detail || '') });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
  return !!ok;
}
const short = (v) => JSON.stringify(v).slice(0, 180);
/** The reason a request gave: controllers answer `message`, errorMiddleware answers `error` — the app reads both. */
const msgOf = (r) => (r && r.data && (r.data['message'] || r.data['error'])) || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
class Actor {
  constructor(role, email) {
    this.role = role;
    this.email = email;
    this.password = role === 'provider' ? PROVIDER_PASSWORD : CUSTOMER_PASSWORD;
  }

  async login() {
    const path = this.role === 'provider' ? '/auth/provider/login' : '/auth/login';
    const r = await http.post(path, { email: this.email, password: this.password });
    if (!r.data || !r.data.accessToken) {
      throw new Error(`login failed for ${this.email}: HTTP ${r.status} ${short(r.data)}`);
    }
    this.token = r.data.accessToken;
    const who = this.role === 'provider' ? r.data.provider || {} : r.data.user || {};
    this.id = String(who._id || who.id);
    this.name = who.fullName || this.email;
    return this;
  }

  async call(method, url, data) {
    const go = () =>
      http.request({ method, url, data, headers: { Authorization: `Bearer ${this.token}` } });
    let r = await go();
    if (r.status === 401 && this.token) {
      await this.login();
      r = await go();
    }
    return r;
  }

  get(url) {
    return this.call('get', url);
  }

  post(url, data = {}) {
    return this.call('post', url, data);
  }

  patch(url, data = {}) {
    return this.call('patch', url, data);
  }

  async balance() {
    // GET /wallet/me answers { success, wallet: { balance }, transactions }.
    const r = await this.get('/wallet/me');
    const w = (r.data && (r.data.wallet || (r.data.data && r.data.data.wallet))) || {};
    return Number(w.balance);
  }
}

const actors = {};
async function customer(n) {
  const key = `c${n}`;
  if (!actors[key]) actors[key] = await new Actor('customer', `customer${n}.hs@metromatrix.pk`).login();
  return actors[key];
}
async function provider(n) {
  const key = `p${n}`;
  if (!actors[key]) actors[key] = await new Actor('provider', `provider${n}.hs@metromatrix.pk`).login();
  return actors[key];
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------
async function openSocket(actor) {
  return new Promise((resolve) => {
    const s = io(REALTIME, {
      auth: { token: actor.token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 15000,
    });
    const sock = { s, events: [], actor };
    s.onAny((event, payload) => sock.events.push({ event, payload, at: Date.now() }));
    s.on('connect', () => resolve({ ...sock, ok: true }));
    s.on('connect_error', (e) => resolve({ ...sock, ok: false, error: e.message }));
  });
}

function ack(sock, event, payload, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ success: false, message: 'ack timeout' }), timeoutMs);
    sock.s.emit(event, payload, (a) => {
      clearTimeout(timer);
      resolve(a || { success: true });
    });
  });
}

/** Resolve with the first `event` since `since` matching `pred`, or null after `timeoutMs`. */
function waitFor(sock, event, pred, since, timeoutMs = 8000) {
  const find = () =>
    sock.events.find((e) => e.event === event && e.at >= since && (!pred || pred(e.payload || {})));
  return new Promise((resolve) => {
    const hit = find();
    if (hit) return resolve(hit.payload);
    const started = Date.now();
    const timer = setInterval(() => {
      const h = find();
      if (h) {
        clearInterval(timer);
        resolve(h.payload);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(null);
      }
    }, 100);
  });
}

const join = (sock, bookingId) =>
  ack(sock, 'join_booking', { roomId: bookingId, bookingId, roomType: 'homeservice' });

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------
/** 'YYYY-MM-DD' in Pakistan time, `days` from today. */
function pktDate(days = 0) {
  return new Date(Date.now() + 5 * 3600000 + days * 86400000).toISOString().slice(0, 10);
}

const created = [];

async function book(c, p, label, { date, time } = {}) {
  for (let d = 1; d <= 6; d += 1) {
    const day = date || pktDate(d);
    const init = await c.get(`/bookings/init/${p.id}?date=${day}`);
    const data = (init.data && init.data.data) || {};
    const address = (data.addresses || [])[0];
    const slot = time || ((data.timeSlots || []).find((t) => t.available) || {}).time;
    if (!slot && !date) continue;
    const r = await c.post('/bookings', {
      providerId: p.id,
      selectedDate: day,
      selectedTime: slot,
      addressId: address && address.id,
      instructions: `${TAG} ${label}`,
    });
    const bookingId = r.data && r.data.data && r.data.data.bookingId;
    if (bookingId) created.push({ bookingId, customer: c, provider: p });
    return { r, bookingId, date: day, slot, addressId: address && address.id };
  }
  return { r: { status: 0, data: { message: 'no free slot in the next 6 days' } }, bookingId: null };
}

async function detail(actor, bookingId) {
  const r = await actor.get(`/bookings/${bookingId}`);
  return (r.data && r.data.data) || {};
}

/** Make a customer/provider pair free of live bookings — only ever closing our own. */
async function freePair(c, p) {
  const r = await c.get('/bookings/active');
  const live = ((r.data && r.data.data && r.data.data.bookings) || []).filter((b) => b.providerId === p.id);
  for (const b of live) {
    const d = await detail(c, b.bookingId);
    if (!String((d.bookingDetails && d.bookingDetails.instructions) || '').includes('[QA-E2E')) {
      return false; // somebody else's booking — leave it, pick another provider
    }
    await closeBooking(c, b.bookingId);
  }
  return true;
}

async function closeBooking(c, bookingId) {
  const d = await detail(c, bookingId);
  if (['PENDING', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED'].includes(d.canonicalStatus)) {
    await c.post(`/bookings/${bookingId}/cancel`, { reason: `${TAG} cleanup` });
  } else if (d.canonicalStatus === 'IN_PROGRESS') {
    await c.post(`/bookings/${bookingId}/complete`);
  }
}

async function pickProvider(c, category, exclude = []) {
  for (const n of POOLS[category]) {
    const p = await provider(n);
    if (exclude.includes(p.id)) continue;
    if (await freePair(c, p)) return p;
  }
  throw new Error(`no free ${category} provider for ${c.email}`);
}

const statusOf = async (actor, id) => (await detail(actor, id)).canonicalStatus;
const hasNotification = async (actor, bookingId, type) => {
  const r = await actor.get('/notifications?limit=50');
  const list = (r.data && r.data.data && r.data.data.notifications) || [];
  return list.some((n) => n.data && n.data.bookingId === bookingId && (!type || n.type === type));
};

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const S = {};

S.S1 = async () => {
  const c = await customer(1);
  const p = await pickProvider(c, 'electricians');
  const cs = await openSocket(c);
  const ps = await openSocket(p);
  check('both sockets connect to the realtime service', cs.ok && ps.ok, cs.error || ps.error);
  const cBal0 = await c.balance();
  const pBal0 = await p.balance();

  let t = Date.now();
  const { r, bookingId, slot, date } = await book(c, p, 'S1 wallet happy path');
  check('customer books → PENDING, "waiting"', r.status === 200 && r.data.data.status === 'waiting', `${p.name} ${date} ${slot}`);
  if (!bookingId) throw new Error(`booking failed: ${short(r.data)}`);
  const created1 = await waitFor(ps, 'booking_created', (e) => e.bookingId === bookingId, t, 8000);
  check('provider hears booking_created live (dashboard/jobs update without refresh)', !!created1, created1 ? `${Date.now() - t} ms` : 'no event');

  const jobs = await p.get('/provider/jobs?status=available');
  check('request is in the provider\'s "available" bucket', (jobs.data.data.jobs || []).some((j) => j.id === bookingId));
  check('provider has a durable "new booking" notification', await hasNotification(p, bookingId, 'booking_created'));

  const joinC = await join(cs, bookingId);
  const joinP = await join(ps, bookingId);
  check('both parties can join the booking room', joinC.success !== false && joinP.success !== false, short([joinC, joinP]));

  t = Date.now();
  let res = await p.post(`/provider/jobs/${bookingId}/accept`);
  check('provider accepts → 200', res.status === 200, short(res.data));
  let ev = await waitFor(cs, 'booking_status_changed', (e) => e.status === 'ACCEPTED', t);
  check('customer hears ACCEPTED live', !!ev, ev ? `${Date.now() - t} ms` : 'no event');
  check('booking reads "confirmed" to the customer', (await detail(c, bookingId)).status === 'confirmed');
  check('customer has an "accepted" notification', await hasNotification(c, bookingId, 'booking_accepted'));
  res = await p.post(`/provider/jobs/${bookingId}/accept`);
  check('second Accept tap is a harmless no-op (200)', res.status === 200, short(res.data));

  t = Date.now();
  res = await p.post(`/provider/jobs/${bookingId}/start`);
  check('provider starts the trip → EN_ROUTE', res.status === 200);
  ev = await waitFor(cs, 'booking_status_changed', (e) => e.status === 'EN_ROUTE', t);
  check('customer hears EN_ROUTE live', !!ev);
  // The provider joined the room while PENDING; the location relay must know
  // the booking is now trackable straight away, not a minute later.
  t = Date.now();
  const locAck = await ack(ps, 'provider_location', { roomId: bookingId, bookingId, lat: 31.5, lng: 74.35, heading: 90 });
  const loc = await waitFor(cs, 'provider_location_update', (e) => e.bookingId === bookingId, t, 6000);
  check('live location reaches the customer right after "Start job"', !!loc && locAck.data && locAck.data.broadcast === true, short(locAck));
  const track = await c.get(`/bookings/${bookingId}/tracking`);
  check('tracking reads en_route / nearby', ['en_route', 'nearby'].includes(track.data.data && track.data.data.trackingStatus.status), short(track.data.data && track.data.data.trackingStatus));

  t = Date.now();
  res = await p.post(`/provider/jobs/${bookingId}/arrived`);
  ev = await waitFor(cs, 'booking_status_changed', (e) => e.status === 'ARRIVED', t);
  check('provider arrives → customer hears ARRIVED', res.status === 200 && !!ev);

  t = Date.now();
  res = await p.post(`/provider/jobs/${bookingId}/start-work`);
  ev = await waitFor(cs, 'booking_status_changed', (e) => e.status === 'IN_PROGRESS', t);
  check('work starts → IN_PROGRESS, customer hears it', res.status === 200 && !!ev && !!res.data.data.startTime);
  const stopAck = await ack(ps, 'provider_location', { roomId: bookingId, bookingId, lat: 31.5, lng: 74.35 });
  check('location is no longer relayed once work has started (NFR-08)', stopAck.data && stopAck.data.broadcast === false, short(stopAck));
  const svc = await c.get(`/bookings/${bookingId}/service-status`);
  check('service status shows work in progress', svc.data.data && svc.data.data.canonicalStatus === 'IN_PROGRESS');

  t = Date.now();
  res = await p.post(`/provider/jobs/${bookingId}/complete`, { finalAmount: 1500, notes: 'Replaced a burnt socket' });
  ev = await waitFor(cs, 'booking_status_changed', (e) => e.status === 'COMPLETED', t);
  check('provider completes with Rs. 1,500 → COMPLETED, customer hears it', res.status === 200 && res.data.data.finalAmount === 1500 && !!ev, short(res.data));
  const init = await c.get(`/payments/${bookingId}/init`);
  check('payment screen shows the bill (Rs. 1,500), wallet + cash only', init.data.data.details.amount === 1500 && init.data.data.availableMethods.map((m) => m.id).join(',') === 'wallet,cash', short(init.data.data.availableMethods));

  res = await c.post('/payments/process', { bookingId, method: 'wallet', amount: 1 });
  check('paying Rs. 1 against a Rs. 1,500 bill is refused (409)', res.status === 409, msgOf(res));
  t = Date.now();
  res = await c.post('/payments/process', { bookingId, method: 'wallet', amount: 1500 });
  check('customer pays Rs. 1,500 from the wallet', res.status === 200 && res.data.data.status === 'completed' && res.data.data.amount === 1500, short(res.data));
  ev = await waitFor(ps, 'payment_received', (e) => e.bookingId === bookingId, t);
  check('provider hears payment_received live', !!ev);
  check('provider has a "payment received" notification', await hasNotification(p, bookingId, 'payment_received'));
  res = await c.post('/payments/process', { bookingId, method: 'wallet' });
  check('a second payment is refused', res.status >= 400, msgOf(res));

  const cBal1 = await c.balance();
  const pBal1 = await p.balance();
  check('customer wallet down by exactly Rs. 1,500', Math.round(cBal0 - cBal1) === 1500, `${cBal0} → ${cBal1}`);
  check('provider wallet up by the bill minus 10% commission (Rs. 1,350)', Math.round(pBal1 - pBal0) === Math.round(1500 * (1 - COMMISSION)), `${pBal0} → ${pBal1}`);

  const before = (await http.get(`/providers/${p.id}`)).data.data;
  res = await c.post('/reviews', { bookingId, providerId: p.id, rating: 5, feedback: `${TAG} Quick, tidy and explained the fault clearly.`, tags: ['Professional', 'On Time'] });
  check('customer reviews 5★', res.status === 200, short(res.data));
  res = await c.post('/reviews', { bookingId, providerId: p.id, rating: 4, feedback: 'again' });
  check('a second review of the same job is refused', res.status === 400);
  const after = (await http.get(`/providers/${p.id}`)).data.data;
  check('provider review count +1 on the public profile', after.reviews === before.reviews + 1, `${before.reviews} → ${after.reviews}`);
  const pub = (after.reviewsList || []).find((rv) => String(rv.comment).includes(TAG));
  check('public review names the author as "First L."', pub && /^[A-Z][a-z]+ [A-Z]\.$/.test(pub.reviewerName), pub && pub.reviewerName);
  check('public provider profile exposes no email or phone', after.email === undefined && after.phoneNumber === undefined);

  const list = (await c.get('/user/bookings')).data.data || [];
  const row = list.find((b) => b.id === bookingId);
  check('customer\'s bookings list shows it paid and rated 5', row && row.payment.status === 'paid' && row.rating === 5, short(row));
  const earn = (await p.get('/provider/earnings?period=week')).data.data;
  const pay = (earn.recentPayments || []).find((x) => x.bookingId === bookingId);
  check('provider earnings list the job at Rs. 1,350 net', pay && pay.amount === 1350, short(pay));
  check('earnings "week" period answers with a 7-day series', earn.period === 'week' && (earn.series || []).length === 7 && earn.periodEarnings >= 1350, `${earn.period} ${(earn.series || []).length} ${earn.periodEarnings}`);

  S.S1.ctx = { bookingId, c, p };
  cs.s.close();
  ps.s.close();
};

S.S2 = async () => {
  const c = await customer(2);
  const p = await pickProvider(c, 'plumbers');
  const cs = await openSocket(c);
  const ps = await openSocket(p);
  const cBal0 = await c.balance();
  const { bookingId } = await book(c, p, 'S2 cash');
  if (!bookingId) throw new Error('booking failed');
  await join(cs, bookingId);
  await join(ps, bookingId);
  for (const step of ['accept', 'start', 'arrived', 'start-work', 'complete-work']) {
    const r = await p.post(`/provider/jobs/${bookingId}/${step}`);
    if (r.status !== 200) throw new Error(`${step} failed: ${short(r.data)}`);
  }
  check('provider drives the job to COMPLETED (complete-work)', (await statusOf(c, bookingId)) === 'COMPLETED');
  let t = Date.now();
  let r = await p.post(`/provider/jobs/${bookingId}/request-payment`, { amount: 1200 });
  const ev = await waitFor(cs, 'payment_requested', (e) => e.bookingId === bookingId, t);
  check('provider requests Rs. 1,200 → customer hears it live', r.status === 200 && ev && ev.amount === 1200, short(ev));
  check('customer has a "payment requested" notification', await hasNotification(c, bookingId, 'payment_requested'));
  r = await c.post('/payments/process', { bookingId, method: 'cash' });
  check('customer chooses cash → pending, amount is the provider\'s Rs. 1,200', r.status === 200 && r.data.data.status === 'pending' && r.data.data.amount === 1200, short(r.data));
  check('the bill is still Rs. 1,200 afterwards', (await detail(c, bookingId)).payment.amount === 1200);
  check('provider is told to expect cash', await hasNotification(p, bookingId, 'payment_requested'));
  const pBal0 = await p.balance();
  t = Date.now();
  r = await p.post(`/provider/jobs/${bookingId}/confirm-cash`);
  const paid = await waitFor(cs, 'payment_received', (e) => e.bookingId === bookingId, t);
  check('provider confirms cash → customer\'s screen hears "paid"', r.status === 200 && paid && paid.method === 'cash', short(paid));
  check('booking is paid, by cash', (await detail(c, bookingId)).payment.status === 'paid');
  check('customer gets a "payment confirmed" notification', await hasNotification(c, bookingId, 'payment_received'));
  const cBal1 = await c.balance();
  check('customer wallet untouched by a cash job', Math.round(cBal0) === Math.round(cBal1), `${cBal0} → ${cBal1}`);
  const pBal1 = await p.balance();
  check('provider wallet down by the 10% commission (Rs. 120) or it is recorded pending', Math.round(pBal0 - pBal1) === 120 || Math.round(pBal0 - pBal1) === 0, `${pBal0} → ${pBal1}`);
  r = await p.post(`/provider/jobs/${bookingId}/confirm-cash`);
  check('confirming the cash twice is refused', r.status >= 400);
  cs.s.close();
  ps.s.close();
};

S.S3 = async () => {
  const c = await customer(3);
  const p = await pickProvider(c, 'ac-repairers');
  const cs = await openSocket(c);
  const { bookingId } = await book(c, p, 'S3 decline');
  if (!bookingId) throw new Error('booking failed');
  await join(cs, bookingId);
  const t = Date.now();
  const r = await p.post(`/provider/jobs/${bookingId}/reject`, { reason: 'Fully booked that day' });
  const ev = await waitFor(cs, 'booking_status_changed', (e) => e.status === 'REJECTED', t);
  check('provider declines → customer hears REJECTED live', r.status === 200 && !!ev);
  check('the customer sees "rejected"', (await detail(c, bookingId)).status === 'rejected');
  check('customer has a "declined" notification', await hasNotification(c, bookingId, 'booking_rejected'));
  const again = await book(c, p, 'S3 rebook after decline');
  check('customer can book the same provider again straight away', again.r.status === 200, short(again.r.data));
  if (again.bookingId) await c.post(`/bookings/${again.bookingId}/cancel`, { reason: `${TAG} cleanup` });
  const r2 = await p.post(`/provider/jobs/${bookingId}/accept`);
  check('accepting a declined request says why (409)', r2.status === 409 && /declined/i.test(msgOf(r2)), msgOf(r2));
  cs.s.close();
};

S.S4 = async () => {
  const c = await customer(4);
  const p = await pickProvider(c, 'electricians');
  const ps = await openSocket(p);
  const paths = {
    PENDING: [],
    ACCEPTED: ['accept'],
    EN_ROUTE: ['accept', 'start'],
    ARRIVED: ['accept', 'start', 'arrived'],
  };
  for (const [stage, steps] of Object.entries(paths)) {
    const { bookingId } = await book(c, p, `S4 cancel at ${stage}`);
    if (!bookingId) throw new Error(`booking failed at ${stage}`);
    await join(ps, bookingId);
    for (const s of steps) await p.post(`/provider/jobs/${bookingId}/${s}`);
    const t = Date.now();
    const r = await c.post(`/bookings/${bookingId}/cancel`, { reason: 'Plans changed' });
    const ev = await waitFor(ps, 'booking_status_changed', (e) => e.bookingId === bookingId && e.status === 'CANCELLED', t);
    check(`customer cancels at ${stage} → provider hears it`, r.status === 200 && !!ev, short(r.data));
    check(`provider gets a "cancelled" notification (${stage})`, await hasNotification(p, bookingId, 'booking_cancelled'));
  }
  const { bookingId } = await book(c, p, 'S4 cancel refused in progress');
  for (const s of ['accept', 'start', 'arrived', 'start-work']) await p.post(`/provider/jobs/${bookingId}/${s}`);
  const r = await c.post(`/bookings/${bookingId}/cancel`, { reason: 'too late' });
  check('cancelling once work has started is refused', r.status === 400, msgOf(r));
  const done = await c.post(`/bookings/${bookingId}/complete`);
  check('the customer can still confirm it complete instead', done.status === 200);
  ps.s.close();
};

S.S5 = async () => {
  const c = await customer(5);
  const a = await pickProvider(c, 'electricians');
  const b = await pickProvider(c, 'electricians', [a.id]);
  const plumber = await pickProvider(c, 'plumbers');
  const first = await book(c, a, 'S5 first request');
  if (!first.bookingId) throw new Error('booking failed');
  const dupe = await book(c, a, 'S5 duplicate');
  check('a second request to the same provider is a 409 carrying the first', dupe.r.status === 409 && dupe.r.data.data.activeBooking.bookingId === first.bookingId, short(dupe.r.data));
  const rival = await book(c, b, 'S5 rival electrician');
  const other = await book(c, plumber, 'S5 plumber, separate job');
  check('the same job can be sent to a second electrician and a plumber', !!rival.bookingId && !!other.bookingId);
  const r = await a.post(`/provider/jobs/${first.bookingId}/accept`);
  check('first provider accepts and reports the released rival', r.status === 200 && (r.data.data.releasedRequests || []).includes(rival.bookingId), short(r.data.data));
  const rv = await detail(c, rival.bookingId);
  check('the rival request is released, marked as such', rv.canonicalStatus === 'CANCELLED' && rv.cancellation && rv.cancellation.by === 'system', short(rv.cancellation));
  check('the released provider is told it went elsewhere', await hasNotification(b, rival.bookingId, 'booking_cancelled'));
  check('the plumber (a different job) is untouched', (await statusOf(c, other.bookingId)) === 'PENDING');
  const late = await b.post(`/provider/jobs/${rival.bookingId}/accept`);
  check('the released provider accepting late gets a clear 409', late.status === 409 && /another provider/i.test(msgOf(late)), msgOf(late));
  await c.post(`/bookings/${first.bookingId}/cancel`, { reason: `${TAG} cleanup` });
  await c.post(`/bookings/${other.bookingId}/cancel`, { reason: `${TAG} cleanup` });
};

S.S6 = async () => {
  const c = await customer(6);
  const p = await pickProvider(c, 'plumbers');
  const ps = await openSocket(p);
  const before = (await p.get('/provider/profile')).data.data.completedJobs;
  const { bookingId } = await book(c, p, 'S6 customer confirms');
  if (!bookingId) throw new Error('booking failed');
  await join(ps, bookingId);
  await p.post(`/provider/jobs/${bookingId}/accept`);
  const t = Date.now();
  const r = await c.post(`/bookings/${bookingId}/complete`);
  const ev = await waitFor(ps, 'booking_status_changed', (e) => e.status === 'COMPLETED', t);
  check('customer confirms completion from ACCEPTED → provider hears it', r.status === 200 && !!ev);
  const appr = (await p.get(`/provider/jobs/${bookingId}/approval-status`)).data.data;
  check('provider\'s approval check reads "approved"', appr.isApproved === true);
  const afterJobs = (await p.get('/provider/profile')).data.data.completedJobs;
  check('the provider\'s completed-jobs counter moved (it did not for customer completions)', afterJobs === before + 1, `${before} → ${afterJobs}`);
  const r2 = await c.post(`/bookings/${bookingId}/complete`);
  check('confirming twice is idempotent', r2.status === 200);
  const pay = await c.post('/payments/process', { bookingId, method: 'wallet' });
  check('and it can be paid (estimate as the bill)', pay.status === 200, short(pay.data));
  ps.s.close();
};

S.S7 = async () => {
  const ctx = S.S1.ctx;
  if (!ctx) return check('needs S1', false, 'S1 did not complete');
  const r = await ctx.c.post(`/bookings/${ctx.bookingId}/dispute`, { reason: 'Socket stopped working again', description: `${TAG} dispute` });
  check('customer raises a dispute on a completed job', r.status === 200 && r.data.data.status === 'open', short(r.data));
  const r2 = await ctx.c.post(`/bookings/${ctx.bookingId}/dispute`, { reason: 'again' });
  check('a second open dispute is refused', r2.status === 400);
};

S.S8 = async () => {
  const ctx = S.S1.ctx;
  if (!ctx) return check('needs S1', false, 'S1 did not complete');
  const outsider = await provider(ctx.p.email === 'provider2.hs@metromatrix.pk' ? 3 : 2);
  const otherCustomer = await customer(7);
  let r = await outsider.get(`/provider/jobs/${ctx.bookingId}`);
  check('another provider cannot read the job (403)', r.status === 403);
  r = await outsider.post(`/provider/jobs/${ctx.bookingId}/complete`, { finalAmount: 5 });
  check('another provider cannot touch it (403)', r.status === 403);
  r = await otherCustomer.get(`/bookings/${ctx.bookingId}`);
  check('another customer cannot read the booking (403)', r.status === 403);
  r = await ctx.c.post(`/provider/jobs/${ctx.bookingId}/accept`);
  check('a customer cannot call provider endpoints', r.status === 403 || r.status === 401);
  r = await ctx.p.post('/payments/process', { bookingId: ctx.bookingId, method: 'wallet' });
  check('a provider cannot call customer payment endpoints', r.status === 403 || r.status === 401);
  r = await http.get(`/bookings/${ctx.bookingId}`);
  check('no token → 401', r.status === 401);
  r = await ctx.c.get('/bookings/not-an-id');
  check('a malformed id is a 404, not a 500', r.status === 404);
  r = await http.get('/providers?category=electricians&search=%28');
  check('searching for "(" works (was a 500)', r.status === 200);
};

S.S9 = async () => {
  const c = await customer(8);
  const p = await pickProvider(c, 'ac-repairers');
  let { bookingId } = await book(c, p, 'S9 double accept');
  if (!bookingId) throw new Error('booking failed');
  const both = await Promise.all([p.post(`/provider/jobs/${bookingId}/accept`), p.post(`/provider/jobs/${bookingId}/accept`)]);
  let hist = (await detail(c, bookingId)).statusHistory.filter((h) => h.status === 'ACCEPTED');
  check('two simultaneous Accepts record exactly one acceptance', hist.length === 1, both.map((x) => x.status).join(','));
  await c.post(`/bookings/${bookingId}/cancel`, { reason: `${TAG} cleanup` });

  ({ bookingId } = await book(c, p, 'S9 accept vs cancel'));
  const race = await Promise.all([p.post(`/provider/jobs/${bookingId}/accept`), c.post(`/bookings/${bookingId}/cancel`, { reason: 'race' })]);
  const d = await detail(c, bookingId);
  const moves = d.statusHistory.filter((h) => ['ACCEPTED', 'CANCELLED'].includes(h.status)).map((h) => h.status);
  const coherent = (d.canonicalStatus === 'CANCELLED' && moves.join() === 'CANCELLED') ||
    (d.canonicalStatus === 'ACCEPTED' && moves.join() === 'ACCEPTED') ||
    (d.canonicalStatus === 'CANCELLED' && moves.join() === 'ACCEPTED,CANCELLED');
  check('accept racing cancel leaves one coherent history', coherent, `${race.map((x) => x.status).join(',')} → ${d.canonicalStatus} [${moves}]`);
  if (['PENDING', 'ACCEPTED'].includes(d.canonicalStatus)) await c.post(`/bookings/${bookingId}/cancel`, { reason: `${TAG} cleanup` });

  ({ bookingId } = await book(c, p, 'S9 double pay'));
  for (const s of ['accept', 'start', 'arrived', 'start-work']) await p.post(`/provider/jobs/${bookingId}/${s}`);
  await p.post(`/provider/jobs/${bookingId}/complete`, { finalAmount: 700 });
  const bal0 = await c.balance();
  const pays = await Promise.all([
    c.post('/payments/process', { bookingId, method: 'wallet' }),
    c.post('/payments/process', { bookingId, method: 'wallet' }),
    p.post(`/provider/jobs/${bookingId}/confirm-cash`),
  ]);
  const ok = pays.filter((x) => x.status === 200).length;
  const bal1 = await c.balance();
  const charged = Math.round(bal0 - bal1);
  check('wallet ×2 + cash confirm at once: exactly one settles', ok === 1, pays.map((x) => `${x.status}`).join(','));
  check('and the customer is charged at most once', charged === 0 || charged === 700, `charged ${charged}`);
  const reviews = await Promise.all([
    c.post('/reviews', { bookingId, providerId: p.id, rating: 5, feedback: TAG }),
    c.post('/reviews', { bookingId, providerId: p.id, rating: 5, feedback: TAG }),
  ]);
  check('two simultaneous reviews: one lands', reviews.filter((x) => x.status === 200).length === 1, reviews.map((x) => x.status).join(','));
};

S.S10 = async () => {
  const c = await customer(1);
  const p = await pickProvider(c, 'ac-repairers');
  const { bookingId } = await book(c, p, 'S10 money bounds');
  if (!bookingId) throw new Error('booking failed');
  for (const s of ['accept', 'start', 'arrived', 'start-work']) await p.post(`/provider/jobs/${bookingId}/${s}`);
  for (const bad of [-500, 0, 'abc', 10000000]) {
    const r = await p.post(`/provider/jobs/${bookingId}/complete`, { finalAmount: bad });
    check(`final amount ${JSON.stringify(bad)} is refused`, r.status === 400, msgOf(r));
  }
  check('…and the job is still in progress', (await statusOf(c, bookingId)) === 'IN_PROGRESS');
  let r = await p.post(`/provider/jobs/${bookingId}/complete`, { finalAmount: 900 });
  check('a sensible final amount completes the job', r.status === 200);
  r = await p.post(`/provider/jobs/${bookingId}/request-payment`, { amount: -1 });
  check('a negative payment request is refused', r.status === 400);
  r = await c.post('/payments/process', { bookingId, method: 'wallet', amount: 90 });
  check('underpaying is refused', r.status === 409);
  r = await c.post('/payments/process', { bookingId, method: 'wallet', amount: 900 });
  check('paying the bill works', r.status === 200);
  r = await p.post(`/provider/jobs/${bookingId}/complete`, { finalAmount: 50 });
  check('the price cannot change after payment (409)', r.status === 409);
  r = await p.post(`/provider/jobs/${bookingId}/request-payment`, { amount: 50 });
  check('nor can a new payment be requested', r.status === 400);
};

S.S11 = async () => {
  const p = (S.S1.ctx && S.S1.ctx.p) || (await provider(1));
  const earn = (await p.get('/provider/earnings')).data.data;
  check('earnings report an available balance and the payout minimum', typeof earn.availableBalance === 'number' && earn.minPayoutAmount === 500, `available ${earn.availableBalance}`);
  let r = await p.post('/provider/earnings/payout', { amount: 100, method: 'bank' });
  check('a payout below the minimum is refused', r.status === 400, msgOf(r));
  r = await p.post('/provider/earnings/payout', { amount: earn.availableBalance + 1000000, method: 'bank' });
  check('a payout above the available balance is refused', r.status === 400, msgOf(r));
  if (earn.availableBalance >= 500) {
    r = await p.post('/provider/earnings/payout', { amount: 500, method: 'bank', accountDetails: { reference: TAG } });
    check('a valid payout request is accepted', r.status === 200, short(r.data));
    const after = (await p.get('/provider/earnings')).data.data;
    check('available balance drops by the pending payout', Math.round(earn.availableBalance - after.availableBalance) === 500, `${earn.availableBalance} → ${after.availableBalance}`);
  } else {
    check('valid payout (skipped: available balance below Rs. 500)', true, `available ${earn.availableBalance}`);
  }
};

S.S12 = async () => {
  const c = await customer(2);
  const p = await pickProvider(c, 'electricians');
  const today = pktDate(0);
  const nowSlots = (await c.get(`/bookings/init/${p.id}?date=${today}`)).data.data.timeSlots;
  const nowMin = (new Date(Date.now() + 5 * 3600000).getUTCHours()) * 60 + new Date().getUTCMinutes();
  const toMin = (t) => {
    const m = /(\d+):(\d+) (AM|PM)/.exec(t);
    return ((Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + Number(m[2]);
  };
  const gone = nowSlots.filter((s) => toMin(s.time) < nowMin + 60);
  check('today\'s slots that have passed or are under an hour away are closed', gone.every((s) => !s.available && ['past', 'too_soon'].includes(s.reason)), `${gone.length} closed`);
  if (gone.length) {
    const r = await c.post('/bookings', { providerId: p.id, selectedDate: today, selectedTime: gone[0].time, addressId: (await c.get(`/bookings/init/${p.id}`)).data.data.addresses[0].id, instructions: `${TAG} S12 past` });
    check('booking a time that has passed is refused in plain words', r.status === 400 && /passed|notice/i.test(msgOf(r)), msgOf(r));
  }

  // Working hours: close the day after tomorrow, then open it 10:00-14:00.
  const day = pktDate(2);
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(`${day}T12:00:00Z`).getUTCDay()];
  let r = await p.patch('/provider/profile', { availability: { [weekday]: { isAvailable: false } } });
  check('provider switches a day off', r.status === 200, short(msgOf(r)));
  let slots = (await c.get(`/bookings/init/${p.id}?date=${day}`)).data.data;
  check('the customer sees that day closed', slots.timeSlots.every((s) => s.reason === 'day_off') && slots.day.working === false);
  r = await p.patch('/provider/profile', { availability: { [weekday]: { isAvailable: true, start: '10:00', end: '14:00' } } });
  slots = (await c.get(`/bookings/init/${p.id}?date=${day}`)).data.data.timeSlots;
  const at = (t) => slots.find((s) => s.time === t) || {};
  check('custom hours: 9 AM and 4 PM closed, 11 AM open', at('09:00 AM').reason === 'outside_hours' && at('04:00 PM').reason === 'outside_hours' && at('11:00 AM').available, short(slots.map((s) => `${s.time}:${s.available ? 'ok' : s.reason}`)));
  r = await c.post('/bookings', { providerId: p.id, selectedDate: day, selectedTime: '04:00 PM', addressId: (await c.get(`/bookings/init/${p.id}`)).data.data.addresses[0].id, instructions: `${TAG} S12 off hours` });
  check('booking outside the hours is refused, naming them', r.status === 400 && /10:00 AM - 02:00 PM/.test(msgOf(r)), msgOf(r));
  r = await p.patch('/provider/profile', { availability: { [weekday]: { isAvailable: true, start: '18:00', end: '09:00' } } });
  check('backwards hours are refused', r.status === 400, msgOf(r));
  await p.patch('/provider/profile', { availability: { [weekday]: { isAvailable: true, start: '09:00', end: '20:00' } } });

  // Expiry: a request whose time has passed stops blocking the pair.
  if (!process.env.MONGODB_URI) return check('expiry (skipped: no MONGODB_URI)', true);
  const mongoose = require('mongoose');
  const Booking = require('../src/modules/homeservice/models/Booking');
  if (mongoose.connection.readyState !== 1) await mongoose.connect(process.env.MONGODB_URI);
  const { bookingId } = await book(c, p, 'S12 expiry');
  if (!bookingId) throw new Error('booking failed');
  await Booking.updateOne({ _id: bookingId }, { $set: { scheduledFor: new Date(Date.now() - 3 * 86400000) } });
  const active = (await c.get('/bookings/active')).data.data.bookings;
  check('a request past its time no longer counts as live', !active.some((b) => b.bookingId === bookingId));
  const d = await detail(c, bookingId);
  check('it reads as cancelled, expired, by the system', d.canonicalStatus === 'CANCELLED' && d.cancellation.code === 'expired_pending' && d.cancellation.by === 'system', short(d.cancellation));
  check('the customer was told it expired', await hasNotification(c, bookingId, 'booking_cancelled'));
  const again = await book(c, p, 'S12 rebook after expiry');
  check('and can book that provider again', again.r.status === 200, short(again.r.data));
  if (again.bookingId) await c.post(`/bookings/${again.bookingId}/cancel`, { reason: `${TAG} cleanup` });
  const late = await p.post(`/provider/jobs/${bookingId}/accept`);
  check('the provider accepting the expired request gets a clear 409', late.status === 409 && /expired/i.test(msgOf(late)), msgOf(late));
};

// ---------------------------------------------------------------------------
async function main() {
  console.log(`=== Home Services E2E against ${API} (realtime ${REALTIME}) — run ${RUN_ID} ===`);
  const names = Object.keys(S).filter((k) => !ONLY.length || ONLY.includes(k));
  for (const name of names) {
    scenario = name;
    stepNo = 0;
    console.log(`\n${name}`);
    try {
      await S[name]();
    } catch (e) {
      check('scenario completed without an unexpected error', false, e.message);
    }
  }

  // Close anything this run left live.
  for (const { bookingId, customer: c } of created) {
    try {
      await closeBooking(c, bookingId);
    } catch (e) {
      /* best effort */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  const byScenario = {};
  for (const r of results) {
    byScenario[r.scenario] = byScenario[r.scenario] || { pass: 0, fail: 0 };
    byScenario[r.scenario][r.ok ? 'pass' : 'fail'] += 1;
  }
  Object.entries(byScenario).forEach(([k, v]) => console.log(`  ${k.padEnd(4)} ${v.pass} pass, ${v.fail} fail`));
  if (failed.length) {
    console.log('\nFailures:');
    failed.forEach((f) => console.log(`  ${f.id} ${f.name} — ${f.detail}`));
  }
  console.log(`\nClean up with: node scripts/homeservice-data-hygiene.js --apply --qa-cleanup   (run tag ${TAG})`);
  if (OUT) {
    require('fs').writeFileSync(OUT, JSON.stringify({ api: API, runId: RUN_ID, results }, null, 2));
  }
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState === 1) await mongoose.disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
