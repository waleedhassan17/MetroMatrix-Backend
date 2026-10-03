/**
 * Healthcare specialties: deactivate (DELETE) and reactivate (PATCH isActive),
 * both audited. Reactivation used to exist only in the app's local state.
 */
const { connect, clear, disconnect } = require('../../test/helpers/db');
const { createAdmin } = require('../../test/helpers/factories');
const { api, signIn } = require('../../test/helpers/agent');
const Specialty = require('../modules/healthcare/models/Specialty');
const AdminAuditLog = require('../models/AdminAuditLog');

let bearer;

beforeAll(connect);
afterAll(async () => {
  await clear();
  await disconnect();
});

beforeEach(async () => {
  await clear();
  const admin = await createAdmin();
  bearer = (await signIn(admin)).bearer();
});

it('deactivates and reactivates a specialty, auditing both', async () => {
  const specialty = await Specialty.create({ name: 'Dermatology', icon: 'body' });

  const off = await api().delete(`/api/v1/admin/specialties/${specialty._id}`).set('Authorization', bearer).send({ reason: 'Merged' });
  expect(off.status).toBe(200);
  expect(off.body.data).toEqual({ id: String(specialty._id), isActive: false });

  const on = await api()
    .patch(`/api/v1/admin/specialties/${specialty._id}`)
    .set('Authorization', bearer)
    .send({ isActive: true, reason: 'Needed again' });
  expect(on.status).toBe(200);
  expect(on.body.data.isActive).toBe(true);
  expect((await Specialty.findById(specialty._id)).isActive).toBe(true);

  const actions = (await AdminAuditLog.find({ targetId: specialty._id }).sort({ createdAt: 1 })).map((r) => r.action);
  expect(actions).toEqual(['healthcare.specialty.deactivate', 'healthcare.specialty.reactivate']);
});

it('a plain edit does not reactivate, and isActive:false is ignored (DELETE owns deactivation)', async () => {
  const specialty = await Specialty.create({ name: 'Cardiology', icon: 'heart', isActive: false });
  const res = await api()
    .patch(`/api/v1/admin/specialties/${specialty._id}`)
    .set('Authorization', bearer)
    .send({ description: 'Heart and vessels' });
  expect(res.status).toBe(200);
  expect(res.body.data.isActive).toBe(false);

  const active = await Specialty.create({ name: 'Neurology', icon: 'pulse' });
  const ignored = await api().patch(`/api/v1/admin/specialties/${active._id}`).set('Authorization', bearer).send({ isActive: false });
  expect(ignored.status).toBe(200);
  expect(ignored.body.data.isActive).toBe(true);
});
