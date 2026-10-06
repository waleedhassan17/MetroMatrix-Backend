/**
 * Fixes from the October 2026 QA pass of the admin console:
 *  - wallet search matches literally (a "(" used to answer 500);
 *  - shopping settings are validated, and keep the reason the console asks for;
 *  - healthcare settings keep their reason too;
 *  - an admin notification is created once per dedupeKey even before the
 *    unique index exists (production runs with autoIndex off);
 *  - a return request's notification carries its order.
 */
const mongoose = require('mongoose');
const { connect, clear, disconnect } = require('../../test/helpers/db');
const { createAdmin } = require('../../test/helpers/factories');
const { api, signIn } = require('../../test/helpers/agent');
const AdminAuditLog = require('../models/AdminAuditLog');
const Notification = require('../models/Notification');
const notifications = require('../services/notificationService');

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

describe('admin QA fixes', () => {
  it('wallet search matches the text literally', async () => {
    const s = await signIn(await createAdmin({ permissions: { canManageFinance: true } }));
    const res = await api().get('/api/admin/wallets').query({ search: '(' }).set('Authorization', s.bearer());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('shopping settings refuse a negative or fractional value, and keep the reason', async () => {
    const s = await signIn(await createAdmin({ permissions: { canManageShopping: true } }));
    const bad = await api().patch('/api/shopping/admin/settings').set('Authorization', s.bearer()).send({ shippingFeePerBrand: -5, defaultReturnDays: 2.5 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    expect(bad.body.error.details.fields.map((f) => f.field).sort()).toEqual(['defaultReturnDays', 'shippingFeePerBrand']);
    const nonBoolean = await api().patch('/api/shopping/admin/settings').set('Authorization', s.bearer()).send({ autoApproveProducts: 'yes' });
    expect(nonBoolean.status).toBe(400);

    const ok = await api().patch('/api/shopping/admin/settings').set('Authorization', s.bearer()).send({ autoApproveProducts: false, reason: 'Review every product' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.autoApproveProducts).toBe(false);
    const row = await AdminAuditLog.findOne({ action: /update_settings/ }).sort({ createdAt: -1 });
    expect(row.reason).toBe('Review every product');
  });

  it('healthcare settings keep the reason', async () => {
    const s = await signIn(await createAdmin({ permissions: { canManageHealthcare: true } }));
    const ok = await api().patch('/api/v1/admin/healthcare/settings').set('Authorization', s.bearer()).send({ cancellationWindowHours: 12, reason: 'Fewer late cancellations' });
    expect(ok.status).toBe(200);
    const row = await AdminAuditLog.findOne({ action: /healthcare\.update_settings/ });
    expect(row.reason).toBe('Fewer late cancellations');
  });

  it('a dedupeKey notification is created once even without the unique index', async () => {
    await Notification.init();
    await Notification.collection.dropIndex('dedupeKey_1').catch(() => undefined);
    const drift = { drift: 120, balanced: false };
    await notifications.notifyReconciliationDrift(drift);
    await notifications.notifyReconciliationDrift(drift);
    await notifications.notifyReconciliationDrift(drift);
    expect(await Notification.countDocuments({ type: 'reconciliation_drift' })).toBe(1);
  });

  it("a return request's notification carries its order", async () => {
    const order = new mongoose.Types.ObjectId();
    await notifications.notifyReturnRequested({ _id: new mongoose.Types.ObjectId(), order, reason: 'Wrong size' });
    const n = await Notification.findOne({ type: 'return_requested' });
    expect(String(n.target.orderId)).toBe(String(order));
  });
});
