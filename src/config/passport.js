const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const JwtStrategy = require('passport-jwt').Strategy;
const ExtractJwt = require('passport-jwt').ExtractJwt;
const User = require('../models/User');
const Provider = require('../models/Provider');

// JWT Strategy
const jwtOptions = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: process.env.JWT_SECRET,
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
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/auth/google/callback`,
        passReqToCallback: true,
        proxy: true, // Important for Heroku deployment
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
  passport.use(
    new FacebookStrategy(
      {
        clientID: process.env.FACEBOOK_APP_ID,
        clientSecret: process.env.FACEBOOK_APP_SECRET,
        callbackURL: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/auth/facebook/callback`,
        profileFields: ['id', 'emails', 'name', 'picture.type(large)'],
        passReqToCallback: true,
        proxy: true, // Important for Heroku deployment
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

// Serialize/Deserialize (required by Passport even though we use JWT)
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