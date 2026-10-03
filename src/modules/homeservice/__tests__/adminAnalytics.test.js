/**
 * Home-services analytics: Pakistan days, and null (not 0) when there is
 * nothing to measure.
 */
const { connect, clear, disconnect } = require('../../../../test/helpers/db');
const { createAdmin, createUser, createProvider } = require('../../../../test/helpers/factories');
const { api, signIn } = require('../../../../test/helpers/agent');
const Booking = require('../models/Booking');

let s;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  s = await signIn(await createAdmin({ permissions: { canManageHomeServices: true } }));
});

const get = (q) => api().get(`/api/admin/homeservice/analytics?${q}`).set('Authorization', s.bearer());

it('reports null rather than 0 when the range has no bookings', async () => {
  const res = await get('from=2026-01-01&to=2026-01-31');
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ averageCompletionMinutes: null, cancellationRate: null, revenue: 0, bookingsOverTime: [] });
});

it('groups bookings by Pakistan day', async () => {
  const customer = await createUser();
  const provider = await createProvider();
  const booking = await Booking.create({
    customer: customer._id,
    provider: provider._id,
    serviceCategory: 'electricians',
    scheduledFor: new Date('2026-03-11T10:00:00Z'),
    address: { line1: '1 Test Road' },
    status: 'PENDING',
  });
  // 20:00 UTC on 9 March is 01:00 on 10 March in Pakistan.
  await Booking.collection.updateOne({ _id: booking._id }, { $set: { createdAt: new Date('2026-03-09T20:00:00Z') } });
  const res = await get('from=2026-03-08T00:00:00Z&to=2026-03-12T00:00:00Z');
  expect(res.body.data.bookingsOverTime).toEqual([{ date: '2026-03-10', count: 1 }]);
  expect(res.body.data.cancellationRate).toBe(0);
});
