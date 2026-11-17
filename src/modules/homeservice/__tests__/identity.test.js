jest.mock('../../../sockets', () => ({
  pushToUser: jest.fn().mockResolvedValue(true),
  emitToBooking: jest.fn().mockResolvedValue(true),
}));

const identity = require('../services/identityService');

const BOOKING = '64b7f0c2a1b2c3d4e5f60718';

describe('identity codes', () => {
  it('are 6 digits, expire in 10 minutes, and are stored only as a hash', () => {
    const now = Date.parse('2026-10-02T10:00:00Z');
    const t = identity.issue(BOOKING, { now });
    expect(t.code).toMatch(/^\d{6}$/);
    expect(t.expiresAt.getTime()).toBe(now + identity.TOKEN_TTL_MS);
    expect(t.stored.codeHash).toHaveLength(64);
    expect(t.stored.codeHash).not.toContain(t.code);
    expect(t.stored).toMatchObject({ attempts: 0, verifiedAt: null, method: null });
    expect(t).not.toHaveProperty('token');
  });

  it('are bound to the booking', () => {
    const t = identity.issue(BOOKING);
    expect(identity.codeHashFor(BOOKING, t.code)).toBe(t.stored.codeHash);
    expect(identity.codeHashFor(BOOKING, ` ${t.code} `)).toBe(t.stored.codeHash);
    expect(identity.codeHashFor('64b7f0c2a1b2c3d4e5f60719', t.code)).not.toBe(t.stored.codeHash);
  });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('doorstep identity check (MongoDB)', () => {
  const mongoose = require('mongoose');
  const express = require('express');
  const request = require('supertest');
  require('../../../models/User');
  require('../../../models/Provider');
  const Booking = require('../models/Booking');
  const { pushToUser, emitToBooking } = require('../../../sockets');
  const { loadBookingWithAccess } = require('../middleware/bookingAccess');
  const c = require('../controllers/identityController');
  const customer = new mongoose.Types.ObjectId();
  const provider = new mongoose.Types.ObjectId();
  let app;
  let actAs;

  beforeAll(async () => {
    await mongoose.connect(URI.replace(/\/[^/]*$/, '/mm_identity_test'));
    await mongoose.connection.dropDatabase();
    await mongoose.connection.collection('users').insertOne({ _id: customer, fullName: 'Ayesha Khan', email: 'a@x', phoneNumber: '1' });
    await mongoose.connection.collection('providers').insertOne({ _id: provider, fullName: 'Bilal Electric', email: 'b@x', phoneNumber: '2', providerType: 'home_service' });
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { _id: actAs };
      next();
    });
    app.post('/provider/jobs/:jobId/identity-token', loadBookingWithAccess, c.issueIdentityToken);
    app.post('/bookings/:id/verify-identity', loadBookingWithAccess, c.verifyIdentity);
    app.use(require('../../../middleware/errorMiddleware').errorHandler);
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(() => jest.clearAllMocks());

  async function booking(status) {
    const b = await Booking.create({
      customer,
      provider,
      status,
      serviceCategory: 'electricians',
      scheduledFor: new Date(Date.now() + 3600e3),
      address: { line1: 'House 1', coordinates: { type: 'Point', coordinates: [74.3, 31.5] } },
      statusHistory: [{ status, changedBy: { id: provider, role: 'provider' }, changedAt: new Date() }],
    });
    return String(b._id);
  }
  const issue = (id) => {
    actAs = provider;
    return request(app).post(`/provider/jobs/${id}/identity-token`).send();
  };
  const verify = (id, body) => {
    actAs = customer;
    return request(app).post(`/bookings/${id}/verify-identity`).send(body);
  };

  it('the code verifies once, moves EN_ROUTE to ARRIVED quietly, and tells the provider', async () => {
    const id = await booking('EN_ROUTE');
    const { body } = await issue(id);
    expect(body.data).toMatchObject({ ttlSeconds: 600 });
    expect(body.data).not.toHaveProperty('token');

    const res = await verify(id, { code: body.data.code });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ verified: true, method: 'code', status: 'ARRIVED' });

    const row = await Booking.findById(id).lean();
    expect(row.status).toBe('ARRIVED');
    expect(row.identityCheck).toMatchObject({ method: 'code', codeHash: null });
    expect(row.statusHistory.at(-1).note).toMatch(/identity check/);
    // The provider hears about it; the customer is NOT pushed "your provider has arrived".
    expect(pushToUser.mock.calls.map((call) => call[2].type)).toEqual(['identity_verified']);
    expect(emitToBooking).toHaveBeenCalledWith(expect.anything(), 'identity_verified', expect.objectContaining({ method: 'code' }));
    expect(emitToBooking).toHaveBeenCalledWith(expect.anything(), 'booking_status_changed', expect.objectContaining({ status: 'ARRIVED' }));

    // Single use, and later requests just report the result.
    const again = await verify(id, { code: body.data.code });
    expect(again.body.data).toMatchObject({ verified: true, already: true, method: 'code' });
    expect((await issue(id)).body.data).toMatchObject({ alreadyVerified: true, method: 'code' });
  });

  it('five wrong guesses retire the code', async () => {
    const id = await booking('ARRIVED');
    const { body } = await issue(id);
    const wrong = body.data.code === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i += 1) {
      const r = await verify(id, { code: wrong });
      expect(r.status).toBe(422);
      expect(r.body.error).toBe(`That code is not right — ${5 - i} ${5 - i === 1 ? 'try' : 'tries'} left`);
    }
    const fifth = await verify(id, { code: wrong });
    expect(fifth.status).toBe(429);
    expect((await verify(id, { code: body.data.code })).status).toBe(422); // retired

    const fresh = await issue(id);
    const ok = await verify(id, { code: fresh.body.data.code });
    expect(ok.body.data).toMatchObject({ verified: true, method: 'code', status: 'ARRIVED' });
  });

  it('only the newest code counts', async () => {
    const id = await booking('ARRIVED');
    const first = (await issue(id)).body.data.code;
    const second = (await issue(id)).body.data.code;
    // One in a million the two codes are equal; only then is there nothing to refuse.
    if (first !== second) expect((await verify(id, { code: first })).status).toBe(422);
    expect((await verify(id, { code: second })).status).toBe(200);
  });

  it('a code issued for another job is refused', async () => {
    const mine = await booking('ARRIVED');
    const theirs = await booking('ARRIVED');
    await issue(mine);
    const theirCode = (await issue(theirs)).body.data.code;
    const row = await Booking.findById(mine).lean();
    // The hash binds the booking id, so their code fails here unless both jobs drew the same digits.
    if (identity.codeHashFor(mine, theirCode) !== row.identityCheck.codeHash) {
      expect((await verify(mine, { code: theirCode })).status).toBe(422);
    }
  });

  it('asks for a code when none is sent', async () => {
    const id = await booking('ARRIVED');
    await issue(id);
    const r = await verify(id, {});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/6-digit code/);
  });

  it('is refused before the provider is on the way, and to anyone but the two parties', async () => {
    const id = await booking('ACCEPTED');
    expect((await issue(id)).status).toBe(409);
    actAs = new mongoose.Types.ObjectId();
    expect((await request(app).post(`/bookings/${id}/verify-identity`).send({ code: '123456' })).status).toBe(403);
    actAs = provider; // the provider cannot verify themselves
    expect((await request(app).post(`/bookings/${id}/verify-identity`).send({ code: '123456' })).status).toBe(403);
  });
});
