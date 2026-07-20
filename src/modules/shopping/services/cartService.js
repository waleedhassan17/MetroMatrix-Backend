const Cart = require('../models/Cart');
const Coupon = require('../models/Coupon');
const Brand = require('../models/Brand');
const Product = require('../models/Product');
const { getShoppingSettings } = require('./settingsService');

/**
 * ── Pure logic (unit-tested without a DB) ──────────────────────────
 */

/**
 * FYP-scope shipping rule: flat fee per brand in the cart; a brand's fee
 * is waived when that brand's line subtotal reaches freeShippingThreshold.
 * Values come from shopping settings (AdminSettings.shopping).
 */
const computeShippingFee = (items, { shippingFeePerBrand, freeShippingThreshold }) => {
  const byBrand = new Map();
  items.forEach((it) => {
    const key = String(it.brandId);
    byBrand.set(key, (byBrand.get(key) || 0) + it.unitPrice * it.quantity);
  });
  let fee = 0;
  byBrand.forEach((brandSubtotal) => {
    if (brandSubtotal < freeShippingThreshold) fee += shippingFeePerBrand;
  });
  return fee;
};

/**
 * Validate a coupon against the cart. Returns { ok: true, discount } or
 * { ok: false, reason } with a user-facing message for every rejection.
 */
const evaluateCoupon = (coupon, items, now = new Date()) => {
  if (!coupon || coupon.isActive === false) {
    return { ok: false, reason: 'Invalid coupon code' };
  }
  if (now < new Date(coupon.validFrom)) {
    return { ok: false, reason: 'This coupon is not active yet' };
  }
  if (now > new Date(coupon.validUntil)) {
    return { ok: false, reason: 'This coupon has expired' };
  }
  if (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit) {
    return { ok: false, reason: 'This coupon has reached its usage limit' };
  }

  const subtotal = items.reduce((s, it) => s + it.unitPrice * it.quantity, 0);
  if (subtotal < coupon.minOrderAmount) {
    return {
      ok: false,
      reason: `Minimum order of PKR ${coupon.minOrderAmount} required for this coupon`,
    };
  }

  // Brand-scoped coupons discount only that brand's line items
  let eligibleAmount = subtotal;
  if (coupon.brandId) {
    eligibleAmount = items
      .filter((it) => String(it.brandId) === String(coupon.brandId))
      .reduce((s, it) => s + it.unitPrice * it.quantity, 0);
    if (eligibleAmount === 0) {
      return { ok: false, reason: 'This coupon only applies to items from its brand' };
    }
  }

  let discount;
  if (coupon.type === 'percentage') {
    discount = (eligibleAmount * coupon.value) / 100;
    if (coupon.maxDiscount > 0) discount = Math.min(discount, coupon.maxDiscount);
  } else {
    discount = Math.min(coupon.value, eligibleAmount);
  }
  return { ok: true, discount: Math.round(discount) };
};

const computeTotals = (items, discount, settings) => {
  const subtotal = items.reduce((s, it) => s + it.unitPrice * it.quantity, 0);
  const shippingFee = computeShippingFee(items, settings);
  return {
    subtotal,
    discount,
    shippingFee,
    total: subtotal - discount + shippingFee,
  };
};

/** Unit price pinned at time-of-add: (salePrice ?? basePrice) + variant.additionalPrice */
const unitPriceFor = (product, variant) =>
  (product.salePrice != null ? product.salePrice : product.basePrice) +
  (variant.additionalPrice || 0);

/**
 * ── DB-backed operations ───────────────────────────────────────────
 */

const getOrCreateCart = async (userId) => {
  let cart = await Cart.findOne({ userId });
  if (!cart) cart = await Cart.create({ userId, items: [] });
  return cart;
};

/**
 * Serialize a cart to the frontend Cart interface, recomputing every total
 * and re-checking the applied coupon (dropping it if it no longer applies).
 * Items carry extra display fields (productName/productImage/size/color/brandName)
 * the cart screen renders — additive to the CartItem contract.
 */
const serializeCart = async (cart) => {
  const settings = await getShoppingSettings();
  await cart.populate([
    { path: 'items.product', select: 'name images variants basePrice salePrice' },
    { path: 'items.brandId', select: 'name' },
  ]);

  const items = cart.items.map((it) => {
    const product = it.product || {};
    const variant =
      (product.variants || []).find((v) => String(v._id) === String(it.variantId)) || {};
    const brandDoc = it.brandId && it.brandId.name ? it.brandId : null;
    return {
      itemId: String(it._id),
      productId: product._id ? String(product._id) : String(it.product),
      brandId: brandDoc ? String(brandDoc._id) : String(it.brandId),
      brandName: brandDoc ? brandDoc.name : '',
      variantId: String(it.variantId),
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      totalPrice: it.unitPrice * it.quantity,
      productName: product.name || '',
      productImage: (product.images && product.images[0]) || '',
      size: variant.size,
      color: variant.color,
      colorCode: variant.colorCode,
    };
  });

  let discount = 0;
  let appliedCoupon = cart.appliedCoupon || undefined;
  if (appliedCoupon) {
    const coupon = await Coupon.findOne({ couponCode: appliedCoupon.toUpperCase() });
    const result = evaluateCoupon(coupon, items);
    if (result.ok) {
      discount = result.discount;
    } else {
      appliedCoupon = undefined;
      if (cart.appliedCoupon) {
        cart.appliedCoupon = null;
        await cart.save();
      }
    }
  }

  const totals = computeTotals(items, discount, settings);
  return {
    cartId: String(cart._id),
    userId: String(cart.userId),
    items,
    ...totals,
    appliedCoupon,
  };
};

/**
 * Validate an add/update against live product + brand state.
 * Returns { ok: true, product, variant } or { ok: false, status, reason }.
 */
const validateLine = async (productId, variantId, quantity) => {
  const product = await Product.findOne({ _id: productId, isActive: true });
  if (!product) return { ok: false, status: 404, reason: 'Product not found' };

  const brand = await Brand.findOne({ _id: product.brandId, status: 'active', isDeleted: false });
  if (!brand) {
    return { ok: false, status: 400, reason: 'This brand is not currently accepting orders', product };
  }

  const variant = product.variants.find((v) => String(v._id) === String(variantId));
  if (!variant) return { ok: false, status: 404, reason: 'Selected variant not found', product };

  if (variant.stockQuantity < quantity) {
    return {
      ok: false,
      status: 400,
      reason:
        variant.stockQuantity === 0
          ? 'This item is out of stock'
          : `Only ${variant.stockQuantity} left in stock`,
      product,
    };
  }
  return { ok: true, product, variant };
};

module.exports = {
  computeShippingFee,
  evaluateCoupon,
  computeTotals,
  unitPriceFor,
  getOrCreateCart,
  serializeCart,
  validateLine,
};
