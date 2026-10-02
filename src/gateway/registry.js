/**
 * The route table: every module's entry point, in mount order, in one place.
 *
 * MetroMatrix is a modular monolith behind an in-process gateway (this
 * folder): one deployable, one request pipeline — request id → access log →
 * CORS/helmet/sanitise → rate limit → JWT (per router) — then dispatch to a
 * module router from the table below. It is not a separate gateway product;
 * on serverless that would add a network hop to every request for nothing.
 *
 * ORDER MATTERS and is copied exactly from what app.js used to do:
 *   - the healthcare doctor self-service router claims /doctors/me before the
 *     shared healthcare router sees it;
 *   - adminDoctorRoutes precedes adminHealthcareRoutes so its static
 *     /doctors/pending wins over /doctors/:doctorId;
 *   - the Home Services router is mounted at /api BEFORE the legacy
 *     /api/providers and /api/admin routers — its GET /providers[/:id]
 *     handlers fall through (next()) for non-home-service requests.
 * New modules go at the END unless they must shadow something.
 */

const ROUTES = [
  { prefix: '/api/auth', module: 'auth', load: () => require('../routes/authRoutes') },

  // Healthcare: provider-based doctor self-service routes first (claim
  // /doctors/me, /doctors/register, /doctors/signin), then the module router.
  { prefix: '/api/v1/healthcare', module: 'healthcare', load: () => require('../routes/healthcareDoctorRoutes') },
  { prefix: '/api/v1/healthcare', module: 'healthcare', load: () => require('../modules/healthcare/routes/index') },

  // Production triggers for scheduled work. Vercel is serverless — no
  // long-lived process — so node-cron jobs never fire there; Vercel Cron (and
  // the realtime dyno's scheduler) call these instead. GET as well as POST:
  // Vercel Cron issues a GET.
  {
    path: '/api/internal/slots/refresh-horizon',
    methods: ['get', 'post'],
    module: 'healthcare',
    load: () => [require('../modules/healthcare/controllers/slotHorizonController').refreshHorizon],
  },
  {
    path: '/api/internal/homeservice/expire',
    methods: ['get', 'post'],
    module: 'homeservice',
    load: () => [require('../modules/homeservice/controllers/maintenanceController').runExpiry],
  },

  // Every time-driven job (reminders, expiry), called every ~5 min by the
  // realtime dyno and every 15 by a GitHub Actions watchdog.
  {
    path: '/api/internal/scheduler/tick',
    methods: ['get', 'post'],
    module: 'core',
    load: () => [require('./internalAuth').requireInternalKey, require('../controllers/schedulerController').tick],
  },

  // Realtime → API: a provider's live position is ~5 minutes from the customer.
  {
    path: '/api/internal/homeservice/bookings/:bookingId/nearby',
    methods: ['post'],
    module: 'homeservice',
    load: () => [
      require('./internalAuth').requireInternalKey,
      require('../modules/homeservice/controllers/internalController').providerNearby,
    ],
  },

  // Shopping module (multi-vendor storefront).
  { prefix: '/api/shopping', module: 'shopping', load: () => require('../modules/shopping/routes/index') },

  // Healthcare admin (doctor approval, specialty CRUD, analytics, oversight).
  { prefix: '/api/v1/admin', module: 'healthcare-admin', load: () => require('../routes/adminDoctorRoutes') },
  { prefix: '/api/v1/admin', module: 'healthcare-admin', load: () => require('../routes/adminSpecialtyRoutes') },
  { prefix: '/api/v1/admin', module: 'healthcare-admin', load: () => require('../routes/adminAnalyticsRoutes') },
  { prefix: '/api/v1/admin', module: 'healthcare-admin', load: () => require('../routes/adminHealthcareRoutes') },

  // Home Services module (FR-01..FR-20).
  { prefix: '/api', module: 'homeservice', load: () => require('../modules/homeservice/routes/index') },
  { prefix: '/api/admin', module: 'homeservice', load: () => require('../modules/homeservice/routes/adminRoutes') },

  // Admin wallet oversight — one ledger, cross-module admin view.
  { prefix: '/api/admin/wallets', module: 'wallet', load: () => require('../routes/adminWalletRoutes') },

  // Legacy / shared routers.
  { prefix: '/api/users', module: 'core', load: () => require('../routes/userRoutes') },
  { prefix: '/api/providers', module: 'core', load: () => require('../routes/providerRoutes') },
  { prefix: '/api/posts', module: 'core', load: () => require('../routes/postRoutes') },
  { prefix: '/api/admin', module: 'core', load: () => require('../routes/adminRoutes') },
  { prefix: '/api/wallet', module: 'wallet', load: () => require('../routes/walletRoutes') },

  // Provider profile endpoints.
  {
    path: '/api/provider/profile',
    methods: ['put'],
    module: 'core',
    load: () => [
      require('../middleware/authMiddleware').protect,
      require('../middleware/uploadMiddleware').uploadMultipleDocuments,
      require('../controllers/providerController').updateProviderProfileComplete,
    ],
  },
  {
    path: '/api/provider/approval-status',
    methods: ['get'],
    module: 'core',
    load: () => [require('../controllers/providerController').checkApprovalStatus],
  },

  // Signed direct uploads to Cloudinary (avatars, dispute photos, health
  // records, product images and 3D models) — sidesteps Vercel's 4.5 MB body cap.
  {
    path: '/api/uploads/sign',
    methods: ['post'],
    module: 'core',
    load: () => [
      require('../middleware/authMiddleware').protect,
      require('./rateLimit').limiter('uploadSign'),
      require('../controllers/uploadSignController').signUpload,
    ],
  },

  // Cross-cutting services added for the FYP feature set.
  { prefix: '/api', module: 'ml', load: () => require('../modules/ml/routes/index') },
  { prefix: '/api', module: 'analytics', load: () => require('../modules/analytics/routes/index') },
];

function mountRoutes(app, routes = ROUTES) {
  for (const entry of routes) {
    if (entry.prefix) {
      app.use(entry.prefix, entry.load());
    } else {
      const handlers = entry.load();
      for (const method of entry.methods) app[method](entry.path, ...handlers);
    }
  }
}

/** The table as data — for docs and the registry test. */
function describeRoutes(routes = ROUTES) {
  return routes.map((e) => ({
    mount: e.prefix || `${e.methods.map((m) => m.toUpperCase()).join('|')} ${e.path}`,
    module: e.module,
  }));
}

module.exports = { ROUTES, mountRoutes, describeRoutes };
