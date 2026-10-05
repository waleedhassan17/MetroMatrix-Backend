/**
 * GET /api/admin/providers/:providerId/analytics — one screen's data for any
 * provider: home-service jobs, a doctor's appointments, a vendor's orders.
 * Money is what the provider was paid (no commission); nothing measured is
 * null, not 0; responses satisfy the admin contract.
 */
const path = require('path');
const mongoose = require('mongoose');
const jestOpenAPI = require('jest-openapi').default;
const { connect, clear, disconnect } = require('../../test/helpers/db');
const { createAdmin, createUser, createProvider } = require('../../test/helpers/factories');
const { api, signIn } = require('../../test/helpers/agent');
const Booking = require('../modules/homeservice/models/Booking');
const ProviderReview = require('../modules/homeservice/models/ProviderReview');
const Doctor = require('../modules/healthcare/models/Doctor');
const Appointment = require('../modules/healthcare/models/Appointment');
const Brand = require('../modules/shopping/models/Brand');
const Order = require('../modules/shopping/models/Order');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');

jestOpenAPI(path.join(__dirname, '..', '..', 'docs', 'admin.openapi.yaml'));

let s;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  s = await signIn(await createAdmin({ permissions: { canApproveProviders: true } }));
});

const get = (id, q = '') => api().get(`/api/admin/providers/${id}/analytics${q}`).set('Authorization', s.bearer());
const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY);
const find = (summary, key) => summary.find((m) => m.key === key);

describe('home-service provider', () => {
  it('counts jobs, pays the full bill, and fills a day per bucket', async () => {
    const provider = await createProvider();
    const customer = await createUser();
    const base = { customer: customer._id, provider: provider._id, serviceCategory: 'electricians', scheduledFor: ago(2) };
    await Booking.collection.insertMany([
      { ...base, status: 'COMPLETED', createdAt: ago(3), pricing: { estimatedPrice: 1500 }, payment: { status: 'paid', paidAt: ago(2), requestedAmount: 2000 } },
      { ...base, status: 'CANCELLED', createdAt: ago(1), pricing: { estimatedPrice: 900 }, payment: { status: 'unpaid' } },
      // Outside 30 days: counts toward the previous range only.
      { ...base, status: 'COMPLETED', createdAt: ago(40), pricing: { estimatedPrice: 1000 }, payment: { status: 'paid', paidAt: ago(40) } },
    ]);
    await ProviderReview.collection.insertOne({ provider: provider._id, customer: customer._id, rating: 4, createdAt: new Date() });
    // Providers get a wallet when they are created.
    const wallet = await Wallet.findOneAndUpdate({ owner: provider._id, ownerType: 'Provider' }, { balance: 2000 }, { new: true, upsert: true });
    await WalletTransaction.collection.insertOne({ wallet: wallet._id, type: 'credit', amount: 2000, source: 'homeservice_payment', status: 'completed' });

    const res = await get(provider._id);
    expect(res.status).toBe(200);
    expect(res).toSatisfyApiSpec();
    const d = res.body.data;
    expect(d).toMatchObject({ type: 'home_service', range: '30d', bucket: 'day' });
    expect(d.series).toHaveLength(30);
    expect(d.series.reduce((n, p) => n + p.count, 0)).toBe(2);
    expect(d.series.reduce((n, p) => n + p.amount, 0)).toBe(2000); // the requested amount, in full
    expect(find(d.summary, 'jobs')).toMatchObject({ value: 2, delta: 100, period: 'range' });
    expect(find(d.summary, 'paid').value).toBe(2000);
    expect(find(d.summary, 'cancellation_rate').value).toBe(50);
    expect(find(d.summary, 'rating')).toMatchObject({ value: 4, count: 1 });
    expect(d.breakdowns.find((b) => b.key === 'status').rows.map((r) => r.key).sort()).toEqual(['CANCELLED', 'COMPLETED']);
    expect(d.recent).toHaveLength(3);
    expect(d.recent[0]).toMatchObject({ kind: 'booking', status: 'CANCELLED', amount: null });
    expect(d.wallet).toEqual({ balance: 2000, lifetimeEarnings: 2000, pendingPayouts: { count: 0, amount: 0 } });

    const year = await get(provider._id, '?range=12m');
    expect(year.body.data.bucket).toBe('month');
    expect(year.body.data.series).toHaveLength(12);
    expect(year.body.data.series.reduce((n, p) => n + p.amount, 0)).toBe(3000);
  });

  it('reports null, not 0, when there is nothing to measure', async () => {
    const provider = await createProvider();
    const res = await get(provider._id);
    const d = res.body.data;
    expect(find(d.summary, 'jobs')).toMatchObject({ value: 0, delta: null });
    expect(find(d.summary, 'cancellation_rate').value).toBeNull();
    expect(find(d.summary, 'completion_rate').value).toBeNull();
    expect(find(d.summary, 'rating').value).toBeNull();
    expect(find(d.summary, 'avg_job_minutes').value).toBeNull();
    expect(d.wallet.balance).toBe(0);
  });
});

it('doctor: appointments and fees, linked to the doctor record', async () => {
  const provider = await createProvider({ providerType: 'doctor', providerSubType: null });
  const patient = await createUser();
  const doctor = await Doctor.collection.insertOne({ providerId: provider._id, rating: 4.5, totalReviews: 2, verificationStatus: 'verified' });
  const doctorId = doctor.insertedId;
  await Appointment.collection.insertMany([
    { patientId: patient._id, doctorId, type: 'video', status: 'completed', createdAt: ago(5), completedAt: ago(4), payment: { status: 'paid', amount: 2500 }, payout: { amount: 2500, commission: 0 } },
    { patientId: patient._id, doctorId, type: 'in-clinic', status: 'confirmed', createdAt: ago(1), startUtc: new Date(Date.now() + DAY), payment: { status: 'unpaid', amount: 0 } },
  ]);
  const res = await get(provider._id, '?range=90d');
  expect(res.status).toBe(200);
  expect(res).toSatisfyApiSpec();
  const d = res.body.data;
  expect(d).toMatchObject({ type: 'doctor', links: { doctorId: String(doctorId) } });
  expect(d.series).toHaveLength(90);
  expect(find(d.summary, 'appointments').value).toBe(2);
  expect(find(d.summary, 'paid').value).toBe(2500);
  expect(find(d.summary, 'upcoming').value).toBe(1);
  expect(find(d.summary, 'rating')).toMatchObject({ value: 4.5, count: 2 });
  expect(d.breakdowns.find((b) => b.key === 'type').rows.map((r) => r.label).sort()).toEqual(['In clinic', 'Video']);
  expect(d.recent[0].kind).toBe('appointment');
});

it('vendor: orders across the brands they own; delivered value in full', async () => {
  const provider = await createProvider({ providerType: 'vendor', providerSubType: null });
  const customer = await createUser();
  const brand = await Brand.collection.insertOne({ name: 'Acme', slug: 'acme', owner: provider._id, status: 'active', isDeleted: false });
  const brandId = brand.insertedId;
  const item = { productId: new mongoose.Types.ObjectId(), brandId, variantId: new mongoose.Types.ObjectId(), productName: 'Kettle', quantity: 2, unitPrice: 1500, totalPrice: 3000 };
  await Order.collection.insertMany([
    { odexId: 'OD-1', brandId, userId: customer._id, items: [item], orderStatus: 'delivered', total: 3150, createdAt: ago(6), deliveredAt: ago(3) },
    { odexId: 'OD-2', brandId, userId: customer._id, items: [item], orderStatus: 'returned', total: 3150, createdAt: ago(2) },
  ]);
  const res = await get(provider._id);
  expect(res).toSatisfyApiSpec();
  const d = res.body.data;
  expect(d.type).toBe('vendor');
  expect(d.links.brands).toEqual([{ id: String(brandId), name: 'Acme' }]);
  expect(find(d.summary, 'orders').value).toBe(2);
  expect(find(d.summary, 'delivered_value').value).toBe(3150);
  expect(find(d.summary, 'return_rate').value).toBe(50);
  expect(d.breakdowns.find((b) => b.key === 'products').rows[0]).toMatchObject({ label: 'Kettle', value: 3000 });
  expect(d.recent.map((r) => r.title)).toEqual(['Order OD-2', 'Order OD-1']);
});

it('provider detail links a vendor to their brands and returns counters', async () => {
  const provider = await createProvider({ providerType: 'vendor', providerSubType: null, totalBookings: 3 });
  await Brand.collection.insertOne({ name: 'Acme', slug: 'acme', owner: provider._id, status: 'active', isDeleted: false });
  const res = await api().get(`/api/admin/providers/${provider._id}`).set('Authorization', s.bearer());
  expect(res).toSatisfyApiSpec();
  expect(res.body.data.links.brands.map((b) => b.name)).toEqual(['Acme']);
  expect(res.body.data.counters.totalBookings).toBe(3);
});

it('refuses an unknown range, an unknown provider, and admins without the permission', async () => {
  const provider = await createProvider();
  const bad = await get(provider._id, '?range=7y');
  expect(bad.status).toBe(400);
  expect(bad.body.error.details.fields[0].field).toBe('range');
  expect(bad).toSatisfyApiSpec();

  const missing = await get(new mongoose.Types.ObjectId());
  expect(missing.status).toBe(404);
  expect(missing).toSatisfyApiSpec();

  const other = await signIn(await createAdmin({ permissions: { canManageShopping: true } }));
  const forbidden = await api().get(`/api/admin/providers/${provider._id}/analytics`).set('Authorization', other.bearer());
  expect(forbidden.status).toBe(403);
  expect(forbidden).toSatisfyApiSpec();
});

it('queue items and notifications about a provider carry providerId', async () => {
  const PayoutRequest = require('../modules/homeservice/models/PayoutRequest');
  const notifications = require('../services/notificationService');
  const provider = await createProvider();
  const payout = await PayoutRequest.create({ provider: provider._id, amount: 900, method: 'bank' });
  await notifications.notifyPayoutRequested(payout, provider.fullName);

  const boss = await signIn(await createAdmin({ role: 'super_admin' }));
  const queue = await api().get('/api/admin/queue?type=payout_request').set('Authorization', boss.bearer());
  expect(queue).toSatisfyApiSpec();
  expect(queue.body.data[0].target).toMatchObject({ type: 'PayoutRequest', providerId: String(provider._id) });

  const list = await api().get('/api/admin/notifications').set('Authorization', boss.bearer());
  expect(list).toSatisfyApiSpec();
  const n = list.body.data.find((x) => x.type === 'payout_requested');
  expect(n.target).toMatchObject({ type: 'PayoutRequest', providerId: String(provider._id) });
});
