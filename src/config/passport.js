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
      // Try to find user
      let user = await User.findById(payload.id);
      
      if (!user) {
        // Try to find provider if not a user
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
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
      passReqToCallback: true,
    },
    async (req, accessToken, refreshToken, profile, done) => {
      try {
        const { type } = req.query; // 'user' or 'provider'
        const email = profile.emails[0].value;
        const profilePhoto = profile.photos[0]?.value;
        
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
              providerType: 'pending', // Will be set during onboarding
            });
          } else {
            // Update last login
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
            });
          } else {
            // Update last login
            user.lastLoginDate = new Date();
            await user.save();
          }
          
          return done(null, user, { type: 'user' });
        }
      } catch (error) {
        return done(error, null);
      }
    }
  )
);

// Facebook Strategy
passport.use(
  new FacebookStrategy(
    {
      clientID: process.env.FACEBOOK_APP_ID,
      clientSecret: process.env.FACEBOOK_APP_SECRET,
      callbackURL: process.env.FACEBOOK_CALLBACK_URL,
      profileFields: ['id', 'emails', 'name', 'picture'],
      passReqToCallback: true,
    },
    async (req, accessToken, refreshToken, profile, done) => {
      try {
        const { type } = req.query;
        const email = profile.emails?.[0]?.value;
        const profilePhoto = profile.photos?.[0]?.value;
        
        if (!email) {
          return done(new Error('Email not provided by Facebook'), null);
        }
        
        if (type === 'provider') {
          let provider = await Provider.findOne({
            $or: [{ facebookId: profile.id }, { email }],
          });
          
          if (!provider) {
            provider = await Provider.create({
              facebookId: profile.id,
              email,
              fullName: `${profile.name.givenName} ${profile.name.familyName}`,
              phoneNumber: '',
              profilePhoto,
              isVerified: true,
              providerType: 'pending',
            });
          } else {
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
              fullName: `${profile.name.givenName} ${profile.name.familyName}`,
              phoneNumber: '',
              profilePhoto,
              isVerified: true,
            });
          } else {
            user.lastLoginDate = new Date();
            await user.save();
          }
          
          return done(null, user, { type: 'user' });
        }
      } catch (error) {
        return done(error, null);
      }
    }
  )
);

// Serialize/Deserialize user (not used with JWT, but required by Passport)
passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    let user = await User.findById(id);
    if (!user) {
      user = await Provider.findById(id);
    }
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

module.exports = passport;