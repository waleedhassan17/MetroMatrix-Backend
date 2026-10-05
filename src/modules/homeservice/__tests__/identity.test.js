jest.mock('../../../sockets', () => ({
  pushToUser: jest.fn().mockResolvedValue(true),
  emitToBooking: jest.fn().mockResolvedValue(true),
}));

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const identity = require('../services/identityService');

const BOOKING = '64b7f0c2a1b2c3d4e5f60718';

describe('identity tokens', () => {
  it('are short enough for the cheapest NFC sticker and carry no secrets in clear', () => {
    const t = identity.issue(BOOKING);
    expect(t.token).toMatch(/^mmid1\.[a-f0-9]{24}\.[A-Za-z0-9_-]{12}\.\d{10}\.[A-Za-z0-9_-]{22}$/);
    // NTAG213: 144 bytes of NDEF. URI record header + TLV ≈ 8 bytes.
    expect(t.nfcUri.length + 8).toBeLessThanOrEqual(137);
    expect(t.nfcUri).toBe(`metromatrix://verify?t=${t.token}&via=nfc`);
    expect(t.qrPayload).toBe(`metromatrix://verify?t=${t.token}&via=qr`);
    expect(t.code).toMatch(/^\d{6}$/);
    expect(t.stored.codeHash).not.toContain(t.code);
    expect(t.stored.nonceHash).toHaveLength(64);
  });

  it('read back from the raw token, a QR payload or the NFC URI', () => {
    const t = identity.issue(BOOKING);
    expect(identity.readToken(t.token).bookingId).toBe(BOOKING);
    expect(identity.readToken(t.nfcUri).nonceHash).toBe(t.stored.nonceHash);
    expect(identity.readToken(t.qrPayload).bookingId).toBe(BOOKING);
    expect(() => identity.readToken('metromatrix://verify?via=qr')).toThrow(/isn't a MetroMatrix ID/);
    expect(identity.readToken(` ${encodeURI(t.nfcUri)} `).bookingId).toBe(BOOKING);
  });

  it('refuse a forged, altered or expired token', () => {
    const t = identity.issue(BOOKING);
    const otherBooking = t.token.replace(BOOKING, '64b7f0c2a1b2c3d4e5f60719');
    expect(() => identity.readToken(otherBooking)).toThrow(/genuine/);
    const sig = t.token.slice(-22);
    const flipped = t.token.slice(0, -22) + (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(() => identity.readToken(flipped)).toThrow(/genuine/);
    expect(() => identity.readToken(t.token, { now: Date.now() + 11 * 60 * 1000 })).toThrow(/expired/);
    expect(() => identity.readToken('hello')).toThrow(/isn't a MetroMatrix ID/);
  });

  it('are bound to the signing secret', () => {
    const t = identity.issue(BOOKING);
    process.env.NFC_TOKEN_SECRET = 'a-different-secret';
    try {
      expect(() => identity.readToken(t.token)).toThrow(/genuine/);
    } finally {
      delete process.env.NFC_TOKEN_SECRET;
    }
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

  it('a scanned token verifies once, moves EN_ROUTE to ARRIVED quietly, and tells the provider', async () => {
    const id = await booking('EN_ROUTE');
    const { body } = await issue(id);
    expect(body.data).toMatchObject({ ttlSeconds: 600 });

    const res = await verify(id, { token: body.data.nfcUri, method: 'nfc' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ verified: true, method: 'nfc', status: 'ARRIVED' });

    const row = await Booking.findById(id).lean();
    expect(row.status).toBe('ARRIVED');
    expect(row.identityCheck).toMatchObject({ method: 'nfc', nonceHash: null, codeHash: null });
    expect(row.statusHistory.at(-1).note).toMatch(/identity check/);
    // The provider hears about it; the customer is NOT pushed "your provider has arrived".
    expect(pushToUser.mock.calls.map((call) => call[2].type)).toEqual(['identity_verified']);
    expect(emitToBooking).toHaveBeenCalledWith(expect.anything(), 'identity_verified', expect.objectContaining({ method: 'nfc' }));
    expect(emitToBooking).toHaveBeenCalledWith(expect.anything(), 'booking_status_changed', expect.objectContaining({ status: 'ARRIVED' }));

    // Single use, and later requests just report the result.
    const again = await verify(id, { token: body.data.token });
    expect(again.body.data).toMatchObject({ verified: true, already: true, method: 'nfc' });
    expect((await issue(id)).body.data).toMatchObject({ alreadyVerified: true, method: 'nfc' });
  });

  it('the 6-digit code works too, and five wrong guesses retire it', async () => {
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

  it('only the newest token counts, and never for another job', async () => {
    const id = await booking('ARRIVED');
    const first = (await issue(id)).body.data.token;
    const second = (await issue(id)).body.data.token;
    expect((await verify(id, { token: first })).body.error).toMatch(/replaced/);

    const other = await booking('ARRIVED');
    expect((await verify(other, { token: second })).body.error).toMatch(/different job/);
    expect((await verify(id, { token: second })).status).toBe(200);
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
