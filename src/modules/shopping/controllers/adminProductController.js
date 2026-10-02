const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Brand = require('../models/Brand');
const { audit } = require('../middleware/adminAuth');
const { escapeRegex } = require('../services/catalogService');
const { ok, paginated, fail, parsePagination } = require('../utils/respond');

/**
 * Product moderation — the platform's say over what customers see.
 *
 * Brands were already approved by an admin, but individual products went live
 * the moment a vendor saved them, with no way for the platform to take one
 * down short of suspending the whole brand. Admins can now approve, reject
 * (vendor fixes and resubmits by editing) or remove (vendor cannot republish).
 * Whether new products wait for review is the `autoApproveProducts` setting.
 */

const STATUSES = ['approved', 'pending', 'rejected', 'removed'];

// GET /api/shopping/admin/products?moderationStatus&brandId&search&page&limit
const listProducts = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  const status = req.query.moderationStatus;
  if (status) {
    if (!STATUSES.includes(status)) return fail(res, 400, `moderationStatus must be one of ${STATUSES.join(', ')}`);
    // Products from before moderation have no status and count as approved.
    filter['moderation.status'] = status === 'approved' ? { $in: ['approved', null] } : status;
  }
  if (req.query.brandId) {
    if (!mongoose.isValidObjectId(req.query.brandId)) return fail(res, 400, 'Invalid brand id');
    filter.brandId = req.query.brandId;
  }
  if (req.query.search) filter.name = new RegExp(escapeRegex(String(req.query.search).slice(0, 60)), 'i');

  const [rows, total] = await Promise.all([
    Product.find(filter).populate('brandId', 'name logo').sort({ updatedAt: -1 }).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ]);
  const data = rows.map((p) => {
    const json = p.toJSON();
    json.moderation = p.moderation && p.moderation.status ? p.moderation : { status: 'approved', note: '' };
    json.isActive = p.isActive;
    if (p.brandId && p.brandId.name) {
      json.brandName = p.brandId.name;
      json.brandId = String(p.brandId._id);
    }
    return json;
  });
  return paginated(res, { data, page, limit, total });
});

// PATCH /api/shopping/admin/products/:productId/moderation { status, note }
const moderateProduct = asyncHandler(async (req, res) => {
  const { status, note } = req.body || {};
  if (!['approved', 'rejected', 'removed'].includes(status)) {
    return fail(res, 400, "status must be 'approved', 'rejected' or 'removed'");
  }
  if ((status === 'rejected' || status === 'removed') && !String(note || '').trim()) {
    return fail(res, 400, 'Tell the vendor why — a note is required to reject or remove');
  }
  if (!mongoose.isValidObjectId(req.params.productId)) return fail(res, 400, 'Invalid product id');
  const product = await Product.findById(req.params.productId);
  if (!product) return fail(res, 404, 'Product not found');

  const before = { moderation: product.moderation ? product.moderation.toObject() : null };
  product.moderation = { status, note: String(note || '').trim().slice(0, 500), by: req.user._id, at: new Date() };
  await product.save();
  await audit(req.user._id, 'moderate_product', 'Product', product._id, {
    before,
    after: { moderation: product.moderation.toObject() },
    reason: note,
  });

  // Tell the vendor (best-effort).
  try {
    const brand = await Brand.findById(product.brandId).select('owner').lean();
    if (brand && brand.owner) {
      const words = {
        approved: { title: 'Product approved', message: `"${product.name}" is live in your store.` },
        rejected: { title: 'Product needs changes', message: `"${product.name}" was not approved: ${product.moderation.note}` },
        removed: { title: 'Product removed', message: `"${product.name}" was removed from your store: ${product.moderation.note}` },
      }[status];
      await require('../services/orderNotifications').deliver({
        recipient: brand.owner,
        recipientRole: 'vendor',
        type: 'product_moderation',
        title: words.title,
        message: words.message,
        data: { productId: String(product._id), status },
        pushType: 'product_moderation',
      });
    }
  } catch (e) {
    console.error(`[moderation] vendor notify failed product=${product._id}: ${e.message}`);
  }

  const json = product.toJSON();
  json.moderation = product.moderation;
  return ok(res, json);
});

module.exports = { listProducts, moderateProduct, STATUSES };
