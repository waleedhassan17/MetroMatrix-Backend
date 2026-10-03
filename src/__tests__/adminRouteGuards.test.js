/**
 * Every admin route is guarded, checked from the real route table (the same
 * one scripts/dump-routes.js writes to docs/ROUTES.json):
 *  - it requires a signed-in admin (protect) unless it is on the explicit
 *    public list below;
 *  - every mutation names its permission: requirePermission(…),
 *    requireSuperAdmin, or selfScoped for the caller's own account;
 *  - reads of sensitive data (money, personal data, health data, audit,
 *    admins) name a permission too.
 * A new admin route without a guard fails this test.
 */
const { app } = require('../../test/helpers/agent');
const { routeTable } = require('../utils/routeTable');

const ADMIN_PREFIX = /^\/api\/(admin|v1\/admin|shopping\/admin)(\/|$)/;

const PUBLIC_ROUTES = new Set([
  'POST /api/admin/auth/login',
  'POST /api/admin/login',
  'POST /api/admin/auth/login/totp',
  'POST /api/admin/auth/refresh-token',
  // Provider-app onboarding endpoints that live under /api/admin for history.
  'POST /api/admin/provider-submissions',
  'GET /api/admin/provider-submissions/check-status',
]);

const SENSITIVE_READS = [
  /^\/api\/admin\/wallets/,
  /^\/api\/admin\/users/,
  /^\/api\/admin\/admins/,
  /^\/api\/admin\/providers/,
  /^\/api\/admin\/payout-requests/,
  /^\/api\/admin\/bookings/,
  /^\/api\/admin\/disputes/,
  /^\/api\/admin\/analytics/,
  /^\/api\/admin\/audit/,
  /^\/api\/admin\/sessions/,
  /^\/api\/v1\/admin\/(appointments|clinics|doctors|healthcare\/reviews|analytics)/,
  /^\/api\/shopping\/admin\/orders/,
];

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const isGuard = (name) => /^requirePermission\(/.test(name) || name === 'requireSuperAdmin' || name === 'selfScoped';
const key = (r) => `${r.method} ${r.path}`;

const adminRoutes = routeTable(app).filter((r) => ADMIN_PREFIX.test(r.path));

describe('admin route guards', () => {
  it('finds the admin surface', () => {
    expect(adminRoutes.length).toBeGreaterThan(100);
  });

  it('every admin route requires a signed-in admin unless it is explicitly public', () => {
    const open = adminRoutes.filter((r) => !r.middleware.includes('protect')).map(key);
    expect(open.sort()).toEqual([...PUBLIC_ROUTES].sort());
  });

  it('every admin mutation names the permission that guards it', () => {
    const unguarded = adminRoutes
      .filter((r) => MUTATING.has(r.method) && !PUBLIC_ROUTES.has(key(r)))
      .filter((r) => !r.middleware.some(isGuard))
      .map(key);
    expect(unguarded).toEqual([]);
  });

  it('reads of money, personal, health and audit data name a permission', () => {
    const unguarded = adminRoutes
      .filter((r) => r.method === 'GET' && SENSITIVE_READS.some((re) => re.test(r.path)))
      .filter((r) => !r.middleware.some(isGuard))
      .map(key);
    expect(unguarded).toEqual([]);
  });

  it('money-moving routes require canManageFinance', () => {
    const moneyRoutes = [
      'POST /api/admin/bookings/:id/refund',
      'PATCH /api/admin/payout-requests/:id',
      'POST /api/admin/wallets/:id/adjust',
      'POST /api/v1/admin/appointments/:id/refund',
      'POST /api/shopping/admin/orders/:orderId/refund',
    ];
    for (const route of moneyRoutes) {
      const row = adminRoutes.find((r) => key(r) === route);
      expect(row).toBeDefined();
      expect(row.middleware.join(' ')).toMatch(/canManageFinance/);
    }
  });
});
