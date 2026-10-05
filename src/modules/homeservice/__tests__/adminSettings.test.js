/**
 * Home-services settings drive live money and matching; out-of-range values
 * are refused instead of stored.
 */
const { connect, clear, disconnect } = require('../../../../test/helpers/db');
const { createAdmin } = require('../../../../test/helpers/factories');
const { api, signIn } = require('../../../../test/helpers/agent');

let s;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  s = await signIn(await createAdmin({ permissions: { canManageHomeServices: true } }));
});

const patch = (body) => api().patch('/api/admin/homeservice/settings').set('Authorization', s.bearer()).send(body);

it('stores valid values', async () => {
  const res = await patch({ minPayoutAmount: 800, matchingWeights: { distance: 0.5, rating: 0.3, availability: 0.2 }, reason: 'Q4 pricing' });
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ minPayoutAmount: 800, matchingWeights: { distance: 0.5, rating: 0.3, availability: 0.2 } });
  expect(res.body.data.commissionPercent).toBeUndefined();
});

it('has no commission: a stored legacy value is never returned, and setting one is refused', async () => {
  const AdminSettings = require('../../../models/AdminSettings');
  await AdminSettings.collection.updateOne({}, { $set: { 'homeservice.commissionPercent': 10 } }, { upsert: true });
  const read = await api().get('/api/admin/homeservice/settings').set('Authorization', s.bearer());
  expect(read.body.data.commissionPercent).toBeUndefined();

  const res = await patch({ commissionPercent: 5 });
  expect(res.status).toBe(400);
  expect(res.body.error.details.fields.map((f) => f.field)).toContain('commissionPercent');
});

it.each([
  [{ minPayoutAmount: -5 }, 'minPayoutAmount'],
  [{ minPayoutAmount: 'abc' }, 'minPayoutAmount'],
  [{ minPayoutAmount: 5_000_000 }, 'minPayoutAmount'],
  [{ matchingWeights: { distance: 0.9, rating: 0.9, availability: 0.9 } }, 'matchingWeights'],
  [{ matchingWeights: { distance: 0.5 } }, 'matchingWeights'],
  [{ somethingElse: 1 }, 'somethingElse'],
])('refuses %j', async (body, field) => {
  const res = await patch(body);
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('VALIDATION_FAILED');
  expect(res.body.error.details.fields.map((f) => f.field)).toContain(field);
  const after = await api().get('/api/admin/homeservice/settings').set('Authorization', s.bearer());
  expect(after.body.data.minPayoutAmount).toBe(500);
});
