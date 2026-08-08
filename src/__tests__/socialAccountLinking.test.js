/**
 * task.md P2 (Issues 2 & 5) — social sign-in must create-or-link, never
 * dead-end, and must not throw on the fields Google/Facebook can't give us.
 *
 * The existing googleAuth.test.js / facebookAuth.test.js already cover token
 * verification. This file covers what the P2 fixes changed:
 *
 *   - a brand-new social account is created with NO phoneNumber (it used to
 *     be set to '', which failed the model's required+regex rules, so every
 *     first-time Google/Facebook sign-in 500'd)
 *   - an existing password account is LINKED (googleId/facebookId attached),
 *     not rejected with "already exists"
 *   - a provider gets the enum value 'active' for emailVerified, not the
 *     boolean true that fails Provider's enum
 *   - the User/Provider models actually accept those payloads
 */
const express = require('express');
const request = require('supertest');

jest.mock('../config/firebase', () => ({
  verifyGoogleIdToken: jest.fn(),
  isFirebaseInitialized: jest.fn(() => true),
}));
jest.mock('../config/facebook', () => ({
  isFacebookConfigured: jest.fn(() => true),
  validateFacebookAccessToken: jest.fn().mockResolvedValue(true),
}));
jest.mock('axios');
jest.mock('../models/User', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../models/Provider', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../utils/generateToken', () => ({
  generateTokens: jest.fn(() => ({
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
    expiresIn: 15 * 60 * 1000,
  })),
}));

const axios = require('axios');
const { verifyGoogleIdToken } = require('../config/firebase');
const User = require('../models/User');
const Provider = require('../models/Provider');
const { googleLogin, facebookLogin } = require('../controllers/authController');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post('/api/auth/google-login', googleLogin);
  app.post('/api/auth/facebook-login', facebookLogin);
  app.use((err, req, res, _next) => {
    res.status(res.statusCode >= 400 ? res.statusCode : 500).json({
      success: false,
      message: err.message,
    });
  });
  return app;
}

/** A saved doc stub: records what was assigned so we can assert on linking. */
const savedDoc = (fields) => ({
  ...fields,
  save: jest.fn().mockResolvedValue(true),
});

describe('Google login: create-or-link', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    verifyGoogleIdToken.mockResolvedValue({
      uid: 'google-uid-123',
      email: 'NewPerson@Example.com',
      name: 'New Person',
      picture: 'https://example.com/p.jpg',
    });
  });

  it('creates a brand-new user WITHOUT a phone number', async () => {
    User.findOne.mockResolvedValue(null);
    User.create.mockImplementation(async (data) => savedDoc({ _id: 'u-new', ...data }));

    const res = await request(app)
      .post('/api/auth/google-login')
      .send({ idToken: 'valid-token' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.isNewUser).toBe(true);

    const created = User.create.mock.calls[0][0];
    expect(created.email).toBe('newperson@example.com');
    expect(created.googleId).toBe('google-uid-123');
    // The regression under test: '' tripped required + the phone regex.
    expect(created.phoneNumber).toBeUndefined();
    expect(created.phoneNumber).not.toBe('');
  });

  it('links googleId onto an existing PASSWORD account instead of erroring', async () => {
    const existing = savedDoc({
      _id: 'u-existing',
      email: 'newperson@example.com',
      fullName: 'Existing Person',
      password: 'hashed',
      googleId: undefined,
    });
    User.findOne.mockResolvedValue(existing);

    const res = await request(app)
      .post('/api/auth/google-login')
      .send({ idToken: 'valid-token' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.isNewUser).toBe(false);
    // Linked, not duplicated, and definitely not a 409.
    expect(existing.googleId).toBe('google-uid-123');
    expect(existing.save).toHaveBeenCalled();
    expect(User.create).not.toHaveBeenCalled();
    expect(res.body.message).not.toMatch(/already exists/i);
  });

  it('creates a new PROVIDER with the enum emailVerified, not boolean true', async () => {
    Provider.findOne.mockResolvedValue(null);
    Provider.create.mockImplementation(async (data) => savedDoc({ _id: 'p-new', ...data }));

    const res = await request(app)
      .post('/api/auth/google-login')
      .send({ idToken: 'valid-token', userType: 'provider' });

    expect(res.status).toBe(200);
    const created = Provider.create.mock.calls[0][0];
    // Provider.emailVerified is enum('pending','active','inactive').
    expect(created.emailVerified).toBe('active');
    expect(created.adminVerified).toBe('pending');
    expect(created.onboardingStatus).toBe('pending_documents');
    expect(created.phoneNumber).toBeUndefined();
  });
});

describe('Facebook login: create-or-link', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    axios.get.mockResolvedValue({
      data: {
        id: 'fb-id-456',
        name: 'FB Person',
        email: 'fbperson@example.com',
        picture: { data: { url: 'https://example.com/fb.jpg' } },
      },
    });
  });

  it('creates a brand-new user WITHOUT a phone number', async () => {
    User.findOne.mockResolvedValue(null);
    User.create.mockImplementation(async (data) => savedDoc({ _id: 'u-fb', ...data }));

    const res = await request(app)
      .post('/api/auth/facebook-login')
      .send({ accessToken: 'valid-fb-token' });

    expect(res.status).toBe(200);
    const created = User.create.mock.calls[0][0];
    expect(created.facebookId).toBe('fb-id-456');
    expect(created.phoneNumber).toBeUndefined();
  });

  it('links facebookId onto an existing account instead of erroring', async () => {
    const existing = savedDoc({
      _id: 'u-existing',
      email: 'fbperson@example.com',
      fullName: 'Existing',
      password: 'hashed',
      facebookId: undefined,
    });
    User.findOne.mockResolvedValue(existing);

    const res = await request(app)
      .post('/api/auth/facebook-login')
      .send({ accessToken: 'valid-fb-token' });

    expect(res.status).toBe(200);
    expect(existing.facebookId).toBe('fb-id-456');
    expect(User.create).not.toHaveBeenCalled();
    expect(res.body.message).not.toMatch(/already exists/i);
  });

  it('sets the enum, not boolean true, when linking an existing PROVIDER', async () => {
    const existing = savedDoc({
      _id: 'p-existing',
      email: 'fbperson@example.com',
      fullName: 'Existing Provider',
      emailVerified: 'pending',
      canLogin: false,
    });
    Provider.findOne.mockResolvedValue(existing);

    const res = await request(app)
      .post('/api/auth/facebook-login')
      .send({ accessToken: 'valid-fb-token', userType: 'provider' });

    expect(res.status).toBe(200);
    expect(existing.emailVerified).toBe('active');
    expect(existing.emailVerified).not.toBe(true);
    expect(existing.canLogin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The payloads above are only safe if the real schemas accept them. These use
// the genuine models (validateSync, no DB) rather than the mocks.
// ---------------------------------------------------------------------------
describe('real model validation for social payloads', () => {
  const RealUser = jest.requireActual('../models/User');
  const RealProvider = jest.requireActual('../models/Provider');

  it('User accepts a social account with no phone number', () => {
    const doc = new RealUser({
      email: 'social@example.com',
      fullName: 'Social',
      googleId: 'g-1',
      isVerified: true,
      emailVerified: true,
      phoneNumber: undefined,
    });
    expect(doc.validateSync()).toBeUndefined();
  });

  it('Provider accepts a social account with no phone number', () => {
    const doc = new RealProvider({
      email: 'socialprovider@example.com',
      fullName: 'Social Provider',
      facebookId: 'f-1',
      providerType: 'pending',
      canLogin: true,
      isApproved: false,
      emailVerified: 'active',
      adminVerified: 'pending',
      status: 'email_verified',
      onboardingStatus: 'pending_documents',
    });
    expect(doc.validateSync()).toBeUndefined();
  });

  it('still REQUIRES a phone number on a password account', () => {
    const doc = new RealUser({
      email: 'pw@example.com',
      fullName: 'Password User',
      password: 'secret123',
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err.errors.phoneNumber).toBeDefined();
  });

  it('still rejects a malformed phone number', () => {
    const doc = new RealUser({
      email: 'pw2@example.com',
      fullName: 'Password User',
      password: 'secret123',
      phoneNumber: 'not-a-number',
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err.errors.phoneNumber.message).toMatch(/valid phone number/i);
  });

  it('rejects boolean true for Provider.emailVerified (the enum trap)', () => {
    const doc = new RealProvider({
      email: 'enum@example.com',
      fullName: 'Enum Provider',
      googleId: 'g-2',
      providerType: 'pending',
      emailVerified: true,
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err.errors.emailVerified).toBeDefined();
  });
});
