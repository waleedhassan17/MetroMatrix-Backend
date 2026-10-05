const { normaliseReading } = require('../services/vitalsService');

const now = Date.parse('2026-10-02T10:00:00Z');
const at = '2026-10-02T09:58:00Z';

describe('vital-sign validation', () => {
  it('keeps a heart-rate reading from a Bluetooth monitor', () => {
    expect(normaliseReading({ type: 'heart_rate', bpm: 72.4, measuredAt: at, source: { kind: 'ble', deviceName: 'Polar H10' }, clientId: 'a1' }, { now })).toEqual({
      doc: { type: 'heart_rate', heartRate: { bpm: 72 }, measuredAt: new Date(at), source: { kind: 'ble', deviceName: 'Polar H10' }, clientId: 'a1' },
    });
  });

  it('estimates mean arterial pressure when the monitor sends none', () => {
    const { doc } = normaliseReading({ type: 'blood_pressure', systolic: 120, diastolic: 80, measuredAt: at }, { now });
    expect(doc.bloodPressure).toEqual({ systolic: 120, diastolic: 80, meanArterial: 93.3 });
    expect(doc.source).toEqual({ kind: 'manual', deviceName: '' });
  });

  it('keeps the monitor\'s own MAP and pulse', () => {
    const { doc } = normaliseReading({ type: 'blood_pressure', bloodPressure: { systolic: 131, diastolic: 84, meanArterial: 99, pulse: 64 }, measuredAt: at }, { now });
    expect(doc.bloodPressure).toEqual({ systolic: 131, diastolic: 84, meanArterial: 99, pulse: 64 });
  });

  it.each([
    [{ type: 'heart_rate', bpm: 300 }, /25–250/],
    [{ type: 'heart_rate', bpm: 'abc' }, /25–250/],
    [{ type: 'blood_pressure', systolic: 80, diastolic: 90 }, /higher than diastolic/],
    [{ type: 'blood_pressure', systolic: 300, diastolic: 90 }, /Systolic/],
    [{ type: 'blood_pressure', systolic: 120, diastolic: 80, pulse: 5 }, /Pulse/],
    [{ type: 'glucose', value: 5 }, /type must be/],
  ])('refuses %j', (r, msg) => {
    expect(normaliseReading({ ...r, measuredAt: at }, { now }).error).toMatch(msg);
  });

  it('refuses readings from the future or long ago', () => {
    expect(normaliseReading({ type: 'heart_rate', bpm: 70, measuredAt: '2026-10-02T11:00:00Z' }, { now }).error).toMatch(/future/);
    expect(normaliseReading({ type: 'heart_rate', bpm: 70, measuredAt: '2024-01-01T00:00:00Z' }, { now }).error).toMatch(/year/);
    expect(normaliseReading({ type: 'heart_rate', bpm: 70, measuredAt: 'soon' }, { now }).error).toMatch(/date/);
  });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('vitals endpoints (MongoDB)', () => {
  const mongoose = require('mongoose');
  const express = require('express');
  const request = require('supertest');
  const patient = new mongoose.Types.ObjectId();
  const otherPatient = new mongoose.Types.ObjectId();
  const doctorProvider = new mongoose.Types.ObjectId();
  let app;
  let actAs = { _id: patient };

  beforeAll(async () => {
    await mongoose.connect(URI.replace(/\/[^/]*$/, '/mm_vitals_test'));
    await mongoose.connection.dropDatabase();
    await require('../models/HealthVital').syncIndexes();
    const c = require('../controllers/vitalsController');
    const { requireTreatingDoctor } = require('../middleware/healthcareAuth');
    const doctor = await mongoose.connection.collection('doctors').insertOne({ providerId: doctorProvider, verificationStatus: 'verified', isActive: true });
    await mongoose.connection.collection('appointments').insertOne({ doctorId: doctor.insertedId, patientId: patient });
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = actAs;
      next();
    });
    app.get('/vitals', c.getMyVitals);
    app.post('/vitals', c.addVitals);
    app.delete('/vitals/:id', c.deleteVital);
    app.get('/doctors/me/patients/:patientId/vitals', requireTreatingDoctor, c.getPatientVitals);
    app.use(require('../../../middleware/errorMiddleware').errorHandler);
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  const recent = (min) => new Date(Date.now() - min * 60000).toISOString();

  it('saves good readings, reports bad ones, and never stores a retried batch twice', async () => {
    actAs = { _id: patient };
    const batch = {
      readings: [
        { type: 'heart_rate', bpm: 71, measuredAt: recent(3), source: { kind: 'ble', deviceName: 'HR strap' }, clientId: 'r1' },
        { type: 'blood_pressure', systolic: 118, diastolic: 76, pulse: 66, measuredAt: recent(2), clientId: 'r2' },
        { type: 'heart_rate', bpm: 400, measuredAt: recent(1), clientId: 'r3' },
      ],
    };
    const first = await request(app).post('/vitals').send(batch);
    expect(first.status).toBe(201);
    expect(first.body.data.saved).toHaveLength(2);
    expect(first.body.data.rejected).toEqual([{ index: 2, error: 'Heart rate must be 25–250 bpm' }]);

    const retry = await request(app).post('/vitals').send(batch);
    expect(retry.status).toBe(201);
    expect(retry.body.data.duplicates).toBe(2);

    const list = await request(app).get('/vitals');
    expect(list.body.data.items).toHaveLength(2);
    expect(list.body.data.latest.bloodPressure.bloodPressure).toMatchObject({ systolic: 118, diastolic: 76, pulse: 66 });
    expect(list.body.data.items[0].heartRate).toBeUndefined(); // newest is the BP reading; no empty HR block
  });

  it('a batch with nothing valid is a 400 with the reason', async () => {
    const res = await request(app).post('/vitals').send({ readings: [{ type: 'heart_rate', bpm: 5, measuredAt: recent(1) }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/25–250/);
  });

  it('only the treating doctor sees a patient\'s readings', async () => {
    actAs = { _id: doctorProvider };
    const seen = await request(app).get(`/doctors/me/patients/${patient}/vitals?type=heart_rate`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.items.map((v) => v.heartRate.bpm)).toEqual([71]);
    expect((await request(app).get(`/doctors/me/patients/${otherPatient}/vitals`)).status).toBe(403);
  });

  it('a patient deletes only their own reading', async () => {
    actAs = { _id: patient };
    const { body } = await request(app).get('/vitals');
    const id = body.data.items[0].id;
    actAs = { _id: otherPatient };
    expect((await request(app).delete(`/vitals/${id}`)).status).toBe(404);
    actAs = { _id: patient };
    expect((await request(app).delete(`/vitals/${id}`)).status).toBe(200);
  });
});
