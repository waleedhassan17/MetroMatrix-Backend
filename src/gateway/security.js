/**
 * CORS, security headers, NoSQL-injection sanitising and compression —
 * moved verbatim from app.js so the gateway is the one place that owns them.
 */
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:19006', // Expo
      'http://localhost:8081', // React Native / Expo Web
      'http://localhost:8082', // Expo Web fallback port
      'http://localhost:8083', // Expo Web fallback port
      process.env.CLIENT_URL,
    ];

    // Allow requests with no origin (mobile apps / curl).
    if (!origin) return callback(null, true);
    // In development, allow any localhost / LAN origin (Expo web on any port, etc.).
    if (process.env.NODE_ENV !== 'production') return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  optionsSuccessStatus: 200,
};

function applySecurity(app) {
  app.use(cors(corsOptions));

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

module.exports = { applySecurity, corsOptions };
