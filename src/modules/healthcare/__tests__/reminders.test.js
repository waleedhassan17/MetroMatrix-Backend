const express = require('express');
const request = require('supertest');

describe('scheduler tick auth', () => {
  const { requireInternalKey } = require('../../../gateway/internalAuth');
  const app = express();
  app.post('/tick', requireInternalKey, (req, res) => res.json({ ok: true }));
  app.use(require('../../../middleware/errorMiddleware').errorHandler);

  beforeAll(() => {
    process.env.INTERNAL_API_KEY = 'k-123';
    process.env.CRON_SECRET = 'cron-456';
  });

  it('accepts the internal key and the Vercel Cron bearer', async () => {
    expect((await request(app).post('/tick').set('x-internal-key', 'k-123')).status).toBe(200);
    expect((await request(app).post('/tick').set('Authorization', 'Bearer cron-456')).status).toBe(200);
  });

  it('refuses anything else, including an empty key', async () => {
    expect((await request(app).post('/tick')).status).toBe(401);
    expect((await request(app).post('/tick').set('x-internal-key', 'wrong')).status).toBe(401);
    expect((await request(app).post('/tick').set('Authorization', 'Bearer nope')).status).toBe(401);
  });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('appointment reminders (MongoDB)', () => {
  const mongoose = require('mongoose');
  jest.doMock('../../../sockets', () => ({ pushToUser: jest.fn().mockResolvedValue(true) }));
  let Appointment;
  let HCNotification;
  let reminders;
  let pushToUser;
  const NOW = new Date('2026-10-01T10:00:00Z');
  const inMin = (m) => new Date(NOW.getTime() + m * 60000);

  beforeAll(async () => {
    await mongoose.connect(URI.replace(/\/[^/]*$/, '/mm_reminder_test'));
    require('../../../models/User');
    require('../../../models/Provider');
    require('../models/Clinic');
    Appointment = require('../models/Appointment');
    HCNotification = require('../models/HCNotification');
    reminders = require('../services/reminderService');
    pushToUser = require('../../../sockets').pushToUser;
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await mongoose.connection.collection('appointments').deleteMany({});
    await mongoose.connection.collection('hcnotifications').deleteMany({});
    pushToUser.mockClear();
  });

  async function appt(overrides) {
    const doc = {
      _id: new mongoose.Types.ObjectId(),
      patientId: new mongoose.Types.ObjectId(),
      doctorId: new mongoose.Types.ObjectId(),
      status: 'confirmed',
      type: 'in-clinic',
      startUtc: inMin(60),
      startTime: '15:00',
      reminderSentAt: null,
      videoReminderSentAt: null,
      ...overrides,
    };
    await mongoose.connection.collection('appointments').insertOne(doc);
    return doc;
  }

  it('reminds once for an appointment about an hour away, never twice', async () => {
    const a = await appt({});
    expect(await reminders.runAppointmentReminders(NOW)).toBe(1);
    expect(await reminders.runAppointmentReminders(NOW)).toBe(0);
    // Two ticks racing still send one.
    await mongoose.connection.collection('appointments').updateOne({ _id: a._id }, { $set: { reminderSentAt: null } });
    const [x, y] = await Promise.all([reminders.runAppointmentReminders(NOW), reminders.runAppointmentReminders(NOW)]);
    expect(x + y).toBe(1);
    expect(await HCNotification.countDocuments({ type: 'appointment_reminder' })).toBe(2);
    expect(pushToUser).toHaveBeenCalledWith(a.patientId, 'user', expect.objectContaining({ type: 'appointment_reminder' }));
  });

  it('ignores appointments too far ahead, already past, or not confirmed', async () => {
    await appt({ startUtc: inMin(180) });
    await appt({ startUtc: inMin(-10) });
    await appt({ status: 'cancelled' });
    await appt({ status: 'pending' });
    expect(await reminders.runAppointmentReminders(NOW)).toBe(0);
  });

  it('video consultations get a 5-minute push, once', async () => {
    const v = await appt({ type: 'video', startUtc: inMin(5) });
    await appt({ type: 'video', startUtc: inMin(40) });
    expect(await reminders.runVideoReminders(NOW)).toBe(1);
    expect(await reminders.runVideoReminders(NOW)).toBe(0);
    expect(pushToUser).toHaveBeenCalledWith(v.patientId, 'user', expect.objectContaining({ type: 'video_call_starting' }));
  });
});
