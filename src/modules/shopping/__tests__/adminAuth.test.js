/**
 * Admin authorisation for shopping routes: non-admins always 403;
 * admins need canManageShopping (super admins bypass).
 */
const { requireShoppingAdmin } = require('../middleware/adminAuth');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('requireShoppingAdmin', () => {
  it('rejects non-admins (customer)', () => {
    const res = mockRes();
    requireShoppingAdmin({ isAdmin: false, user: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects providers/vendors', () => {
    const res = mockRes();
    requireShoppingAdmin(
      { isAdmin: false, isProvider: true, user: { providerType: 'vendor' } },
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects an admin without the shopping permission', () => {
    const res = mockRes();
    requireShoppingAdmin(
      { isAdmin: true, user: { isSuperAdmin: false, permissions: { canManageShopping: false } } },
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('passes an admin with canManageShopping', () => {
    const next = jest.fn();
    requireShoppingAdmin(
      { isAdmin: true, user: { isSuperAdmin: false, permissions: { canManageShopping: true } } },
      mockRes(),
      next
    );
    expect(next).toHaveBeenCalled();
  });

  it('super admin bypasses the permission flag', () => {
    const next = jest.fn();
    requireShoppingAdmin(
      { isAdmin: true, user: { isSuperAdmin: true, permissions: {} } },
      mockRes(),
      next
    );
    expect(next).toHaveBeenCalled();
  });
});
