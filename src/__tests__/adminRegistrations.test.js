/**
 * GET /api/admin/analytics — the registrations behind the admin home charts:
 * all-time totals, where a running total over the range starts, and one entry
 * per provider type with its states, its sign-ups per day and what it is made
 * of. Deleted accounts count nowhere.
 */
const path = require('path');
const jestOpenAPI = require('jest-openapi').default;
const { connect, clear, disconnect } = require('../../test/helpers/db');
const { createAdmin, createProvider, createUser } = require('../../test/helpers/factories');
const { api, signIn } = require('../../test/helpers/agent');
const Provider = require('../models/Provider');
const User = require('../models/User');
const Doctor = require('../modules/healthcare/models/Doctor');
const Specialty = require('../modules/healthcare/models/Specialty');
const { stateOf } = require('../services/admin/providerStatus');
const { toDateKey, DEFAULT_TIMEZONE } = require('../utils/time');

jestOpenAPI(path.join(__dirname, '..', '..', 'docs', 'admin.openapi.yaml'));

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

const DAY_MS = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS);
// Straight to the collection: timestamps and the soft-delete hooks stay out of it.
const backdate = (Model, doc, createdAt) => Model.collection.updateOne({ _id: doc._id }, { $set: { createdAt } });
const softDelete = (Model, doc) => Model.collection.updateOne({ _id: doc._id }, { $set: { deletedAt: new Date() } });

const APPROVED = { verificationStatus: 'approved' };
const PENDING = { verificationStatus: 'pending', submittedAt: new Date() };
const INCOMPLETE = { verificationStatus: 'pending', submittedAt: null };
const REJECTED = { verificationStatus: 'rejected' };
const SUSPENDED = { verificationStatus: 'approved', isSuspended: true };

async function seed() {
  // Customers: two this month, one from before the range, one deleted.
  await createUser();
  await createUser();
  await backdate(User, await createUser(), daysAgo(40));
  await softDelete(User, await createUser());

  // Doctors: specialty from the Doctor record, else the provider's own text.
  const cardiology = await Specialty.create({ name: 'Cardiology' });
  const a = await createProvider({ providerType: 'doctor', providerSubType: null, ...APPROVED });
  const b = await createProvider({ providerType: 'doctor', providerSubType: null, ...PENDING });
  await Doctor.create({ providerId: a._id, specialtyId: cardiology._id });
  await Doctor.create({ providerId: b._id, specialtyId: cardiology._id });
  await backdate(Provider, b, daysAgo(2));
  await createProvider({ providerType: 'doctor', providerSubType: null, specialty: ' dermatology ', ...INCOMPLETE });

  // Home service: two this month, one from before the range, one deleted.
  await createProvider({ providerType: 'home_service', providerSubType: 'electrician', ...APPROVED });
  await createProvider({ providerType: 'home_service', providerSubType: 'plumber', ...SUSPENDED });
  await backdate(Provider, await createProvider({ providerType: 'home_service', providerSubType: 'electrician', ...REJECTED }), daysAgo(40));
  await softDelete(Provider, await createProvider({ providerType: 'home_service', providerSubType: 'plumber', ...APPROVED }));

  // Vendors: eight categories' worth — "Fashion" twice, spelled two ways.
  for (const category of ['Fashion', 'fashion ', 'Food', 'Toys', 'Books', 'Tech', 'Home', 'Garden']) {
    await createProvider({ providerType: 'vendor', providerSubType: null, category, ...APPROVED });
  }

  // Signed up, type not chosen yet.
  await createProvider({ providerType: 'pending', providerSubType: null, ...INCOMPLETE });
}

async function registrations(query = {}) {
  const s = await signIn(await createAdmin({ permissions: { canViewAnalytics: true } }));
  const res = await api().get('/api/admin/analytics').query(query).set('Authorization', s.bearer());
  expect(res.status).toBe(200);
  expect(res).toSatisfyApiSpec();
  return res.body.data;
}

describe('registrations analytics', () => {
  it('counts every customer and provider now, and where a running total starts', async () => {
    await seed();
    const d = await registrations();

    expect(d.users).toMatchObject({ total: 3, before: 1, registered: 2 });
    expect(d.users.daily).toHaveLength(30);
    expect(d.users.before + d.users.daily.reduce((n, x) => n + x.count, 0)).toBe(d.users.total);

    expect(d.providers.total).toBe(3 + 3 + 8 + 1);
    expect(d.providers.before).toBe(1);
    expect(d.providers.types.map((t) => t.type)).toEqual(['doctor', 'home_service', 'vendor', 'pending']);
    expect(d.providers.types.reduce((n, t) => n + t.total, 0)).toBe(d.providers.total);
  });

  it('gives each provider type its states, its sign-ups per day and what it is made of', async () => {
    await seed();
    const d = await registrations();
    const type = (t) => d.providers.types.find((x) => x.type === t);

    const doctors = type('doctor');
    expect(doctors.byState).toEqual({ incomplete: 1, pending: 1, approved: 1, rejected: 0, suspended: 0 });
    expect(doctors.registered).toBe(3);
    const twoDaysAgo = toDateKey(daysAgo(2), DEFAULT_TIMEZONE);
    expect(doctors.daily.find((x) => x.date === twoDaysAgo).count).toBeGreaterThanOrEqual(1);
    expect(doctors.breakdown).toEqual({
      field: 'specialty',
      items: [
        { key: 'cardiology', label: 'Cardiology', count: 2 },
        { key: 'dermatology', label: 'dermatology', count: 1 },
      ],
      other: 0,
    });

    const homeService = type('home_service');
    expect(homeService.total).toBe(3);
    expect(homeService.byState).toEqual({ incomplete: 0, pending: 0, approved: 1, rejected: 1, suspended: 1 });
    expect(homeService.registered).toBe(2);
    expect(homeService.daily.reduce((n, x) => n + x.count, 0)).toBe(2);
    expect(homeService.breakdown.items).toEqual([
      { key: 'electrician', label: 'electrician', count: 2 },
      { key: 'plumber', label: 'plumber', count: 1 },
    ]);

    const vendors = type('vendor');
    expect(vendors.total).toBe(8);
    expect(vendors.breakdown.items[0]).toEqual({ key: 'fashion', label: 'Fashion', count: 2 });
    expect(vendors.breakdown.items).toHaveLength(6);
    expect(vendors.breakdown.items.reduce((n, x) => n + x.count, 0) + vendors.breakdown.other).toBe(8);
    expect(vendors.breakdown.other).toBe(1);

    expect(type('pending')).toMatchObject({ total: 1, breakdown: null });
  });

  it('puts each provider in the same state the rest of the console shows', async () => {
    await seed();
    const d = await registrations();
    const expected = {};
    for (const p of await Provider.find({}).lean()) {
      const t = ['doctor', 'home_service', 'vendor'].includes(p.providerType) ? p.providerType : 'pending';
      expected[t] = expected[t] || { incomplete: 0, pending: 0, approved: 0, rejected: 0, suspended: 0 };
      expected[t][stateOf(p)] += 1;
    }
    for (const t of d.providers.types) {
      expect(t.byState).toEqual(expected[t.type] || { incomplete: 0, pending: 0, approved: 0, rejected: 0, suspended: 0 });
    }
  });

  it('answers with zeros, not gaps, on an empty platform', async () => {
    const d = await registrations({ from: '2026-01-01', to: '2026-01-07' });
    expect(d.users).toMatchObject({ total: 0, before: 0, registered: 0 });
    expect(d.users.daily).toHaveLength(7);
    for (const t of d.providers.types) {
      expect(t.total).toBe(0);
      expect(t.daily).toHaveLength(7);
    }
  });

  it('is for admins who may view analytics', async () => {
    const s = await signIn(await createAdmin({ permissions: { canViewAnalytics: false } }));
    const res = await api().get('/api/admin/analytics').set('Authorization', s.bearer());
    expect(res.status).toBe(403);
  });
});
