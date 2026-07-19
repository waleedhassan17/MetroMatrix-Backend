const asyncHandler = require('express-async-handler');
const Brand = require('../models/Brand');

/**
 * requireVendor — authenticated Provider with providerType 'vendor' whose
 * account has passed the existing two-step verification pipeline
 * (email verification + admin approval). Runs after `protect`.
 */
const requireVendor = (req, res, next) => {
  if (!req.isProvider) {
    return res.status(403).json({ success: false, error: 'This route is for vendors only' });
  }
  if (req.user.providerType !== 'vendor') {
    return res.status(403).json({ success: false, error: 'This route is for vendors only' });
  }
  if (req.user.adminVerified !== 'active') {
    return res
      .status(403)
      .json({ success: false, error: 'Your vendor account is not approved yet' });
  }
  return next();
};

/**
 * requireBrandOwner — loads the vendor's own brand onto req.brand and
 * guarantees every downstream query is scoped to it. If the route carries
 * a :brandId param it must match the owned brand (cross-brand access → 403).
 * Reusable middleware by design: vendors can never read or write another
 * brand's products, orders, inventory or analytics.
 */
const requireBrandOwner = asyncHandler(async (req, res, next) => {
  const brand = await Brand.findOne({ owner: req.user._id, isDeleted: false });
  if (!brand) {
    return res.status(404).json({
      success: false,
      error: 'You have no brand profile yet. Create one first.',
      code: 'NO_BRAND',
    });
  }
  if (req.params.brandId && String(req.params.brandId) !== String(brand._id)) {
    return res
      .status(403)
      .json({ success: false, error: 'You do not have access to this brand' });
  }
  req.brand = brand;
  return next();
});

module.exports = { requireVendor, requireBrandOwner };
