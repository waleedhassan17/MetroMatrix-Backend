const asyncHandler = require('express-async-handler');
const Coupon = require('../models/Coupon');
const cartService = require('../services/cartService');
const { ok, fail } = require('../utils/respond');

// @desc  GET /api/shopping/cart
const getCart = asyncHandler(async (req, res) => {
  const cart = await cartService.getOrCreateCart(req.user._id);
  return ok(res, await cartService.serializeCart(cart));
});

// @desc  POST /api/shopping/cart/items { productId, variantId, quantity }
const addItem = asyncHandler(async (req, res) => {
  const { productId, variantId } = req.body;
  const quantity = parseInt(req.body.quantity, 10) || 1;
  if (!productId || !variantId) {
    return fail(res, 400, 'productId and variantId are required');
  }
  if (quantity < 1) return fail(res, 400, 'Quantity must be at least 1');

  const cart = await cartService.getOrCreateCart(req.user._id);
  const existing = cart.items.find(
    (it) => String(it.product) === String(productId) && String(it.variantId) === String(variantId)
  );
  const requestedTotal = quantity + (existing ? existing.quantity : 0);

  const check = await cartService.validateLine(productId, variantId, requestedTotal);
  if (!check.ok) return fail(res, check.status, check.reason);

  if (existing) {
    // Same (product, variant) increments the line rather than duplicating it
    existing.quantity = requestedTotal;
  } else {
    cart.items.push({
      product: check.product._id,
      brandId: check.product.brandId,
      variantId,
      quantity,
      unitPrice: cartService.unitPriceFor(check.product, check.variant),
    });
  }
  await cart.save();
  return ok(res, await cartService.serializeCart(cart));
});

// @desc  PATCH /api/shopping/cart/items/:itemId { quantity }
const updateItem = asyncHandler(async (req, res) => {
  const quantity = parseInt(req.body.quantity, 10);
  if (!quantity || quantity < 1) return fail(res, 400, 'Quantity must be at least 1');

  const cart = await cartService.getOrCreateCart(req.user._id);
  const item = cart.items.id(req.params.itemId);
  if (!item) return fail(res, 404, 'Cart item not found');

  const check = await cartService.validateLine(item.product, item.variantId, quantity);
  if (!check.ok) return fail(res, check.status, check.reason);

  item.quantity = quantity;
  await cart.save();
  return ok(res, await cartService.serializeCart(cart));
});

// @desc  DELETE /api/shopping/cart/items/:itemId
const removeItem = asyncHandler(async (req, res) => {
  const cart = await cartService.getOrCreateCart(req.user._id);
  const item = cart.items.id(req.params.itemId);
  if (!item) return fail(res, 404, 'Cart item not found');
  item.deleteOne();
  if (cart.items.length === 0) cart.appliedCoupon = null;
  await cart.save();
  return ok(res, await cartService.serializeCart(cart));
});

// @desc  DELETE /api/shopping/cart
const clearCart = asyncHandler(async (req, res) => {
  const cart = await cartService.getOrCreateCart(req.user._id);
  cart.items = [];
  cart.appliedCoupon = null;
  await cart.save();
  return res.json({ success: true });
});

// @desc  POST /api/shopping/cart/coupon { couponCode }
const applyCoupon = asyncHandler(async (req, res) => {
  const { couponCode } = req.body;
  if (!couponCode) return fail(res, 400, 'couponCode is required');

  const cart = await cartService.getOrCreateCart(req.user._id);
  if (cart.items.length === 0) return fail(res, 400, 'Your cart is empty');

  const coupon = await Coupon.findOne({ couponCode: String(couponCode).toUpperCase() });
  const items = cart.items.map((it) => ({
    brandId: it.brandId,
    unitPrice: it.unitPrice,
    quantity: it.quantity,
  }));
  const result = cartService.evaluateCoupon(coupon, items);
  if (!result.ok) return fail(res, 400, result.reason);

  cart.appliedCoupon = String(couponCode).toUpperCase();
  await cart.save();
  return ok(res, await cartService.serializeCart(cart));
});

// @desc  DELETE /api/shopping/cart/coupon
const removeCoupon = asyncHandler(async (req, res) => {
  const cart = await cartService.getOrCreateCart(req.user._id);
  cart.appliedCoupon = null;
  await cart.save();
  return ok(res, await cartService.serializeCart(cart));
});

// @desc  GET /api/shopping/coupons?brandId — coupons a customer can currently use
const listCoupons = asyncHandler(async (req, res) => {
  const now = new Date();
  const filter = {
    isActive: true,
    validFrom: { $lte: now },
    validUntil: { $gte: now },
  };
  if (req.query.brandId) {
    filter.$or = [{ brandId: null }, { brandId: req.query.brandId }];
  }
  const coupons = await Coupon.find(filter).sort({ validUntil: 1 });
  const usable = coupons.filter((c) => !(c.usageLimit > 0 && c.usedCount >= c.usageLimit));
  return ok(res, usable);
});

module.exports = {
  getCart,
  addItem,
  updateItem,
  removeItem,
  clearCart,
  applyCoupon,
  removeCoupon,
  listCoupons,
};
