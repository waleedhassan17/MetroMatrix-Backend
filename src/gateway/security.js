/**
 * CORS, security headers, NoSQL-injection sanitising and compression —
 * moved verbatim from app.js so the gateway is the one place that owns them.
 *
 * Two mounting points, because the two halves need opposite positions:
 *  - applyCors goes BEFORE the body parsers, so a request they reject
 *    (malformed JSON, too large) still carries CORS headers. Without them a
 *    browser hides the 400/413 and the web app sees an opaque network error.
 *  - applySecurity goes AFTER them: express-mongo-sanitize cleans req.body,
 *    which does not exist until the body has been parsed.
 */
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');

// The web build on a developer's machine: `expo start --web` takes the first
// free port (8081 is often taken, e.g. by a local phpMyAdmin), and the browser
// may be pointed at 127.0.0.1 instead of localhost. Tokens travel in the
// Authorization header, never in cookies, so a local origin gains nothing a
// native client doesn't already have.
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

// Comma-separated origins from the environment, e.g. a hosted web build or a
// LAN address used to open the web app from another device.
const originsFrom = (value) =>
  (value || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

const isAllowedOrigin = (origin) =>
  LOCAL_ORIGIN.test(origin) ||
  [...originsFrom(process.env.CORS_ORIGINS), ...originsFrom(process.env.CLIENT_URL)].includes(origin);

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps / curl).
    if (!origin) return callback(null, true);
    // In development, allow any localhost / LAN origin (Expo web on any port, etc.).
    if (process.env.NODE_ENV !== 'production') return callback(null, true);
    // A refused origin gets an ordinary response without CORS headers, which
    // the browser then blocks. Passing an Error here used to turn every such
    // request, preflights included, into a logged 500.
    return callback(null, isAllowedOrigin(origin));
  },
  credentials: true,
  optionsSuccessStatus: 200,
  // Without this a browser repeats the preflight before almost every call, and
  // on serverless each OPTIONS is a whole extra invocation and round trip.
  maxAge: 600,
  // Native clients can read every header; a browser only the exposed ones.
  exposedHeaders: ['X-Request-Id', 'Retry-After'],
};

const corsMiddleware = cors(corsOptions);

function applyCors(app) {
  app.use(corsMiddleware);
}

function applySecurity(app) {
  // Security middleware
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false, // Disable for verification page
    })
  );

  // Data sanitization against NoSQL query injection
  app.use(mongoSanitize());

  // Compression middleware
  app.use(compression());
}

module.exports = { applyCors, applySecurity, corsOptions, corsMiddleware, isAllowedOrigin };
