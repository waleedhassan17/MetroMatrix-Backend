/**
 * Home-service refunds can never exceed what the customer paid — across the
 * admin refund and dispute refunds, and under concurrent requests.
 */
const { connect, clear, disconnect } = require('../../../../test/helpers/db');
const { createAdmin, createUser, createProvider } = require('../../../../test/helpers/factories');
const { api, signIn } = require('../../../../test/helpers/agent');
const Booking = require('../models/Booking');
const Dispute = require('../models/Dispute');
const Wallet = require('../../../models/Wallet');

let s;
let customer;
let provider;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  s = await signIn(await createAdmin({ permissions: { canManageHomeServices: true, canManageFinance: true } }));
  customer = await createUser();
  provider = await createProvider();
});

const paidBooking = (price = 2000, paymentStatus = 'paid') =>
  Booking.create({
    customer: customer._id,
    provider: provider._id,
    serviceCategory: 'electricians',
    scheduledFor: new Date(Date.now() - 86400000),
    address: { line1: '1 Test Road' },
    status: 'COMPLETED',
    pricing: { estimatedPrice: price, finalPrice: price },
    payment: { status: paymentStatus, method: 'wallet', requestedAmount: price, paidAt: new Date() },
  });

const refund = (id, body) => api().post(`/api/admin/bookings/${id}/refund`).set('Authorization', s.bearer()).send(body);
const balance = async () => (await Wallet.findOne({ owner: customer._id, ownerType: 'User' }))?.balance ?? 0;

it('refunds the remainder by default, then refuses a second full refund', async () => {
  const b = await paidBooking(2000);
  const first = await refund(b._id, { reason: 'Provider no-show' });
  expect(first.status).toBe(200);
  expect(first.body.data).toMatchObject({ refunded: true, amount: 2000, remainingRefundable: 0 });

  const second = await refund(b._id, { reason: 'Tapped twice' });
  expect(second.status).toBe(409);
  expect(second.body.error.code).toBe('CONFLICT');
  expect(await balance()).toBe(2000);
});

it('allows partial refunds up to what was paid, not beyond', async () => {
  const b = await paidBooking(2000);
  expect((await refund(b._id, { amount: 500, reason: 'Late arrival' })).status).toBe(200);
  const tooMuch = await refund(b._id, { amount: 1600, reason: 'More' });
  expect(tooMuch.status).toBe(400);
  expect(tooMuch.body.error.code).toBe('VALIDATION_FAILED');
  expect((await refund(b._id, { amount: 1500, reason: 'Rest' })).status).toBe(200);
  expect(await balance()).toBe(2000);

  const detail = await api().get(`/api/admin/bookings/${b._id}`).set('Authorization', s.bearer());
  expect(detail.body.data.refund).toEqual({ paid: 2000, refunded: 2000, remaining: 0 });
});

it('refuses to refund an unpaid booking', async () => {
  const b = await paidBooking(2000, 'unpaid');
  const res = await refund(b._id, { reason: 'x' });
  expect(res.status).toBe(409);
  expect(await balance()).toBe(0);
});

it('a dispute refund counts against the same cap', async () => {
  const b = await paidBooking(2000);
  await refund(b._id, { amount: 1500, reason: 'Partial' });
  const dispute = await Dispute.create({
    booking: b._id,
    raisedBy: { id: customer._id, role: 'customer' },
    againstRole: 'provider',
    reason: 'Poor work',
    status: 'open',
  });
  const res = await api()
    .patch(`/api/admin/disputes/${dispute._id}`)
    .set('Authorization', s.bearer())
    .send({ status: 'resolved', resolution: 'Refund', refundAmount: 1000, reason: 'Upheld' });
  expect(res.status).toBe(400);
  expect(await balance()).toBe(1500);
});

it('two refunds racing for the same remainder pay out once', async () => {
  const b = await paidBooking(2000);
  const results = await Promise.all([refund(b._id, { reason: 'a' }), refund(b._id, { reason: 'b' })]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await balance()).toBe(2000);
});
