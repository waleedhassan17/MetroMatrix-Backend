/**
 * Vendor authorisation: cross-brand access must be denied (403) and only
 * approved vendor Providers may pass. Brand model is mocked — no DB.
 */
jest.mock('../models/Brand', () => ({ findOne: jest.fn() }));
const Brand = require('../models/Brand');
const { requireVendor, requireBrandOwner } = require('../middleware/vendorAuth');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('requireVendor', () => {
  const base = {
    isProvider: true,
    user: { providerType: 'vendor', adminVerified: 'active' },
  };

  it('passes an approved vendor provider', () => {
    const next = jest.fn();
    requireVendor({ ...base }, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects non-providers (customers, admins)', () => {
    const res = mockRes();
    requireVendor({ ...base, isProvider: false }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects providers of other types (doctor, home_service)', () => {
    const res = mockRes();
    requireVendor(
      { ...base, user: { providerType: 'doctor', adminVerified: 'active' } },
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects vendors not yet admin-approved', () => {
    const res = mockRes();
    requireVendor(
      { ...base, user: { providerType: 'vendor', adminVerified: 'pending' } },
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('requireBrandOwner — cross-brand access', () => {
  const vendorReq = (params = {}) => ({
    user: { _id: 'vendor-1' },
    params,
  });

  it('404s a vendor with no brand profile', async () => {
    Brand.findOne.mockResolvedValue(null);
    const res = mockRes();
    await requireBrandOwner(vendorReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('attaches the owned brand and passes', async () => {
    const myBrand = { _id: 'brand-A' };
    Brand.findOne.mockResolvedValue(myBrand);
    const req = vendorReq();
    const next = jest.fn();
    await requireBrandOwner(req, mockRes(), next);
    expect(req.brand).toBe(myBrand);
    expect(next).toHaveBeenCalled();
  });

  it("returns 403 when :brandId is another vendor's brand", async () => {
    Brand.findOne.mockResolvedValue({ _id: 'brand-A' });
    const res = mockRes();
    const next = jest.fn();
    await requireBrandOwner(vendorReq({ brandId: 'brand-B' }), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows :brandId equal to the owned brand', async () => {
    Brand.findOne.mockResolvedValue({ _id: 'brand-A' });
    const next = jest.fn();
    await requireBrandOwner(vendorReq({ brandId: 'brand-A' }), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });
});
