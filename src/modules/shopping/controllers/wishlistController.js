const asyncHandler = require('express-async-handler');
const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');
const { ok, fail } = require('../utils/respond');

const getOrCreate = async (userId) => {
  let list = await Wishlist.findOne({ userId });
  if (!list) list = await Wishlist.create({ userId, items: [] });
  return list;
};

/**
 * WishlistItem contract is { productId, brandId, addedAt }; a populated
 * `product` card object is added for the Wishlist screen (additive).
 */
const serialize = async (list) => {
  await list.populate({
    path: 'items.product',
    select: 'name images basePrice salePrice rating totalReviews inStock brandId',
  });
  return list.items
    .filter((it) => it.product) // drop items whose product was removed
    .map((it) => ({
      productId: String(it.product._id),
      brandId: String(it.brandId),
      addedAt: it.addedAt,
      product: it.product.toJSON(),
    }));
};

// @desc  GET /api/shopping/wishlist
const getWishlist = asyncHandler(async (req, res) => {
  const list = await getOrCreate(req.user._id);
  return ok(res, await serialize(list));
});

// @desc  POST /api/shopping/wishlist/:productId
const addToWishlist = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.productId, isActive: true });
  if (!product) return fail(res, 404, 'Product not found');

  const list = await getOrCreate(req.user._id);
  const exists = list.items.some((it) => String(it.product) === String(product._id));
  if (!exists) {
    list.items.push({ product: product._id, brandId: product.brandId });
    await list.save();
  }
  return ok(res, await serialize(list));
});

// @desc  DELETE /api/shopping/wishlist/:productId
const removeFromWishlist = asyncHandler(async (req, res) => {
  const list = await getOrCreate(req.user._id);
  list.items = list.items.filter((it) => String(it.product) !== String(req.params.productId));
  await list.save();
  return ok(res, await serialize(list));
});

module.exports = { getWishlist, addToWishlist, removeFromWishlist };
