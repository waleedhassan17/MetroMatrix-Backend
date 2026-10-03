/**
 * Admin authorisation for shopping routes: non-admins always 403;
 * admins need canManageShopping (super admins bypass).
 */
const Admin = require('../../../models/Admin');
const { requireShoppingAdmin } = require('../middleware/adminAuth');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

// Express turns a thrown error into the error response; capture it here.
const run = (req) => {
  const res = mockRes();
  const next = jest.fn();
  try {
    requireShoppingAdmin(req, res, next);
    return { res, next, error: null };
  } catch (error) {
    return { res, next, error };
  }
};

const admin = (fields) => new Admin({ email: 'a@example.com', fullName: 'A', ...fields });

describe('requireShoppingAdmin', () => {
  it('rejects non-admins (customer)', () => {
    const { res, next, error } = run({ isAdmin: false, user: {} });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(error).toBeTruthy();
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects providers/vendors', () => {
    const { res, next } = run({ isAdmin: false, isProvider: true, user: { providerType: 'vendor' } });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an admin without the shopping permission', () => {
    const { next, error } = run({ isAdmin: true, user: admin({ role: 'admin', permissions: { canManageShopping: false } }) });
    expect(next).not.toHaveBeenCalled();
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
  });

  it('passes an admin with canManageShopping', () => {
    const { next } = run({ isAdmin: true, user: admin({ role: 'admin', permissions: { canManageShopping: true } }) });
    expect(next).toHaveBeenCalled();
  });

  it('super admin bypasses the permission flag', () => {
    const { next } = run({ isAdmin: true, user: admin({ role: 'super_admin', isSuperAdmin: true, permissions: { canManageShopping: false } }) });
    expect(next).toHaveBeenCalled();
  });

  it('is a named guard the route table can see', () => {
    expect(requireShoppingAdmin.name).toBe('requirePermission(canManageShopping)');
  });
});
