/**
 * Cougar + Outfitters brand seed (QA.md Prompt 3).
 *
 * Idempotent, re-runnable: every entity is upserted by a stable natural key
 * (slug, sku, coupon code, email, order-guard on customer set). Running this
 * twice never duplicates a document.
 *
 * Exports `seedBrands()` which assumes an ACTIVE mongoose connection (the
 * caller — scripts/seed-shopping.js, or this file run standalone — owns
 * connect/disconnect). Order payments and payouts go through the real
 * checkoutService / orderService / WalletService code paths, not hand-rolled
 * writes, so the seeded ledger is indistinguishable from what real usage
 * would produce.
 */
const mongoose = require('mongoose');
const Provider = require('../../../models/Provider');
const User = require('../../../models/User');
const WalletService = require('../../../services/walletService');

const Brand = require('../models/Brand');
const Category = require('../models/Category');
const Product = require('../models/Product');
const Outlet = require('../models/Outlet');
const Coupon = require('../models/Coupon');
const Address = require('../models/Address');
const Order = require('../models/Order');
const OrderGroup = require('../models/OrderGroup');
const ReturnRequest = require('../models/ReturnRequest');
const ProductReview = require('../models/ProductReview');
const { slugify } = require('../utils/ids');

const cartService = require('../services/cartService');
const checkoutService = require('../services/checkoutService');
const orderService = require('../services/orderService');

const log = (msg) => console.log(`  ${msg}`);
const IMG = (seed) => `https://picsum.photos/seed/${seed}/700/700`;

/* ── Brand specs ─────────────────────────────────────────────────── */

const COUGAR = {
  slug: 'cougar',
  name: 'Cougar',
  tagline: 'Step into class',
  description:
    'Premium footwear and leather goods for the modern Pakistani professional — formal shoes, loafers and accessories crafted for classic, timeless style.',
  primaryColor: '#1C1C1C',
  secondaryColor: '#8B5E34',
  accentColor: '#C9A66B',
  vendor: { email: 'vendor.cougar@metromatrix.pk', fullName: 'Zeeshan Malik', phoneNumber: '03001234520' },
  categories: [
    "Men's Formal Shoes",
    "Men's Casual Shoes",
    'Loafers',
    'Sandals',
    'Boots',
    "Women's Footwear",
    'Bags',
    'Belts & Wallets',
  ],
  outlets: [
    { name: 'Liberty Market', address: 'Liberty Market, Gulberg III', lat: 31.5100, lng: 74.3436, postal: '54660' },
    { name: 'Packages Mall', address: 'Packages Mall, Walton Road', lat: 31.4996, lng: 74.3626, postal: '54700' },
  ],
};

const OUTFITTERS = {
  slug: 'outfitters',
  name: 'Outfitters',
  tagline: 'Wear your attitude',
  description:
    'Young, casual, streetwear-leaning fashion for men and women — everyday essentials with an edge.',
  primaryColor: '#1A1A2E',
  secondaryColor: '#E67E22',
  accentColor: '#F1C40F',
  vendor: { email: 'vendor.outfitters@metromatrix.pk', fullName: 'Ahmed Raza', phoneNumber: '03001234501' },
  men: [
    'T-Shirts',
    'Shirts',
    'Denim',
    'Trousers',
    'Hoodies & Sweatshirts',
    'Outerwear',
    'Footwear',
    'Accessories',
  ],
  women: ['Tops', 'Dresses', 'Denim', 'Co-ords', 'Outerwear', 'Footwear', 'Accessories'],
  outlets: [
    { name: 'Fortress Stadium', address: 'Fortress Stadium, Lahore Cantt', lat: 31.5225, lng: 74.3583, postal: '54810' },
    { name: 'Emporium Mall', address: 'Emporium Mall, Johar Town', lat: 31.4676, lng: 74.2665, postal: '54782' },
  ],
};

/* ── Product templates ───────────────────────────────────────────── */

const SHOE_SIZES = ['40', '41', '42', '43', '44'];
const WOMEN_SHOE_SIZES = ['37', '38', '39', '40'];
const ONE_SIZE = ['One Size'];

// [name, basePrice, salePrice|null, sizes, category]
const COUGAR_PRODUCTS = [
  ['Oxford Cap-Toe', 8499, 6999, SHOE_SIZES, "Men's Formal Shoes"],
  ['Derby Classic', 7999, null, SHOE_SIZES, "Men's Formal Shoes"],
  ['Monk Strap', 8999, 7499, SHOE_SIZES, "Men's Formal Shoes"],
  ['Chelsea Formal', 8299, null, SHOE_SIZES, "Men's Formal Shoes"],
  ['Suede Desert Boot Low', 6499, 5499, SHOE_SIZES, "Men's Casual Shoes"],
  ['Canvas Street Sneaker', 4999, null, SHOE_SIZES, "Men's Casual Shoes"],
  ['Leather Low-Top', 6999, 5999, SHOE_SIZES, "Men's Casual Shoes"],
  ['Penny Loafer', 6799, null, SHOE_SIZES, 'Loafers'],
  ['Tassel Loafer', 7299, 6299, SHOE_SIZES, 'Loafers'],
  ['Horsebit Loafer', 7599, null, SHOE_SIZES, 'Loafers'],
  ['Suede Loafer', 6999, 5999, SHOE_SIZES, 'Loafers'],
  ['Leather Slide', 2999, null, SHOE_SIZES, 'Sandals'],
  ['Peshawari Chappal', 2499, 1999, SHOE_SIZES, 'Sandals'],
  ['Sport Sandal', 3299, null, SHOE_SIZES, 'Sandals'],
  ['Chelsea Boot', 9499, 7999, SHOE_SIZES, 'Boots'],
  ['Chukka Boot', 8999, null, SHOE_SIZES, 'Boots'],
  ['Combat Boot', 10499, 8999, SHOE_SIZES, 'Boots'],
  ['Work Boot', 9999, null, SHOE_SIZES, 'Boots'],
  ['Block Heel Pump', 6499, 5499, WOMEN_SHOE_SIZES, "Women's Footwear"],
  ['Ballet Flat', 4999, null, WOMEN_SHOE_SIZES, "Women's Footwear"],
  ['Ankle Boot', 7499, 6499, WOMEN_SHOE_SIZES, "Women's Footwear"],
  ['Wedge Sandal', 5499, null, WOMEN_SHOE_SIZES, "Women's Footwear"],
  ['Leather Tote', 8999, 7499, ONE_SIZE, 'Bags'],
  ['Crossbody Sling', 5499, null, ONE_SIZE, 'Bags'],
  ['Laptop Backpack', 8499, 6999, ONE_SIZE, 'Bags'],
  ['Reversible Leather Belt', 2499, null, ONE_SIZE, 'Belts & Wallets'],
  ['Bifold Wallet', 1999, 1599, ONE_SIZE, 'Belts & Wallets'],
  ['Cardholder', 1499, null, ONE_SIZE, 'Belts & Wallets'],
];

const OUTFITTERS_PRODUCTS = [
  ['Graphic Print Tee', 1899, 1499, ['S', 'M', 'L', 'XL'], 'men', 'T-Shirts'],
  ['Essential Crew Tee', 1499, null, ['S', 'M', 'L', 'XL'], 'men', 'T-Shirts'],
  ['Oxford Casual Shirt', 3299, 2799, ['S', 'M', 'L', 'XL'], 'men', 'Shirts'],
  ['Denim Overshirt', 4499, null, ['M', 'L', 'XL'], 'men', 'Shirts'],
  ['Slim Fit Jeans', 3999, 3499, ['30', '32', '34', '36'], 'men', 'Denim'],
  ['Straight Cut Jeans', 3799, null, ['30', '32', '34', '36'], 'men', 'Denim'],
  ['Cargo Trousers', 3999, 3499, ['30', '32', '34'], 'men', 'Trousers'],
  ['Chino Trousers', 3499, null, ['30', '32', '34', '36'], 'men', 'Trousers'],
  ['Pullover Hoodie', 4499, 3799, ['M', 'L', 'XL'], 'men', 'Hoodies & Sweatshirts'],
  ['Crewneck Sweatshirt', 3999, null, ['S', 'M', 'L', 'XL'], 'men', 'Hoodies & Sweatshirts'],
  ['Bomber Jacket', 7999, 6999, ['M', 'L', 'XL'], 'men', 'Outerwear'],
  ['Denim Jacket', 6499, null, ['M', 'L', 'XL'], 'men', 'Outerwear'],
  ['Canvas Sneaker', 4999, 4299, SHOE_SIZES, 'men', 'Footwear'],
  ['Chunky Trainer', 6499, null, SHOE_SIZES, 'men', 'Footwear'],
  ['Canvas Cap', 999, 799, ONE_SIZE, 'men', 'Accessories'],
  ['Woven Belt', 1299, null, ONE_SIZE, 'men', 'Accessories'],
  ['Ribbed Crop Top', 1699, 1399, ['XS', 'S', 'M', 'L'], 'women', 'Tops'],
  ['Oversized Blouse', 2299, null, ['XS', 'S', 'M', 'L'], 'women', 'Tops'],
  ['Wrap Midi Dress', 4999, 4299, ['XS', 'S', 'M', 'L'], 'women', 'Dresses'],
  ['Shirt Dress', 4499, null, ['XS', 'S', 'M', 'L'], 'women', 'Dresses'],
  ['Mom Fit Jeans', 4299, 3699, ['28', '30', '32', '34'], 'women', 'Denim'],
  ['Denim Skirt', 2999, null, ['28', '30', '32', '34'], 'women', 'Denim'],
  ['Knit Co-ord Set', 5499, 4699, ['XS', 'S', 'M', 'L'], 'women', 'Co-ords'],
  ['Utility Co-ord Set', 5999, null, ['XS', 'S', 'M', 'L'], 'women', 'Co-ords'],
  ['Puffer Jacket', 6999, 5999, ['S', 'M', 'L'], 'women', 'Outerwear'],
  ['Trench Coat', 7999, null, ['S', 'M', 'L'], 'women', 'Outerwear'],
  ['Platform Sneaker', 5499, 4699, WOMEN_SHOE_SIZES, 'women', 'Footwear'],
  ['Strappy Sandal', 3499, null, WOMEN_SHOE_SIZES, 'women', 'Footwear'],
  ['Tote Bag', 3999, 3299, ONE_SIZE, 'women', 'Accessories'],
  ['Statement Earrings', 1299, null, ONE_SIZE, 'women', 'Accessories'],
];

/** Deterministic, varied stock so the catalogue shows every stock state:
 * healthy, low (<5), out-of-stock on one variant, and fully out-of-stock. */
const stockPattern = (pIndex, sizes) => {
  const mod = pIndex % 4;
  return sizes.map((_, vIdx) => {
    if (mod === 3) return 0; // whole product out of stock
    if (vIdx === 0) return mod === 2 ? 3 : 14 + ((pIndex + vIdx) % 5) * 6; // low or healthy
    if (mod === 1 && vIdx === sizes.length - 1) return 0; // one variant OOS
    return 6 + ((pIndex + vIdx * 2) % 6) * 5;
  });
};

/* ── Coupons ──────────────────────────────────────────────────────── */

const buildCoupons = (cougar, outfitters) => {
  const now = Date.now();
  const day = 86400000;
  return [
    { couponCode: 'COUGAR15', brandId: cougar._id, type: 'percentage', value: 15, minOrderAmount: 5000, maxDiscount: 2500 },
    { couponCode: 'COUGARLEATHER', brandId: cougar._id, type: 'fixed', value: 800, minOrderAmount: 4000, maxDiscount: 0 },
    { couponCode: 'COUGARVIP', brandId: cougar._id, type: 'percentage', value: 20, minOrderAmount: 9000, maxDiscount: 3500 },
    { couponCode: 'OUTFIT20', brandId: outfitters._id, type: 'percentage', value: 20, minOrderAmount: 5000, maxDiscount: 2500 },
    { couponCode: 'OUTFITNEW', brandId: outfitters._id, type: 'fixed', value: 500, minOrderAmount: 3000, maxDiscount: 0 },
    { couponCode: 'OUTFITSTREET', brandId: outfitters._id, type: 'percentage', value: 15, minOrderAmount: 4000, maxDiscount: 1800 },
  ].map((c) => ({
    ...c,
    validFrom: new Date(now - 7 * day),
    validUntil: new Date(now + 90 * day),
    usageLimit: 500,
    usedCount: 0,
    isActive: true,
  }));
};

const CUSTOMERS = [
  { email: 'shopper1.qa@metromatrix.pk', fullName: 'Hina Aslam', phoneNumber: '03005550011' },
  { email: 'shopper2.qa@metromatrix.pk', fullName: 'Usman Tariq', phoneNumber: '03005550012' },
  { email: 'shopper3.qa@metromatrix.pk', fullName: 'Mahnoor Fatima', phoneNumber: '03005550013' },
];
const CUSTOMER_PASSWORD = 'Shopper@123';

/* ── Upsert helpers ──────────────────────────────────────────────── */

async function upsertVendor(spec) {
  let provider = await Provider.findOne({ email: spec.email });
  if (!provider) {
    provider = await Provider.create({
      email: spec.email,
      password: 'Vendor@123',
      fullName: spec.fullName,
      phoneNumber: spec.phoneNumber,
      providerType: 'vendor',
      category: 'retail',
      emailVerified: 'active',
      adminVerified: 'active',
      isActive: true,
    });
    log(`vendor created: ${spec.email}`);
  } else {
    // Same email can already exist from an earlier seed script (e.g.
    // vendor.outfitters@metromatrix.pk is also created by seed-accounts.js
    // with a different password) — reset it so the documented Vendor@123
    // credential genuinely works, not just on a fresh account.
    provider.providerType = 'vendor';
    provider.emailVerified = 'active';
    provider.adminVerified = 'active';
    provider.isActive = true;
    provider.password = 'Vendor@123';
    await provider.save();
  }
  return provider;
}

async function upsertBrand(spec, owner, topCategories) {
  let brand = await Brand.findOne({ slug: spec.slug });
  if (!brand) {
    brand = await Brand.create({
      name: spec.name,
      slug: spec.slug,
      tagline: spec.tagline,
      description: spec.description,
      logo: IMG(`${spec.slug}-logo`),
      bannerImage: IMG(`${spec.slug}-banner`),
      primaryColor: spec.primaryColor,
      secondaryColor: spec.secondaryColor,
      accentColor: spec.accentColor,
      categories: topCategories,
      contactEmail: spec.vendor.email,
      contactPhone: `+92-42-3576${Math.floor(1000 + Math.random() * 9000)}`,
      owner: owner._id,
      status: 'active',
      approvedAt: new Date(),
    });
    log(`brand created: ${spec.name}`);
  } else {
    brand.description = spec.description;
    brand.tagline = spec.tagline;
    brand.categories = topCategories;
    if (!brand.owner) brand.owner = owner._id;
    brand.status = 'active';
    await brand.save();
    log(`brand refreshed: ${spec.name}`);
  }
  return brand;
}

async function upsertFlatCategory(brand, name) {
  const slug = slugify(name);
  let cat = await Category.findOne({ brandId: brand._id, slug });
  if (!cat) cat = await Category.create({ brandId: brand._id, name, slug, icon: 'tag' });
  return cat;
}

/** Parent lookup reuses a pre-existing flat category of the same slug if one
 * exists (e.g. legacy 'Men'/'Women' rows from the old shopping seed), so the
 * old and new data converge onto one tree instead of colliding. */
async function upsertCategoryTree(brand, parentName, childNames) {
  const parentSlug = slugify(parentName);
  let parent = await Category.findOne({ brandId: brand._id, slug: parentSlug });
  if (!parent) parent = await Category.create({ brandId: brand._id, name: parentName, slug: parentSlug, icon: 'tag' });

  const children = {};
  for (const childName of childNames) {
    const childSlug = `${parentSlug}-${slugify(childName)}`;
    let child = await Category.findOne({ brandId: brand._id, slug: childSlug });
    if (!child) {
      child = await Category.create({
        brandId: brand._id,
        name: childName,
        slug: childSlug,
        icon: 'tag',
        parentId: parent._id,
      });
    }
    children[childName] = child;
  }
  return { parent, children };
}

async function upsertCougarCatalogue(brand) {
  const cats = {};
  for (const name of COUGAR.categories) cats[name] = await upsertFlatCategory(brand, name);

  const products = [];
  for (let i = 0; i < COUGAR_PRODUCTS.length; i += 1) {
    const [name, basePrice, salePrice, sizes, catName] = COUGAR_PRODUCTS[i];
    const sku = `CGR-${1001 + i}`;
    let product = await Product.findOne({ brandId: brand._id, sku });
    if (!product) {
      const stocks = stockPattern(i, sizes);
      product = new Product({
        brandId: brand._id,
        categoryId: cats[catName]._id,
        sku,
        name,
        description: `${name} by Cougar. ${COUGAR.tagline}. Genuine materials, crafted for everyday wear.`,
        images: [IMG(`${sku}-1`), IMG(`${sku}-2`)],
        basePrice,
        salePrice: salePrice || null,
        variants: sizes.map((size, idx) => ({
          size,
          additionalPrice: 0,
          stockQuantity: stocks[idx],
          sku: `${sku}-${String(size).replace(/\s+/g, '')}`,
        })),
        isFeatured: i < 4,
        isNewArrival: i >= 4 && i < 8,
        tags: ['cougar', catName.toLowerCase(), name.split(' ')[0].toLowerCase()],
      });
      product.syncStockFlag();
      await product.save();
    }
    products.push(product);
  }
  return products;
}

async function upsertOutfittersCatalogue(brand) {
  const { children: menCats } = await upsertCategoryTree(brand, 'Men', OUTFITTERS.men);
  const { children: womenCats } = await upsertCategoryTree(brand, 'Women', OUTFITTERS.women);

  // Legacy flat categories from the original 4-brand shopping seed
  // ('Shirts','Denim','Shoes','Accessories' with no parent) are superseded
  // by the nested Men/Women tree above — deactivate them so the catalogue
  // tree isn't duplicated, without deleting the products that still
  // reference them.
  await Category.updateMany(
    { brandId: brand._id, parentId: null, slug: { $in: ['shirts', 'denim', 'shoes', 'accessories'] } },
    { $set: { isActive: false } }
  );

  const catsByGroup = { men: menCats, women: womenCats };
  const products = [];
  for (let i = 0; i < OUTFITTERS_PRODUCTS.length; i += 1) {
    const [name, basePrice, salePrice, sizes, group, catName] = OUTFITTERS_PRODUCTS[i];
    const sku = `OTF-${1001 + i}`;
    let product = await Product.findOne({ brandId: brand._id, sku });
    if (!product) {
      const stocks = stockPattern(i, sizes);
      product = new Product({
        brandId: brand._id,
        categoryId: catsByGroup[group][catName]._id,
        sku,
        name,
        description: `${name} by Outfitters. ${OUTFITTERS.tagline}. Street-ready pieces made for daily rotation.`,
        images: [IMG(`${sku}-1`), IMG(`${sku}-2`)],
        basePrice,
        salePrice: salePrice || null,
        variants: sizes.map((size, idx) => ({
          size,
          additionalPrice: 0,
          stockQuantity: stocks[idx],
          sku: `${sku}-${String(size).replace(/\s+/g, '')}`,
        })),
        isFeatured: i < 4,
        isNewArrival: i >= 4 && i < 8,
        tags: ['outfitters', group, catName.toLowerCase(), name.split(' ')[0].toLowerCase()],
      });
      product.syncStockFlag();
      await product.save();
    }
    products.push(product);
  }
  return products;
}

async function upsertOutlets(brand, brandSpec) {
  for (const spot of brandSpec.outlets) {
    const slug = `${brandSpec.slug}-${slugify(spot.name)}`;
    const exists = await Outlet.findOne({ slug });
    if (!exists) {
      await Outlet.create({
        name: `${brandSpec.name} ${spot.name}`,
        slug,
        description: `${brandSpec.name} outlet at ${spot.address}.`,
        brandId: brand._id,
        colorScheme: {
          primaryColor: brandSpec.primaryColor,
          secondaryColor: brandSpec.secondaryColor,
          accentColor: brandSpec.accentColor,
        },
        location: { address: spot.address, city: 'Lahore', state: 'Punjab', country: 'Pakistan', postalCode: spot.postal },
        geo: { type: 'Point', coordinates: [spot.lng, spot.lat] },
        phone: '+92-42-35761234',
        email: `${slug}@metromatrix.pk`,
        openingHours: 'Mon–Sun: 11:00 AM – 10:00 PM',
        managerName: brandSpec.vendor.fullName,
        images: [IMG(`${slug}-store`)],
        floorArea: 2200,
      });
      log(`outlet created: ${brandSpec.name} ${spot.name}`);
    }
  }
}

async function upsertCoupons(cougar, outfitters) {
  const coupons = buildCoupons(cougar, outfitters);
  for (const c of coupons) {
    await Coupon.updateOne({ couponCode: c.couponCode }, { $setOnInsert: c }, { upsert: true });
  }
  log(`coupons upserted (${coupons.length})`);
}

async function upsertCustomers() {
  const users = [];
  for (const spec of CUSTOMERS) {
    let user = await User.findOne({ email: spec.email });
    if (!user) {
      user = await User.create({
        email: spec.email,
        password: CUSTOMER_PASSWORD,
        fullName: spec.fullName,
        phoneNumber: spec.phoneNumber,
        isActive: true,
        isEmailVerified: true,
      });
      log(`customer created: ${spec.email} / ${CUSTOMER_PASSWORD}`);
    }

    const wallet = await WalletService.getOrCreateWallet(user._id, 'User');
    if (wallet.balance < 30000) {
      const amount = 60000 - wallet.balance;
      await wallet.credit(amount);
      await WalletService.recordTransaction(wallet._id, {
        type: 'credit',
        amount,
        description: 'Seed top-up for Cougar/Outfitters demo',
        source: 'admin_adjustment',
        status: 'completed',
      });
    }

    const existingAddress = await Address.findOne({ userId: user._id });
    if (!existingAddress) {
      await Address.create({
        userId: user._id,
        label: 'Home',
        fullName: user.fullName,
        phone: spec.phoneNumber,
        addressLine1: 'House 22, Block C, Model Town',
        city: 'Lahore',
        area: 'Model Town',
        state: 'Punjab',
        postalCode: '54700',
        isDefault: true,
      });
    }
    users.push(user);
  }
  return users;
}

/* ── Order lifecycle (through the real checkout/order services) ────── */

const CHAIN_TO = {
  pending: [],
  confirmed: ['confirmed'],
  processing: ['confirmed', 'processing'],
  shipped: ['confirmed', 'processing', 'shipped'],
  out_for_delivery: ['confirmed', 'processing', 'shipped', 'out_for_delivery'],
  delivered: ['confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered'],
  cancelled: ['cancelled'],
  returned: ['confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'returned'],
  refunded: ['confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'returned', 'refunded'],
};
const TRACKED_STATUSES = ['shipped', 'out_for_delivery', 'delivered', 'returned', 'refunded'];

async function addToCart(user, product, variant, quantity) {
  const cart = await cartService.getOrCreateCart(user._id);
  const check = await cartService.validateLine(product._id, variant._id, quantity);
  if (!check.ok) throw new Error(`seed cart error (${product.name}): ${check.reason}`);
  cart.items.push({
    product: check.product._id,
    brandId: check.product.brandId,
    variantId: variant._id,
    quantity,
    unitPrice: cartService.unitPriceFor(check.product, check.variant),
  });
  await cart.save();
  return cart;
}

async function advanceOrder(orderMongoId, targetStatus, vendorProviderId) {
  let order = await Order.findById(orderMongoId);
  for (const status of CHAIN_TO[targetStatus]) {
    order = await orderService.transition(order, status, { id: vendorProviderId, role: 'vendor' }, {
      trackingNumber: TRACKED_STATUSES.includes(status)
        ? `TCS-${29800000 + Math.floor(Math.random() * 99999)}`
        : undefined,
    });
  }
  return order;
}

/** Shift a just-created order/group cluster into the past by `daysAgo`,
 * preserving the relative spacing of its statusHistory (all timestamps
 * happened within the same script tick, so one uniform shift is exact).
 *
 * Uses the raw driver, not the Mongoose model, for the createdAt writes:
 * Mongoose treats a schema's `timestamps: true` createdAt path as immutable
 * and silently drops it from any $set on Model.updateOne — the call reports
 * modifiedCount: 1 (other fields in the same $set really did change) while
 * createdAt quietly stays whatever it already was. Confirmed by testing
 * directly against this schema; the raw collection has no such protection. */
async function backdate(groupMongoId, orderMongoIds, daysAgo) {
  const shiftMs = daysAgo * 86400000;
  const db = mongoose.connection.db;
  const orderGroups = db.collection('shoppingordergroups');
  const orders = db.collection('shoppingorders');
  const walletTransactions = db.collection('wallettransactions');

  const group = await OrderGroup.findById(groupMongoId);
  await orderGroups.updateOne(
    { _id: group._id },
    { $set: { createdAt: new Date(group.createdAt.getTime() - shiftMs) } }
  );

  for (const orderId of orderMongoIds) {
    const order = await Order.findById(orderId);
    const newCreatedAt = new Date(order.createdAt.getTime() - shiftMs);
    const newHistory = order.statusHistory.map((h) => ({
      ...h.toObject(),
      changedAt: new Date(h.changedAt.getTime() - shiftMs),
    }));
    const set = { createdAt: newCreatedAt, statusHistory: newHistory };
    if (order.deliveredAt) set.deliveredAt = new Date(order.deliveredAt.getTime() - shiftMs);
    await orders.updateOne({ _id: order._id }, { $set: set });
  }

  // Every wallet transaction tied to this checkout or its per-brand orders
  // (customer debit, vendor payout + commission, refunds) shifts together.
  await walletTransactions.updateMany(
    {
      $or: [
        { 'relatedTo.kind': 'OrderGroup', 'relatedTo.id': group._id },
        { 'relatedTo.kind': 'Order', 'relatedTo.id': { $in: orderMongoIds.map((id) => new mongoose.Types.ObjectId(String(id))) } },
      ],
    },
    [{ $set: { createdAt: { $subtract: ['$createdAt', shiftMs] } } }]
  );
}

/**
 * One line item drawn from a brand's product list. Some seed products are
 * deliberately fully out-of-stock (stockPattern mod 3) to exercise that
 * catalogue state — skip forward past those so real orders never try to
 * buy something with zero stock.
 */
function pickLine(products, index) {
  for (let offset = 0; offset < products.length; offset += 1) {
    const product = products[(index + offset) % products.length];
    const variant = product.variants.find((v) => v.stockQuantity > 0);
    if (variant) return { product, variant };
  }
  throw new Error('No in-stock product available to seed an order line');
}

const ORDER_PLAN = [
  { status: 'pending', payment: 'cod', brands: ['outfitters'] },
  { status: 'confirmed', payment: 'wallet', brands: ['outfitters'] },
  { status: 'processing', payment: 'wallet', brands: ['cougar'] },
  { status: 'shipped', payment: 'cod', brands: ['cougar'] },
  { status: 'out_for_delivery', payment: 'wallet', brands: ['outfitters'], coupon: 'OUTFIT20' },
  { status: 'delivered', payment: 'wallet', brands: ['outfitters'] },
  { status: 'delivered', payment: 'cod', brands: ['cougar'], coupon: 'COUGAR15' },
  { status: 'cancelled', payment: 'wallet', brands: ['cougar'] },
  { status: 'returned', payment: 'wallet', brands: ['outfitters'] },
  { status: 'refunded', payment: 'wallet', brands: ['cougar'] },
  { status: 'confirmed', payment: 'wallet', brands: ['outfitters', 'cougar'] }, // multi-brand OrderGroup
];

async function seedCrossBrandOrders(customers, brands, productsBySlug) {
  const existing = await OrderGroup.countDocuments({ userId: { $in: customers.map((c) => c._id) } });
  if (existing > 0) {
    log(`orders already seeded for QA customers (${existing} groups) — skipping (idempotent)`);
    return { groups: existing, orders: null, skipped: true };
  }

  let createdGroups = 0;
  let createdOrders = 0;
  let multiBrandGroupId = null;

  for (let i = 0; i < ORDER_PLAN.length; i += 1) {
    const plan = ORDER_PLAN[i];
    const customer = customers[i % customers.length];

    let running = 0;
    for (let b = 0; b < plan.brands.length; b += 1) {
      const brandSlug = plan.brands[b];
      const products = productsBySlug[brandSlug];
      const { product: p1, variant: v1 } = pickLine(products, i + b);
      const { product: p2, variant: v2 } = pickLine(products, i + b + 5);
      await addToCart(customer, p1, v1, 1);
      if (p2._id.toString() !== p1._id.toString() || v2._id.toString() !== v1._id.toString()) {
        await addToCart(customer, p2, v2, 1);
      }
      running += 1;
    }

    if (plan.coupon) {
      const cart = await cartService.getOrCreateCart(customer._id);
      cart.appliedCoupon = plan.coupon;
      await cart.save();
    }

    const address = await Address.findOne({ userId: customer._id });
    const result = await checkoutService.checkout(customer, { addressId: address._id, paymentMethod: plan.payment });

    const orderDocs = await Order.find({ orderGroup: result.groupId });
    for (const order of orderDocs) {
      const brand = brands[order.brandId.toString() === brands.cougar._id.toString() ? 'cougar' : 'outfitters'];
      await advanceOrder(order._id, plan.status, brand.owner);
      createdOrders += 1;
    }
    if (plan.brands.length > 1) multiBrandGroupId = result.groupId;

    await backdate(
      result.groupId,
      orderDocs.map((o) => o._id),
      ORDER_PLAN.length - i
    );

    // Return request + review for terminal statuses
    for (const order of orderDocs) {
      const fresh = await Order.findById(order._id);
      if (['returned', 'refunded'].includes(plan.status)) {
        await ReturnRequest.create({
          order: fresh._id,
          userId: customer._id,
          brandId: fresh.brandId,
          items: fresh.items.map((it) => ({
            orderItemId: it._id,
            productId: it.productId,
            productName: it.productName,
            variantId: it.variantId,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
          })),
          reason: 'Size issue: item did not fit as expected',
          status: plan.status === 'refunded' ? 'refunded' : 'approved',
          refundAmount: fresh.total,
        });
      }
      if (plan.status === 'delivered') {
        const firstItem = fresh.items[0];
        const already = await ProductReview.findOne({ productId: firstItem.productId, userId: customer._id, order: fresh._id });
        if (!already) {
          await ProductReview.create({
            productId: firstItem.productId,
            brandId: fresh.brandId,
            userId: customer._id,
            order: fresh._id,
            rating: 4 + (i % 2),
            title: 'Happy with this purchase',
            comment: `The ${firstItem.productName} arrived on time and matches the photos.`,
            isVerifiedPurchase: true,
          });
          const [agg] = await ProductReview.aggregate([
            { $match: { productId: firstItem.productId } },
            { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
          ]);
          await Product.updateOne(
            { _id: firstItem.productId },
            { $set: { rating: Math.round((agg.avg || 0) * 10) / 10, totalReviews: agg.count || 0 } }
          );
        }
      }
    }

    createdGroups += 1;
  }

  return { groups: createdGroups, orders: createdOrders, multiBrandGroupId, skipped: false };
}

/* ── Entry point ─────────────────────────────────────────────────── */

async function seedBrands() {
  log('=== Cougar + Outfitters brand seed ===');

  const cougarVendor = await upsertVendor(COUGAR.vendor);
  const cougarBrand = await upsertBrand(COUGAR, cougarVendor, COUGAR.categories.slice(0, 4));
  const cougarProducts = await upsertCougarCatalogue(cougarBrand);
  await upsertOutlets(cougarBrand, COUGAR);

  const outfittersVendor = await upsertVendor(OUTFITTERS.vendor);
  const outfittersBrand = await upsertBrand(OUTFITTERS, outfittersVendor, ['Men', 'Women']);
  const outfittersProducts = await upsertOutfittersCatalogue(outfittersBrand);
  await upsertOutlets(outfittersBrand, OUTFITTERS);

  log(
    `catalogue ready — Cougar: ${cougarProducts.length} products, Outfitters: ${outfittersProducts.length} products`
  );

  await upsertCoupons(cougarBrand, outfittersBrand);
  const customers = await upsertCustomers();

  const brands = { cougar: cougarBrand, outfitters: outfittersBrand };
  const productsBySlug = { cougar: cougarProducts, outfitters: outfittersProducts };
  const orderResult = await seedCrossBrandOrders(customers, brands, productsBySlug);

  const summary = {
    brands: { cougar: cougarBrand.name, outfitters: outfittersBrand.name },
    products: { cougar: cougarProducts.length, outfitters: outfittersProducts.length },
    outlets: COUGAR.outlets.length + OUTFITTERS.outlets.length,
    coupons: 6,
    customers: CUSTOMERS.map((c) => c.email),
    orders: orderResult,
    logins: {
      vendors: [
        `${COUGAR.vendor.email} / Vendor@123 (Cougar)`,
        `${OUTFITTERS.vendor.email} / Vendor@123 (Outfitters)`,
      ],
      customers: CUSTOMERS.map((c) => `${c.email} / ${CUSTOMER_PASSWORD}`),
    },
  };

  console.log('=== Cougar + Outfitters seed done ===');
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

module.exports = seedBrands;

if (require.main === module) {
  require('dotenv').config();
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(async () => {
      console.log('✓ MongoDB connected');
      await seedBrands();
      await mongoose.disconnect();
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
