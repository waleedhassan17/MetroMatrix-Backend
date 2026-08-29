const crypto = require('crypto');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const JwtStrategy = require('passport-jwt').Strategy;
const ExtractJwt = require('passport-jwt').ExtractJwt;
const User = require('../models/User');
const Provider = require('../models/Provider');
const googleAuthStatus = require('./googleAuthStatus');
const facebookAuthStatus = require('./facebookAuthStatus');

// JWT Strategy
//
// The fallback exists so require() cannot crash when JWT_SECRET is absent at
// build time (serverless cold start) — throwing here would fail the build, not
// just the request. But it used to be the literal string 'missing-jwt-secret',
// which is committed in a public repo: with JWT_SECRET unset, this strategy
// would happily VERIFY tokens anyone could forge against a key they can read.
//
// A random per-process key keeps require() safe while making that impossible.
// No real token validates against it, so every request 401s — the same outcome
// as a misconfigured server should have, and the opposite of trusting forgeries.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error(
    '[auth] JWT_SECRET is not set — the JWT strategy will reject every token. ' +
      'Set it in the environment; this is a misconfiguration, not a mode.'
  );
}
const jwtOptions = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: JWT_SECRET || crypto.randomBytes(32).toString('hex'),
};

passport.use(
  new JwtStrategy(jwtOptions, async (payload, done) => {
    try {
      let user = await User.findById(payload.id);
      
      if (!user) {
        user = await Provider.findById(payload.id);
      }
      
      if (user) {
        return done(null, user);
      }
      
      return done(null, false);
    } catch (error) {
      return done(error, false);
    }
  })
);

// Google Strategy
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  // Prefer the explicit callback URL (set this in Vercel) over deriving it
  // from BACKEND_URL, so the deployed URL doesn't silently drift when
  // BACKEND_URL changes for unrelated reasons (Stripe redirects, etc).
  const googleCallbackURL = process.env.GOOGLE_CALLBACK_URL
    || `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/auth/google/callback`;

  googleAuthStatus.configured = true;
  googleAuthStatus.callbackURL = googleCallbackURL;

  console.log(`🔗 Google OAuth callback URL in effect: ${googleCallbackURL}`);

  // Vercel/most serverless hosts leave NODE_ENV unset rather than 'production',
  // so treat unset the same as production for this warning — a dev-looking
  // callback URL in a real deployment is always wrong and Google will reject
  // it as redirect_uri_mismatch.
  const nodeEnv = process.env.NODE_ENV;
  const looksLikeProduction = nodeEnv === 'production' || !nodeEnv;
  const looksLikeDevUrl = googleCallbackURL.startsWith('http://') || googleCallbackURL.includes('localhost');
  if (looksLikeProduction && looksLikeDevUrl) {
    console.warn(
      `⚠️⚠️⚠️  GOOGLE OAUTH MISCONFIGURED: callback URL "${googleCallbackURL}" looks like a local/dev URL ` +
      `but NODE_ENV=${nodeEnv || '(unset)'}. Set GOOGLE_CALLBACK_URL to the deployed HTTPS URL ` +
      `(https://metro-matrix-backend.vercel.app/api/auth/google/callback) or Google will reject real logins ` +
      `with redirect_uri_mismatch.`
    );
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: googleCallbackURL,
        passReqToCallback: true,
        proxy: true, // Important behind Vercel's proxy layer too — keeps req.protocol accurate
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          // Get type from query params or state
          const type = req.query.state || req.query.type || 'user';
          const email = profile.emails?.[0]?.value;
          
          if (!email) {
            return done(new Error('Email not provided by Google'), null);
          }
          
          const profilePhoto = profile.photos?.[0]?.value;
          
          if (type === 'provider') {
            let provider = await Provider.findOne({
              $or: [{ googleId: profile.id }, { email }],
            });
            
            if (!provider) {
              provider = await Provider.create({
                googleId: profile.id,
                email,
                fullName: profile.displayName,
                phoneNumber: '',
                profilePhoto,
                isVerified: true,
                providerType: 'pending',
                lastLoginDate: new Date(),
              });
            } else {
              if (!provider.googleId) {
                provider.googleId = profile.id;
              }
              provider.lastLoginDate = new Date();
              await provider.save();
            }
            
            return done(null, provider, { type: 'provider' });
          } else {
            let user = await User.findOne({
              $or: [{ googleId: profile.id }, { email }],
            });
            
            if (!user) {
              user = await User.create({
                googleId: profile.id,
                email,
                fullName: profile.displayName,
                phoneNumber: '',
                profilePhoto,
                isVerified: true,
                lastLoginDate: new Date(),
              });
            } else {
              if (!user.googleId) {
                user.googleId = profile.id;
              }
              user.lastLoginDate = new Date();
              await user.save();
            }
            
            return done(null, user, { type: 'user' });
          }
        } catch (error) {
          console.error('Google OAuth error:', error);
          return done(error, null);
        }
      }
    )
  );
} else {
  console.warn('⚠️  Google OAuth not configured - missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET'.yellow);
}

// Facebook Strategy
if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
  // Prefer the explicit callback URL (set this in Vercel) over deriving it
  // from BACKEND_URL. This matters even more than for Google: the Facebook
  // app has Strict Mode ON for redirect URIs, so this must match the
  // console's Valid OAuth Redirect URIs character-for-character or Facebook
  // rejects the whole flow before it reaches this code.
  const facebookCallbackURL = process.env.FACEBOOK_CALLBACK_URL
    || `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/auth/facebook/callback`;

  facebookAuthStatus.configured = true;
  facebookAuthStatus.callbackURL = facebookCallbackURL;

  console.log(`🔗 Facebook OAuth callback URL in effect: ${facebookCallbackURL}`);

  const nodeEnv = process.env.NODE_ENV;
  const looksLikeProduction = nodeEnv === 'production' || !nodeEnv;
  const looksLikeDevUrl = facebookCallbackURL.startsWith('http://') || facebookCallbackURL.includes('localhost');
  if (looksLikeProduction && looksLikeDevUrl) {
    console.warn(
      `⚠️⚠️⚠️  FACEBOOK OAUTH MISCONFIGURED: callback URL "${facebookCallbackURL}" looks like a local/dev URL ` +
      `but NODE_ENV=${nodeEnv || '(unset)'}. With Strict Mode ON, Facebook will reject this outright — ` +
      `set FACEBOOK_CALLBACK_URL to the deployed HTTPS URL ` +
      `(https://metro-matrix-backend.vercel.app/api/auth/facebook/callback).`
    );
  }

  passport.use(
    new FacebookStrategy(
      {
        clientID: process.env.FACEBOOK_APP_ID,
        clientSecret: process.env.FACEBOOK_APP_SECRET,
        callbackURL: facebookCallbackURL,
        profileFields: ['id', 'emails', 'name', 'picture.type(large)'],
        passReqToCallback: true,
        proxy: true, // Important behind Vercel's proxy layer too
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          // Get type from query params or state
          const type = req.query.state || req.query.type || 'user';
          const email = profile.emails?.[0]?.value;
          
          if (!email) {
            return done(new Error('Email not provided by Facebook'), null);
          }
          
          const profilePhoto = profile.photos?.[0]?.value;
          const fullName = `${profile.name?.givenName || ''} ${profile.name?.familyName || ''}`.trim() || profile.displayName;
          
          if (type === 'provider') {
            let provider = await Provider.findOne({
              $or: [{ facebookId: profile.id }, { email }],
            });
            
            if (!provider) {
              provider = await Provider.create({
                facebookId: profile.id,
                email,
                fullName,
                phoneNumber: '',
                profilePhoto,
                isVerified: true,
                providerType: 'pending',
                lastLoginDate: new Date(),
              });
            } else {
              if (!provider.facebookId) {
                provider.facebookId = profile.id;
              }
              provider.lastLoginDate = new Date();
              await provider.save();
            }
            
            return done(null, provider, { type: 'provider' });
          } else {
            let user = await User.findOne({
              $or: [{ facebookId: profile.id }, { email }],
            });
            
            if (!user) {
              user = await User.create({
                facebookId: profile.id,
                email,
                fullName,
                phoneNumber: '',
                profilePhoto,
                isVerified: true,
                lastLoginDate: new Date(),
              });
            } else {
              if (!user.facebookId) {
                user.facebookId = profile.id;
              }
              user.lastLoginDate = new Date();
              await user.save();
            }
            
            return done(null, user, { type: 'user' });
          }
        } catch (error) {
          console.error('Facebook OAuth error:', error);
          return done(error, null);
        }
      }
    )
  );
} else {
  console.warn('⚠️  Facebook OAuth not configured - missing FACEBOOK_APP_ID or FACEBOOK_APP_SECRET'.yellow);
}

// Serialize/Deserialize — kept only because passport.authenticate() checks
// for these functions on a strategy that supports sessions; passport.session()
// is never registered (see app.js — only passport.initialize()) and every
// authenticate() call below passes { session: false }, so these never
// actually run. Safe for Vercel's stateless serverless functions: no process
// memory or session store is required between requests.
passport.serializeUser((user, done) => {
  done(null, { id: user.id, type: user.constructor.modelName });
});

passport.deserializeUser(async (data, done) => {
  try {
    let user;
    if (data.type === 'Provider') {
      user = await Provider.findById(data.id);
    } else {
      user = await User.findById(data.id);
    }
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

module.exports = passport;