const { ROUTES, describeRoutes } = require('../registry');

describe('gateway route registry', () => {
  const mounts = describeRoutes().map((r) => r.mount);

  it('keeps the load-bearing order', () => {
    const at = (m) => mounts.indexOf(m);
    // The doctor self-service router claims /doctors/me before the module router.
    expect(mounts.filter((m) => m === '/api/v1/healthcare')).toHaveLength(2);
    // Home Services at /api is mounted before the legacy routers it falls through to.
    expect(at('/api')).toBeLessThan(at('/api/providers'));
    expect(at('/api')).toBeLessThan(at('/api/users'));
    // The HS admin router precedes the legacy admin router.
    expect(mounts.indexOf('/api/admin')).toBeLessThan(mounts.lastIndexOf('/api/admin'));
    // Internal cron triggers exist for both schedulers.
    expect(mounts).toContain('GET|POST /api/internal/slots/refresh-horizon');
    expect(mounts).toContain('GET|POST /api/internal/homeservice/expire');
  });

  it('loads healthcare admin doctor routes before the oversight routes', () => {
    const v1Admin = ROUTES.filter((r) => r.prefix === '/api/v1/admin').map((r) => String(r.load));
    expect(v1Admin[0]).toMatch(/adminDoctorRoutes/);
    expect(v1Admin[v1Admin.length - 1]).toMatch(/adminHealthcareRoutes/);
  });

  it('tags every entry with a module', () => {
    for (const r of describeRoutes()) expect(r.module).toBeTruthy();
  });
});
