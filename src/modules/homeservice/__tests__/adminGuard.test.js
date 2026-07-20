/**
 * HS5 — admin guard behaviour and the duplicate-route cleanup.
 */
const { adminOnly } = require('../../../middleware/authMiddleware');

describe('adminOnly middleware', () => {
  function mockRes() {
    const res = { statusCode: 200 };
    res.status = jest.fn((c) => {
      res.statusCode = c;
      return res;
    });
    return res;
  }

  it('non-admin gets 403', () => {
    const res = mockRes();
    expect(() => adminOnly({ isAdmin: false }, res, jest.fn())).toThrow(/admins only/i);
    expect(res.statusCode).toBe(403);
  });

  it('admin passes through', () => {
    const next = jest.fn();
    adminOnly({ isAdmin: true }, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });
});

describe('HS5 Part A — legacy adminRoutes shadowed registrations are gone', () => {
  function routePaths(router) {
    return router.stack
      .filter((l) => l.route)
      .map((l) => ({
        path: l.route.path,
        methods: Object.keys(l.route.methods).sort().join(','),
      }));
  }

  it("'/providers/:id' (dead getProviderForReview / POST approveProvider) no longer registered", () => {
    const legacy = require('../../../routes/adminRoutes');
    const paths = routePaths(legacy);
    expect(paths.find((p) => p.path === '/providers/:id')).toBeUndefined();
    expect(paths.find((p) => p.path === '/providers/:id/approve')).toBeUndefined();
    // The canonical Enhanced handlers survive:
    expect(paths.find((p) => p.path === '/providers/:providerId' && p.methods.includes('get'))).toBeDefined();
    expect(paths.find((p) => p.path === '/providers/:providerId/approve' && p.methods.includes('put'))).toBeDefined();
  });

  it('no duplicate verb+path registrations remain in the legacy admin router', () => {
    const legacy = require('../../../routes/adminRoutes');
    const seen = new Map();
    routePaths(legacy).forEach(({ path, methods }) => {
      const key = `${methods} ${path}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    });
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    expect(dupes).toEqual([]);
  });

  it('homeservice admin router registers the oversight surface', () => {
    const hsAdmin = require('../routes/adminRoutes');
    const paths = routePaths(hsAdmin).map((p) => `${p.methods} ${p.path}`);
    [
      'get /bookings',
      'get /bookings/:id',
      'patch /bookings/:id/status',
      'post /bookings/:id/refund',
      'get /disputes',
      'patch /disputes/:id',
      'get /payout-requests',
      'patch /payout-requests/:id',
      'get /service-categories',
      'post /service-categories',
      'get /homeservice/dashboard',
      'get /homeservice/analytics',
      'get /homeservice/settings',
      'patch /homeservice/settings',
    ].forEach((expected) => expect(paths).toContain(expected));
  });
});
