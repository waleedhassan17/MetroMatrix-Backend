/**
 * Facebook auth (facebook.md, Part G): token-validation and account logic
 * only.
 *
 * What this file DOES prove, against mock tokens with no network/DB calls:
 *   - a valid mock Facebook token WITH email creates a user and returns an
 *     app JWT
 *   - a valid mock Facebook token WITHOUT email is handled per the Part D
 *     policy (clean 400, documented in authController.js) — no crash
 *   - the same Facebook identity signing in again is matched, not duplicated
 *   - a Facebook email matching an existing account gets linked, not
 *     duplicated
 *   - an invalid/expired/not-ours token -> 401
 *   - FACEBOOK_APP_ID/SECRET missing -> 503, not a crash, on both the
 *     mobile token endpoints and the browser OAuth entry point
 *
 * What this file DOES NOT prove: that clicking through Facebook's real
 * login dialog in a browser/device actually works, or that a Tester/
 * Developer role is correctly set up on a Development-mode app. That's
 * FACEBOOK_AUTH_TEST.md — a human with a browser and a role-added account
 * has to do that part.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../config/facebook', () => ({
  isFacebookConfigured: jest.fn(() => true),
  validateFacebookAccessToken: jest.fn().mockResolvedValue({ app_id: 'app-1', is_valid: true }),
}));
jest.mock('axios');
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

const axios = require('axios');
const { isFacebookConfigured, validateFacebookAccessToken } = require('../config/facebook');
const User = require('../models/User');
const { facebookLogin, facebookSignup } = require('../controllers/authController');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post('/api/auth/facebook-login', facebookLogin);
  app.post('/api/auth/facebook-signup', facebookSignup);
  app.use((err, req, res, _next) => {
    res.status(res.statusCode >= 400 ? res.statusCode : 500).json({
      success: false,
      message: err.message,
    });
  });
  return app;
}

const FB_PROFILE_WITH_EMAIL = {
  id: 'fb-id-123',
  name: 'New FB User',
  email: 'newfbuser@example.com',
  picture: { data: { url: 'https://example.com/fb-pic.jpg' } },
};

const FB_PROFILE_NO_EMAIL = {
  id: 'fb-id-456',
  name: 'No Email FB User',
  // email intentionally absent — declined permission
  picture: { data: { url: 'https://example.com/fb-pic-2.jpg' } },
};

describe('POST /api/auth/facebook-login', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    isFacebookConfigured.mockReturnValue(true);
    validateFacebookAccessToken.mockResolvedValue({ app_id: 'app-1', is_valid: true });
    app = buildApp();
  });

  it('valid mock token WITH email + no existing account -> creates user, returns app JWT', async () => {
    axios.get.mockResolvedValue({ data: FB_PROFILE_WITH_EMAIL });
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue({
      _id: 'u1',
      email: FB_PROFILE_WITH_EMAIL.email,
      fullName: FB_PROFILE_WITH_EMAIL.name,
      facebookId: FB_PROFILE_WITH_EMAIL.id,
      save: jest.fn().mockResolvedValue(undefined),
    });

    const res = await request(app)
      .post('/api/auth/facebook-login')
      .send({ accessToken: 'valid-fb-token', userType: 'user' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.accessToken).toBe('mock-access-token');
    expect(validateFacebookAccessToken).toHaveBeenCalledWith('valid-fb-token');
    expect(User.create).toHaveBeenCalledTimes(1);
  });

  it('valid mock token WITHOUT email -> clean 400 (Part D policy), not a crash', async () => {
    axios.get.mockResolvedValue({ data: FB_PROFILE_NO_EMAIL });
    User.findOne.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/facebook-login')
      .send({ accessToken: 'valid-fb-token-no-email', userType: 'user' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message.toLowerCase()).toContain('email');
    expect(User.create).not.toHaveBeenCalled();
  });

  it('same Facebook identity signing in again -> matched, no duplicate created', async () => {
    axios.get.mockResolvedValue({ data: FB_PROFILE_WITH_EMAIL });
    const existing = {
      _id: 'u1',
      email: FB_PROFILE_WITH_EMAIL.email,
      facebookId: FB_PROFILE_WITH_EMAIL.id, // already linked from a prior login
      save: jest.fn().mockResolvedValue(undefined),
    };
    User.findOne.mockResolvedValue(existing);

    const res = await request(app)
      .post('/api/auth/facebook-login')
      .send({ accessToken: 'valid-fb-token', userType: 'user' });

    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(false);
    expect(User.create).not.toHaveBeenCalled();
  });

  it('Facebook email matching an existing password/Google account -> linked, no duplicate', async () => {
    axios.get.mockResolvedValue({ data: FB_PROFILE_WITH_EMAIL });
    const passwordAccount = {
      _id: 'u1',
      email: FB_PROFILE_WITH_EMAIL.email,
      facebookId: undefined, // never used Facebook before
      save: jest.fn().mockResolvedValue(undefined),
    };
    User.findOne.mockResolvedValue(passwordAccount);

    const res = await request(app)
      .post('/api/auth/facebook-login')
      .send({ accessToken: 'valid-fb-token', userType: 'user' });

    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(false);
    expect(User.create).not.toHaveBeenCalled();
    expect(passwordAccount.facebookId).toBe(FB_PROFILE_WITH_EMAIL.id);
    expect(passwordAccount.save).toHaveBeenCalled();
  });

  it('invalid/expired/not-ours token -> 401', async () => {
    const invalidTokenError = new Error('Invalid or expired Facebook token');
    invalidTokenError.code = 'INVALID_TOKEN';
    validateFacebookAccessToken.mockRejectedValue(invalidTokenError);

    const res = await request(app)
      .post('/api/auth/facebook-login')
      .send({ accessToken: 'garbage', userType: 'user' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
    expect(User.create).not.toHaveBeenCalled();
  });

  it('FACEBOOK_APP_ID/SECRET missing -> 503, not a crash', async () => {
    isFacebookConfigured.mockReturnValue(false);

    const res = await request(app)
      .post('/api/auth/facebook-login')
      .send({ accessToken: 'irrelevant', userType: 'user' });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(validateFacebookAccessToken).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/facebook-signup', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    isFacebookConfigured.mockReturnValue(true);
    validateFacebookAccessToken.mockResolvedValue({ app_id: 'app-1', is_valid: true });
    app = buildApp();
  });

  it('valid mock token WITH email + no existing account -> creates user, returns app JWT', async () => {
    axios.get.mockResolvedValue({ data: FB_PROFILE_WITH_EMAIL });
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue({
      _id: 'u1',
      email: FB_PROFILE_WITH_EMAIL.email,
      fullName: FB_PROFILE_WITH_EMAIL.name,
      facebookId: FB_PROFILE_WITH_EMAIL.id,
      save: jest.fn().mockResolvedValue(undefined),
    });

    const res = await request(app)
      .post('/api/auth/facebook-signup')
      .send({ accessToken: 'valid-fb-token', userType: 'user' });

    expect(res.status).toBe(201);
    expect(res.body.isNewUser).toBe(true);
  });

  it('valid mock token WITHOUT email -> clean 400, not a crash', async () => {
    axios.get.mockResolvedValue({ data: FB_PROFILE_NO_EMAIL });
    User.findOne.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/facebook-signup')
      .send({ accessToken: 'valid-fb-token-no-email', userType: 'user' });

    expect(res.status).toBe(400);
    expect(User.create).not.toHaveBeenCalled();
  });

  it('account already exists for this email -> 409, no duplicate', async () => {
    axios.get.mockResolvedValue({ data: FB_PROFILE_WITH_EMAIL });
    User.findOne.mockResolvedValue({ _id: 'u1', email: FB_PROFILE_WITH_EMAIL.email });

    const res = await request(app)
      .post('/api/auth/facebook-signup')
      .send({ accessToken: 'valid-fb-token', userType: 'user' });

    expect(res.status).toBe(409);
    expect(User.create).not.toHaveBeenCalled();
  });

  it('invalid/expired/not-ours token -> 401', async () => {
    const invalidTokenError = new Error('Facebook token was not issued for this app');
    invalidTokenError.code = 'INVALID_TOKEN';
    validateFacebookAccessToken.mockRejectedValue(invalidTokenError);

    const res = await request(app)
      .post('/api/auth/facebook-signup')
      .send({ accessToken: 'garbage', userType: 'user' });

    expect(res.status).toBe(401);
  });

  it('FACEBOOK_APP_ID/SECRET missing -> 503, not a crash', async () => {
    isFacebookConfigured.mockReturnValue(false);

    const res = await request(app)
      .post('/api/auth/facebook-signup')
      .send({ accessToken: 'irrelevant', userType: 'user' });

    expect(res.status).toBe(503);
  });

  it('concurrent-signup race (duplicate key on create) -> 409, not 500', async () => {
    axios.get.mockResolvedValue({ data: FB_PROFILE_WITH_EMAIL });
    User.findOne.mockResolvedValue(null); // both racing requests see "doesn't exist yet"
    const dupError = new Error('E11000 duplicate key error');
    dupError.code = 11000;
    User.create.mockRejectedValue(dupError);

    const res = await request(app)
      .post('/api/auth/facebook-signup')
      .send({ accessToken: 'valid-fb-token', userType: 'user' });

    expect(res.status).toBe(409);
  });
});

describe('GET /api/auth/facebook (browser OAuth entry point)', () => {
  it('returns 503 without crashing when FACEBOOK_APP_ID/SECRET are missing', async () => {
    const facebookAuthStatus = require('../config/facebookAuthStatus');
    const originalConfigured = facebookAuthStatus.configured;
    facebookAuthStatus.configured = false;

    try {
      const authRoutes = require('../routes/authRoutes');
      const app = express();
      app.use(express.json());
      app.use('/api/auth', authRoutes);

      const res = await request(app).get('/api/auth/facebook');

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('FACEBOOK_AUTH_NOT_CONFIGURED');
    } finally {
      facebookAuthStatus.configured = originalConfigured;
    }
  });
});
