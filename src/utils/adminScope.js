// Which requests belong to the admin console. Admin endpoints answer with the
// standard envelope (utils/apiResponse.js); every other client keeps the
// legacy shapes it already parses.
const ADMIN_PREFIXES = ['/api/admin', '/api/v1/admin', '/api/shopping/admin'];

// Lives under /api/admin for historical reasons but is called by the provider
// app during onboarding, not by the admin console.
const NOT_ADMIN = ['/api/admin/provider-submissions'];

const pathOf = (req) => (req.originalUrl || req.url || '').split('?')[0];

const startsWithSegment = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

const isAdminRequest = (req) => {
  const path = pathOf(req);
  if (NOT_ADMIN.some((p) => startsWithSegment(path, p))) return false;
  return ADMIN_PREFIXES.some((p) => startsWithSegment(path, p));
};

module.exports = { ADMIN_PREFIXES, isAdminRequest, pathOf, startsWithSegment };
