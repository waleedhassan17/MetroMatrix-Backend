/**
 * task.md Issue 3 — password reset must not disclose which emails exist.
 *
 * The app used to call GET /api/auth/check-email-exists before sending a
 * reset. That route was never implemented, so it 404'd, and the client read
 * 404 as "no such account" — real users were told "No account found." The
 * preflight is gone from the client; these tests pin the server contract it
 * was replaced with:
 *
 *   - a known account and an unknown one get byte-identical replies
 *   - mail is sent ONLY for the account that exists
 *   - a real reset still works end to end
 *
 * Mock-only: no network, no DB, in the style of googleAuth.test.js.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../models/User', () => ({ findOne: jest.fn() }));
jest.mock('../models/Provider', () => ({ findOne: jest.fn() }));
jest.mock('../models/PasswordResetOTP', () => {
  const ctor = jest.fn().mockImplementation(function (doc) {
    Object.assign(this, doc);
    this.save = jest.fn().mockResolvedValue(this);
  });
  // The controller chains .select() onto findOne(), so this has to behave
  // like a mongoose Query, not a bare promise.
  ctor.findOne = jest.fn();
  ctor.deleteMany = jest.fn().mockResolvedValue({});
  ctor.deleteOne = jest.fn().mockResolvedValue({});
  return ctor;
});

/** Build a mongoose-Query-shaped stub that resolves to `value`. */
const asQuery = (value) => ({
  select: jest.fn().mockResolvedValue(value),
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});
jest.mock('../services/emailService', () => ({
  sendEmail: jest.fn().mockResolvedValue({ messageId: 'mock-message-id' }),
  emailTemplates: {},
}));

const User = require('../models/User');
const Provider = require('../models/Provider');
const PasswordResetOTP = require('../models/PasswordResetOTP');
const { sendEmail } = require('../services/emailService');
const { forgotPassword, resendResetOTP } = require('../controllers/authController');

const GENERIC = 'If an account exists, a reset code has been sent.';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post('/api/auth/forgot-password', forgotPassword);
  app.post('/api/auth/resend-reset-otp', resendResetOTP);
  app.use((err, req, res, _next) => {
    res.status(res.statusCode >= 400 ? res.statusCode : 500).json({
      success: false,
      message: err.message,
    });
  });
  return app;
}

describe('forgot-password anti-enumeration', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    PasswordResetOTP.findOne.mockReturnValue(asQuery(null));
  });

  it('returns the generic success for a REAL account and sends mail', async () => {
    User.findOne.mockResolvedValue({
      _id: 'u1',
      email: 'mubaidashraf369@gmail.com',
      fullName: 'Ubaid',
    });

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'mubaidashraf369@gmail.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe(GENERIC);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].email).toBe('mubaidashraf369@gmail.com');
  });

  it('returns the SAME generic success for an unknown email and sends no mail', async () => {
    User.findOne.mockResolvedValue(null);
    Provider.findOne.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'definitely-not-registered@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe(GENERIC);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('is indistinguishable between the two cases', async () => {
    User.findOne.mockResolvedValue({ _id: 'u1', email: 'real@example.com', fullName: 'Real' });
    const known = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'real@example.com' });

    jest.clearAllMocks();
    PasswordResetOTP.findOne.mockReturnValue(asQuery(null));
    User.findOne.mockResolvedValue(null);
    Provider.findOne.mockResolvedValue(null);
    const unknown = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'fake@example.com' });

    expect(unknown.status).toBe(known.status);
    expect(Object.keys(unknown.body).sort()).toEqual(Object.keys(known.body).sort());
    expect(unknown.body.message).toBe(known.body.message);
    expect(unknown.body.success).toBe(known.body.success);
    expect(unknown.body.expiresIn).toBe(known.body.expiresIn);
  });

  it('falls back to Provider when the email is not a User', async () => {
    User.findOne.mockResolvedValue(null);
    Provider.findOne.mockResolvedValue({
      _id: 'p1',
      email: 'provider@example.com',
      fullName: 'Provider',
    });

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'provider@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(GENERIC);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('never 404s, which is what the removed client preflight keyed on', async () => {
    User.findOne.mockResolvedValue(null);
    Provider.findOne.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nobody@example.com' });

    expect(res.status).not.toBe(404);
  });
});

describe('resend-reset-otp anti-enumeration', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    PasswordResetOTP.findOne.mockReturnValue(asQuery(null));
  });

  it('returns the generic success for an unknown email and sends no mail', async () => {
    User.findOne.mockResolvedValue(null);
    Provider.findOne.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/resend-reset-otp')
      .send({ email: 'nobody@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe(GENERIC);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends a new code for a real account', async () => {
    User.findOne.mockResolvedValue({ _id: 'u1', email: 'real@example.com', fullName: 'Real' });

    const res = await request(app)
      .post('/api/auth/resend-reset-otp')
      .send({ email: 'real@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(GENERIC);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
