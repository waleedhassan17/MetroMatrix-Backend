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
  const res = await patch({ commissionPercent: 12, matchingWeights: { distance: 0.5, rating: 0.3, availability: 0.2 }, reason: 'Q4 pricing' });
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ commissionPercent: 12, matchingWeights: { distance: 0.5, rating: 0.3, availability: 0.2 } });
});

it.each([
  [{ commissionPercent: -5 }, 'commissionPercent'],
  [{ commissionPercent: 'abc' }, 'commissionPercent'],
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
  expect(after.body.data.commissionPercent).toBe(10);
});
