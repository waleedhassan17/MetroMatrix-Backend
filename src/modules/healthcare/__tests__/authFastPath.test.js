/**
 * protect/optionalAuth resolve the account from the collection the token names.
 * Mocked models — no DB.
 */
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Provider', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Admin', () => ({ findById: jest.fn() }));

const User = require('../../../models/User');
const Provider = require('../../../models/Provider');
const Admin = require('../../../models/Admin');
const { loadAccount } = require('../../../middleware/authMiddleware');

const resolves = (value) => ({ select: jest.fn().mockResolvedValue(value) });

beforeEach(() => {
  jest.clearAllMocks();
  User.findById.mockReturnValue(resolves(null));
  Provider.findById.mockReturnValue(resolves(null));
  Admin.findById.mockReturnValue(resolves(null));
});

describe('loadAccount', () => {
  it('a provider token looks in Provider first and never queries User', async () => {
    Provider.findById.mockReturnValue(resolves({ _id: 'p1', isActive: true }));
    const r = await loadAccount({ id: 'p1', userType: 'provider' });
    expect(r.kind).toBe('provider');
    expect(User.findById).not.toHaveBeenCalled();
    expect(Admin.findById).not.toHaveBeenCalled();
  });

  it('an admin token looks in Admin first', async () => {
    Admin.findById.mockReturnValue(resolves({ _id: 'a1', isActive: true }));
    const r = await loadAccount({ id: 'a1', userType: 'admin' });
    expect(r.kind).toBe('admin');
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('a token without userType keeps the legacy User → Provider → Admin order', async () => {
    Admin.findById.mockReturnValue(resolves({ _id: 'a1', isActive: true }));
    const r = await loadAccount({ id: 'a1' });
    expect(r.kind).toBe('admin');
    const [u] = User.findById.mock.invocationCallOrder;
    const [p] = Provider.findById.mock.invocationCallOrder;
    const [a] = Admin.findById.mock.invocationCallOrder;
    expect(u).toBeLessThan(p);
    expect(p).toBeLessThan(a);
  });

  it('a provider token whose account is really a User still resolves', async () => {
    User.findById.mockReturnValue(resolves({ _id: 'u1', isActive: true }));
    const r = await loadAccount({ id: 'u1', userType: 'provider' });
    expect(r.kind).toBe('user');
  });

  it('returns nulls when no collection has the account', async () => {
    const r = await loadAccount({ id: 'ghost', userType: 'provider' });
    expect(r).toEqual({ account: null, kind: null });
  });
});
