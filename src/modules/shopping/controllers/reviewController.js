const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Order = require('../models/Order');
const ProductReview = require('../models/ProductReview');
const { ok, paginated, fail, parsePagination } = require('../utils/respond');

// @desc  GET /api/shopping/products/:productId/reviews (public)
const getProductReviews = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  if (!mongoose.isValidObjectId(req.params.productId)) {
    return fail(res, 400, 'Invalid product ID');
  }
  const filter = { productId: req.params.productId };
  const [reviews, total] = await Promise.all([
    ProductReview.find(filter)
      .populate('userId', 'name fullName profilePicture')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    ProductReview.countDocuments(filter),
  ]);
  return paginated(res, { data: reviews, page, limit, total });
});

// @desc  POST /api/shopping/products/:productId/review (customer)
// Allowed only with a delivered order containing the product; one review
// per product per order; recomputes product.rating / totalReviews.
const submitProductReview = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  if (!mongoose.isValidObjectId(productId)) return fail(res, 400, 'Invalid product ID');

  const rating = Number(req.body.rating);
  if (!rating || rating < 1 || rating > 5) return fail(res, 400, 'Rating must be 1-5');
  if (!req.body.comment) return fail(res, 400, 'A review comment is required');

  const product = await Product.findById(productId);
  if (!product) return fail(res, 404, 'Product not found');

  // Find a delivered order of this user that contains the product and
  // has not been reviewed yet (one review per product per order).
  const candidates = await Order.find({
    userId: req.user._id,
    orderStatus: 'delivered',
    'items.productId': product._id,
  }).sort({ deliveredAt: -1 });
  if (candidates.length === 0) {
    return fail(res, 403, 'You can only review products from a delivered order');
  }

  let order = null;
  for (const candidate of candidates) {
    const already = await ProductReview.findOne({
      productId: product._id,
      userId: req.user._id,
      order: candidate._id,
    });
    if (!already) {
      order = candidate;
      break;
    }
  }
  if (!order) return fail(res, 400, 'You have already reviewed this product for your order');

  const review = await ProductReview.create({
    productId: product._id,
    brandId: product.brandId,
    userId: req.user._id,
    order: order._id,
    rating,
    title: req.body.title,
    comment: req.body.comment,
    images: Array.isArray(req.body.images) ? req.body.images : [],
    isVerifiedPurchase: true,
  });

  // Atomic recompute of the denormalised rating fields
  const [agg] = await ProductReview.aggregate([
    { $match: { productId: product._id } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  await Product.updateOne(
    { _id: product._id },
    { $set: { rating: Math.round((agg.avg || 0) * 10) / 10, totalReviews: agg.count || 0 } }
  );

  await review.populate('userId', 'name fullName profilePicture');
  return ok(res, review, 201);
});

module.exports = { getProductReviews, submitProductReview };
