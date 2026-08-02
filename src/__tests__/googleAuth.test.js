/**
 * Google auth (google.md, Part F): token-verification and account logic only.
 *
 * What this file DOES prove, against mock tokens with no network/DB calls:
 *   - a valid mock Google ID token creates a user and returns an app JWT
 *   - the same Google identity signing in again is matched, not duplicated
 *   - a Google email matching an existing password account gets linked,
 *     not duplicated (the Part D policy documented in authController.js)
 *   - an invalid/expired token -> 401
 *   - Firebase Admin not configured/failed to init -> 503, not a crash
 *   - GOOGLE_CLIENT_ID/SECRET missing -> the /api/auth/google route
 *     returns 503, not a crash (passport never throws "unknown strategy")
 *
 * What this file DOES NOT prove (and never claims to): that clicking through
 * Google's real account picker in a browser or device actually redirects
 * correctly, or that a live Vercel deployment has the right env vars set.
 * That's GOOGLE_AUTH_TEST.md — a human with a browser has to do that part.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../config/firebase', () => ({
  verifyGoogleIdToken: jest.fn(),
  isFirebaseInitialized: jest.fn(() => true),
}));
jest.mock('../models/User', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../models/Provider', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../utils/generateToken', () => ({
  generateTokens: jest.fn(() => ({
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
    expiresIn: 30 * 24 * 60 * 60 * 1000,
  })),
}));

const { verifyGoogleIdToken } = require('../config/firebase');
const User = require('../models/User');
const { googleLogin, googleSignup } = require('../controllers/authController');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post('/api/auth/google-login', googleLogin);
  app.post('/api/auth/google-signup', googleSignup);
  // Mirrors asyncHandler's behavior of forwarding thrown errors here.
  app.use((err, req, res, _next) => {
    res.status(res.statusCode >= 400 ? res.statusCode : 500).json({
      success: false,
      message: err.message,
    });
  });
  return app;
}

const MOCK_DECODED_TOKEN = {
  uid: 'firebase-uid-123',
  email: 'newuser@example.com',
  name: 'New User',
  picture: 'https://example.com/pic.jpg',
};

describe('POST /api/auth/google-login', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('valid mock ID token + no existing account -> creates user, returns app JWT', async () => {
    verifyGoogleIdToken.mockResolvedValue(MOCK_DECODED_TOKEN);
    User.findOne.mockResolvedValue(null);
    const created = {
      _id: 'u1',
      email: MOCK_DECODED_TOKEN.email,
      fullName: MOCK_DECODED_TOKEN.name,
      googleId: MOCK_DECODED_TOKEN.uid,
      save: jest.fn().mockResolvedValue(undefined),
    };
    User.create.mockResolvedValue(created);

    const res = await request(app)
      .post('/api/auth/google-login')
      .send({ idToken: 'valid-token', userType: 'user' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.accessToken).toBe('mock-access-token');
    expect(User.create).toHaveBeenCalledTimes(1);
    expect(User.create.mock.calls[0][0]).toMatchObject({
      email: 'newuser@example.com',
      googleId: 'firebase-uid-123',
    });
  });

  it('same Google identity signing in again -> matched, no duplicate created', async () => {
    verifyGoogleIdToken.mockResolvedValue(MOCK_DECODED_TOKEN);
    const existing = {
      _id: 'u1',
      email: MOCK_DECODED_TOKEN.email,
      fullName: 'New User',
      googleId: MOCK_DECODED_TOKEN.uid, // already linked from a prior login
      save: jest.fn().mockResolvedValue(undefined),
    };
    User.findOne.mockResolvedValue(existing);

    const res = await request(app)
      .post('/api/auth/google-login')
      .send({ idToken: 'valid-token', userType: 'user' });

    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(false);
    expect(User.create).not.toHaveBeenCalled();
  });

  it('Google email matching an existing password account -> linked, no duplicate', async () => {
    verifyGoogleIdToken.mockResolvedValue(MOCK_DECODED_TOKEN);
    const passwordAccount = {
      _id: 'u1',
      email: MOCK_DECODED_TOKEN.email,
      fullName: 'New User',
      googleId: undefined, // signed up with email/password, never used Google before
      save: jest.fn().mockResolvedValue(undefined),
    };
    User.findOne.mockResolvedValue(passwordAccount);

    const res = await request(app)
      .post('/api/auth/google-login')
      .send({ idToken: 'valid-token', userType: 'user' });

    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(false);
    expect(User.create).not.toHaveBeenCalled();
    // The account-linking policy documented in authController.js: attach
    // the Google id to the existing password account instead of rejecting
    // or creating a second user.
    expect(passwordAccount.googleId).toBe(MOCK_DECODED_TOKEN.uid);
    expect(passwordAccount.save).toHaveBeenCalled();
  });

  it('invalid/expired token -> 401', async () => {
    const invalidTokenError = new Error('Invalid or expired Google token');
    invalidTokenError.code = 'INVALID_TOKEN';
    verifyGoogleIdToken.mockRejectedValue(invalidTokenError);

    const res = await request(app)
      .post('/api/auth/google-login')
      .send({ idToken: 'garbage', userType: 'user' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(User.create).not.toHaveBeenCalled();
  });

  it('Firebase Admin not configured / failed to init -> 503, not a crash', async () => {
    const notConfiguredError = new Error('Firebase Admin SDK is not configured.');
    notConfiguredError.code = 'FIREBASE_NOT_CONFIGURED';
    verifyGoogleIdToken.mockRejectedValue(notConfiguredError);

    const res = await request(app)
      .post('/api/auth/google-login')
      .send({ idToken: 'irrelevant', userType: 'user' });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/auth/google-signup', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('valid mock ID token + no existing account -> creates user, returns app JWT', async () => {
    verifyGoogleIdToken.mockResolvedValue(MOCK_DECODED_TOKEN);
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue({
      _id: 'u1',
      email: MOCK_DECODED_TOKEN.email,
      fullName: MOCK_DECODED_TOKEN.name,
      googleId: MOCK_DECODED_TOKEN.uid,
      save: jest.fn().mockResolvedValue(undefined),
    });

    const res = await request(app)
      .post('/api/auth/google-signup')
      .send({ idToken: 'valid-token', userType: 'user' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.isNewUser).toBe(true);
  });

  it('account already exists for this email -> 409, no duplicate', async () => {
    verifyGoogleIdToken.mockResolvedValue(MOCK_DECODED_TOKEN);
    User.findOne.mockResolvedValue({ _id: 'u1', email: MOCK_DECODED_TOKEN.email });

    const res = await request(app)
      .post('/api/auth/google-signup')
      .send({ idToken: 'valid-token', userType: 'user' });

    expect(res.status).toBe(409);
    expect(User.create).not.toHaveBeenCalled();
  });

  it('invalid/expired token -> 401', async () => {
    const invalidTokenError = new Error('Invalid or expired Google token');
    invalidTokenError.code = 'INVALID_TOKEN';
    verifyGoogleIdToken.mockRejectedValue(invalidTokenError);

    const res = await request(app)
      .post('/api/auth/google-signup')
      .send({ idToken: 'garbage', userType: 'user' });

    expect(res.status).toBe(401);
  });

  it('Firebase Admin not configured / failed to init -> 503, not a crash', async () => {
    const notConfiguredError = new Error('Firebase Admin SDK failed to initialize.');
    notConfiguredError.code = 'FIREBASE_NOT_CONFIGURED';
    verifyGoogleIdToken.mockRejectedValue(notConfiguredError);

    const res = await request(app)
      .post('/api/auth/google-signup')
      .send({ idToken: 'irrelevant', userType: 'user' });

    expect(res.status).toBe(503);
  });

  it('concurrent-signup race (duplicate key on create) -> 409, not 500', async () => {
    verifyGoogleIdToken.mockResolvedValue(MOCK_DECODED_TOKEN);
    User.findOne.mockResolvedValue(null); // both racing requests see "doesn't exist yet"
    const dupError = new Error('E11000 duplicate key error');
    dupError.code = 11000;
    User.create.mockRejectedValue(dupError);

    const res = await request(app)
      .post('/api/auth/google-signup')
      .send({ idToken: 'valid-token', userType: 'user' });

    expect(res.status).toBe(409);
  });
});

describe('GET /api/auth/google (browser OAuth entry point)', () => {
  it('returns 503 without crashing when GOOGLE_CLIENT_ID/SECRET are missing', async () => {
    const googleAuthStatus = require('../config/googleAuthStatus');
    const originalConfigured = googleAuthStatus.configured;
    googleAuthStatus.configured = false;

    try {
      const authRoutes = require('../routes/authRoutes');
      const app = express();
      app.use(express.json());
      app.use('/api/auth', authRoutes);

      const res = await request(app).get('/api/auth/google');

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('GOOGLE_AUTH_NOT_CONFIGURED');
    } finally {
      googleAuthStatus.configured = originalConfigured;
    }
  });
});
