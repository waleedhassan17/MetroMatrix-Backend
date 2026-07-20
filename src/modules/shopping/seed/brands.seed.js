/**
 * Cougar + Outfitters brand seed — REAL scraped catalogue data (shop.md
 * Prompt 1). Replaces the earlier synthetic-catalogue version from
 * QA.md Prompt 3.
 *
 * Data source: scripts/scrape-brands.py, run separately, writes
 * scripts/scraped/{cougar,outfitters}-catalog.json. Outfitters is a
 * classic Shopify (Liquid) storefront scraped via the REST /products.json
 * endpoint. Cougar runs on Shopify Hydrogen/Oxygen (a headless React
 * storefront with no Liquid engine, so /products.json 404s) — scraped via
 * the Storefront GraphQL API using the public storefront access token
 * Hydrogen embeds client-side (read-only, no admin access, its intended
 * public use).
 *
 * DESTRUCTIVE BY DESIGN: purges every Brand/Category/Product/Outlet/Coupon
 * and every shopping Order/OrderGroup/ReturnRequest/ProductReview/
 * InventoryLog that isn't Cougar or Outfitters, per the task's explicit
 * instruction. After this seed runs there are EXACTLY TWO brands in the
 * database — asserted with a hard failure if not.
 *
 * Idempotent despite the purge: the purge only ever removes NON-Cougar/
 * Outfitters documents, so a second run finds nothing left to purge and
 * every Cougar/Outfitters entity is upserted by a stable natural key
 * (slug/sku/coupon code/email) — running twice yields identical counts.
 *
 * Exports `seedBrands()` which assumes an ACTIVE mongoose connection (the
 * caller owns connect/disconnect). Order payments and payouts go through
 * the real checkoutService/orderService/WalletService code paths.
 */
const fs = require('fs');
const path = require('path');
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
const InventoryLog = require('../models/InventoryLog');
const { slugify } = require('../utils/ids');

const cartService = require('../services/cartService');
const checkoutService = require('../services/checkoutService');
const orderService = require('../services/orderService');

const log = (msg) => console.log(`  ${msg}`);

const SCRAPED_DIR = path.join(__dirname, '../../../../scripts/scraped');

/* ── Brand specs (real facts from the live sites, per shop.md) ──────── */

const COUGAR = {
  slug: 'cougar',
  name: 'Cougar',
  tagline: 'Casual wear, done properly',
  description:
    'Cougar Clothing — a full apparel brand for Men, Women and Kids. Casual and smart-casual wardrobe staples across shirts, denim, trousers and footwear, at Pakistan’s mid-to-premium price point.',
  primaryColor: '#1C1C1C',
  secondaryColor: '#8B5E34',
  accentColor: '#C9A66B',
  vendor: { email: 'vendor.cougar@metromatrix.pk', fullName: 'Zeeshan Malik', phoneNumber: '03001234520' },
  contactEmail: 'info@cougar.com.pk',
  contactPhone: '042-32301484',
  outlets: [
    { name: 'Emporium Mall', address: 'Emporium Mall, Johar Town', lat: 31.4676, lng: 74.2665, postal: '54782' },
    { name: 'Packages Mall', address: 'Packages Mall, Walton Road', lat: 31.4996, lng: 74.3626, postal: '54700' },
  ],
};

const OUTFITTERS = {
  slug: 'outfitters',
  name: 'Outfitters',
  tagline: 'Wear your attitude',
  description:
    'Outfitters — Pakistan’s youth/streetwear leader, ~60 stores across 22 cities. Everyday essentials for Men and Women at an accessible price point.',
  primaryColor: '#1A1A2E',
  secondaryColor: '#E67E22',
  accentColor: '#F1C40F',
  vendor: { email: 'vendor.outfitters@metromatrix.pk', fullName: 'Ahmed Raza', phoneNumber: '03001234501' },
  contactEmail: 'info@outfitters.com.pk',
  contactPhone: '042-111-000-009',
  outlets: [
    { name: 'Fortress Square', address: 'Fortress Stadium, Lahore Cantt', lat: 31.5225, lng: 74.3583, postal: '54810' },
    { name: 'Gulberg Main Boulevard', address: 'MM Alam Road, Gulberg III', lat: 31.5090, lng: 74.3444, postal: '54660' },
  ],
};

/* ── Category normalisation: raw feed type -> canonical name ────────── */
/* (Reference taxonomy per shop.md's own live-site research.) */

const OUTFITTERS_TYPE_MAP = {
  TEES: 'T-Shirts', APPAREL: 'T-Shirts', POLOS: 'T-Shirts', 'ACTIVEWEAR (TOP)': 'T-Shirts',
  JEANS: 'Denim',
  SHIRTS: 'Shirts', 'SHIRTS/BLOUSES': 'Shirts',
  TROUSERS: 'Trousers',
  SHORTS: 'Shorts', SKIRTS: 'Shorts', 'ACTIVEWEAR (BOTTOM)': 'Shorts',
  'DRESSES & JUMP SUITS': 'Dresses',
  SWEATERS: 'Hoodies & Sweatshirts', SWEATSHIRTS: 'Hoodies & Sweatshirts',
  OUTERWEAR: 'Outerwear',
  'CLOSED SHOES': 'Footwear', 'OPEN SHOES': 'Footwear',
  FRAGRANCES: 'Fragrances',
  SOCKS: 'Accessories', JEWELLERY: 'Accessories', 'BAGS & WALLETS': 'Accessories', BAGS: 'Accessories',
  EARRING: 'Accessories', SUNGLASSES: 'Accessories', 'BELTS & BRACES': 'Accessories', WALLETS: 'Accessories',
  UNDERWEAR: 'Accessories', 'CAPS & HATS': 'Accessories', 'SCARVES & FOULARDS': 'Accessories',
};

const COUGAR_TYPE_MAP = {
  Tee: 'T-Shirts', Polo: 'Polos', Shirt: 'Shirts', Jean: 'Jeans', Jeans: 'Jeans',
  Trouser: 'Trousers', Chino: 'Trousers', '5-Pocket Pant': 'Trousers', 'Chino Pant': 'Trousers',
  Shorts: 'Shorts', Short: 'Shorts',
  'Embroided Top': 'Tops & Blouses', 'Fashion Top': 'Tops & Blouses', 'Top 2PC': 'Co-Ord Sets', '2PC Top': 'Co-Ord Sets',
  Jumpsuit: 'Eastern Wear', Frock: 'Eastern Wear',
};

const normaliseOutfittersCategory = (rawType) => OUTFITTERS_TYPE_MAP[rawType?.toUpperCase()] || 'Accessories';

/** Cougar's productType is "<Gender> <Item>" e.g. "Women Trouser", "Boy Jeans". */
const parseCougarType = (rawType) => {
  const parts = (rawType || 'Apparel').split(' ');
  const genderWord = parts[0];
  const rest = parts.slice(1).join(' ');
  const gender =
    genderWord === 'Men' ? 'Men' : genderWord === 'Women' ? 'Women' : genderWord === 'Boy' || genderWord === 'Girl' ? 'Kids' : 'Women';
  const category = COUGAR_TYPE_MAP[rest] || rest || 'Accessories';
  return { gender, category };
};

const IMG_FALLBACK = (seed) => `https://picsum.photos/seed/${seed}/700/700`;

/* ── Purge ────────────────────────────────────────────────────────────
 * Two things need to happen for "replace all Shopping seed data with
 * exactly two REAL-data brands" to actually hold:
 *   1. Any OTHER brand (old synthetic TechMart/Khaadi/Servis Steps/etc)
 *      is deleted outright — Brand doc and all.
 *   2. Cougar's AND Outfitters' own catalogue/transactional data is ALSO
 *      wiped every run, not just upserted-by-natural-key. The previous
 *      QA.md-era seed already created an "outfitters" brand with 40
 *      SYNTHETIC products using the same SKU prefix (OTF-1001...) this
 *      script's real-data products use — upserting by SKU against that
 *      pre-existing data would find "OTF-1001" already exists and keep
 *      the old FAKE product instead of replacing it with the real
 *      scraped one. Only the Brand document and vendor/customer
 *      identities are preserved (via upsert) across runs; everything
 *      else is rebuilt from scratch every time, which is what makes the
 *      "run twice, diff the document counts, must be identical" idempotency
 *      check meaningful — a deterministic rebuild, not an ambiguous merge.
 */
async function purgeAllShoppingData() {
  const keepSlugs = [COUGAR.slug, OUTFITTERS.slug];
  const otherBrands = await Brand.find({ slug: { $nin: keepSlugs } }).select('_id name');
  const otherBrandIds = otherBrands.map((b) => b._id);
  if (otherBrandIds.length) {
    log(`purge: deleting ${otherBrandIds.length} foreign brand(s): ${otherBrands.map((b) => b.name).join(', ')}`);
  }

  const results = await Promise.all([
    ReturnRequest.deleteMany({}),
    ProductReview.deleteMany({}),
    InventoryLog.deleteMany({}),
    Order.deleteMany({}),
    OrderGroup.deleteMany({}),
    Coupon.deleteMany({}),
    Outlet.deleteMany({}),
    Category.deleteMany({}),
    Product.deleteMany({}),
    Brand.deleteMany({ _id: { $in: otherBrandIds } }),
  ]);
  const [rr, pr, il, ord, grp, cp, ot, ct, pd, br] = results.map((r) => r.deletedCount);
  log(
    `purge: removed foreignBrands=${br} categories=${ct} products=${pd} outlets=${ot} coupons=${cp} ` +
      `orderGroups=${grp} orders=${ord} returns=${rr} reviews=${pr} inventoryLogs=${il}`
  );

  // Reset each QA customer's wallet to a clean, deterministic baseline so
  // re-running the order-seeding step produces identical wallet state
  // every time, instead of compounding balance/history across runs.
  const db = mongoose.connection.db;
  const users = await db.collection('users').find({ email: { $in: CUSTOMERS.map((c) => c.email) } }).toArray();
  const userIds = users.map((u) => u._id);
  if (userIds.length) {
    const wallets = await db.collection('wallets').find({ owner: { $in: userIds }, ownerType: 'User' }).toArray();
    const walletIds = wallets.map((w) => w._id);
    const txDel = await db.collection('wallettransactions').deleteMany({ wallet: { $in: walletIds } });
    await db.collection('wallets').deleteMany({ owner: { $in: userIds }, ownerType: 'User' });
    log(`purge: reset ${wallets.length} customer wallet(s), removed ${txDel.deletedCount} transaction(s)`);
  }

  // Same reset for the two vendor Provider wallets (earnings accumulate
  // across runs otherwise, breaking idempotency).
  const vendorEmails = [COUGAR.vendor.email, OUTFITTERS.vendor.email];
  const providers = await db.collection('providers').find({ email: { $in: vendorEmails } }).toArray();
  const providerIds = providers.map((p) => p._id);
  if (providerIds.length) {
    const pWallets = await db.collection('wallets').find({ owner: { $in: providerIds }, ownerType: 'Provider' }).toArray();
    const pWalletIds = pWallets.map((w) => w._id);
    const pTxDel = await db.collection('wallettransactions').deleteMany({ wallet: { $in: pWalletIds } });
    await db.collection('wallets').deleteMany({ owner: { $in: providerIds }, ownerType: 'Provider' });
    log(`purge: reset ${pWallets.length} vendor wallet(s), removed ${pTxDel.deletedCount} transaction(s)`);
  }
}

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
    // Same email can already exist from an earlier seed script with a
    // different password — reset it so Vendor@123 genuinely works.
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
      logo: IMG_FALLBACK(`${spec.slug}-logo`),
      bannerImage: IMG_FALLBACK(`${spec.slug}-banner`),
      primaryColor: spec.primaryColor,
      secondaryColor: spec.secondaryColor,
      accentColor: spec.accentColor,
      categories: topCategories,
      contactEmail: spec.contactEmail,
      contactPhone: spec.contactPhone,
      owner: owner._id,
      status: 'active',
      approvedAt: new Date(),
    });
    log(`brand created: ${spec.name}`);
  } else {
    brand.description = spec.description;
    brand.tagline = spec.tagline;
    brand.categories = topCategories;
    brand.contactEmail = spec.contactEmail;
    brand.contactPhone = spec.contactPhone;
    if (!brand.owner) brand.owner = owner._id;
    brand.status = 'active';
    await brand.save();
    log(`brand refreshed: ${spec.name}`);
  }
  return brand;
}

async function upsertCategoryTree(brand, sections) {
  // sections: { [genderOrTop: string]: Set<subCategoryName> }
  const tree = {};
  for (const [parentName, subNames] of Object.entries(sections)) {
    const parentSlug = slugify(parentName);
    let parent = await Category.findOne({ brandId: brand._id, slug: parentSlug });
    if (!parent) parent = await Category.create({ brandId: brand._id, name: parentName, slug: parentSlug, icon: 'tag' });
    tree[parentName] = { parent, children: {} };
    for (const subName of subNames) {
      const childSlug = `${parentSlug}-${slugify(subName)}`;
      let child = await Category.findOne({ brandId: brand._id, slug: childSlug });
      if (!child) {
        child = await Category.create({
          brandId: brand._id,
          name: subName,
          slug: childSlug,
          icon: 'tag',
          parentId: parent._id,
        });
      }
      tree[parentName].children[subName] = child;
    }
  }
  return tree;
}

/** Deterministic varied stock so the catalogue demoes every stock state. */
const stockFor = (productIdx, variantIdx, apiAvailable) => {
  if (!apiAvailable) return 0;
  const mod = productIdx % 5;
  if (mod === 0 && variantIdx === 0) return 2; // low stock
  if (mod === 1 && variantIdx === 1) return 0; // one OOS variant on an otherwise-in-stock product
  return 6 + ((productIdx + variantIdx) % 5) * 5; // 6..26
};

async function upsertOutfittersCatalogue(brand, scraped) {
  const genderTags = { Men: new Set(), Women: new Set() };
  const productsMeta = [];
  for (const p of scraped) {
    const gender = p.tags.includes('Men') ? 'Men' : p.tags.includes('Women') ? 'Women' : 'Women';
    const category = normaliseOutfittersCategory(p.productType);
    genderTags[gender].add(category);
    productsMeta.push({ ...p, gender, category });
  }
  const sections = { Men: genderTags.Men, Women: genderTags.Women };
  const tree = await upsertCategoryTree(brand, sections);

  const products = [];
  for (let i = 0; i < productsMeta.length; i += 1) {
    const p = productsMeta[i];
    const sku = `OTF-${1001 + i}`;
    let product = await Product.findOne({ brandId: brand._id, sku });
    if (!product) {
      const categoryDoc = tree[p.gender].children[p.category];
      const prices = p.variants.map((v) => v.price);
      const basePrice = Math.max(...p.variants.map((v) => v.compareAtPrice || v.price));
      const salePrice = Math.min(...prices) < basePrice ? Math.min(...prices) : null;
      product = new Product({
        brandId: brand._id,
        categoryId: categoryDoc ? categoryDoc._id : null,
        sku,
        name: p.title,
        description: (p.bodyHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || `${p.title} by Outfitters.`,
        images: p.images.length ? p.images.slice(0, 3) : [IMG_FALLBACK(`${sku}-1`)],
        basePrice: Math.round(basePrice),
        salePrice: salePrice ? Math.round(salePrice) : null,
        variants: p.variants.map((v, vi) => ({
          size: v.size || 'One Size',
          color: v.color && v.color !== 'FREE' ? v.color : undefined,
          additionalPrice: 0,
          stockQuantity: stockFor(i, vi, v.available),
          sku: v.sku,
        })),
        isFeatured: i < 4,
        isNewArrival: i >= 4 && i < 8,
        tags: [brand.slug, p.gender.toLowerCase(), p.category.toLowerCase()],
      });
      product.syncStockFlag();
      await product.save();
    }
    products.push(product);
  }
  return products;
}

async function upsertCougarCatalogue(brand, scraped) {
  const sectionCats = { Men: new Set(), Women: new Set(), Kids: new Set() };
  const productsMeta = [];
  for (const p of scraped) {
    const { gender, category } = parseCougarType(p.productType);
    sectionCats[gender].add(category);
    productsMeta.push({ ...p, gender, category });
  }
  const tree = await upsertCategoryTree(brand, sectionCats);

  const products = [];
  for (let i = 0; i < productsMeta.length; i += 1) {
    const p = productsMeta[i];
    const sku = `CGR-${1001 + i}`;
    let product = await Product.findOne({ brandId: brand._id, sku });
    if (!product) {
      const categoryDoc = tree[p.gender].children[p.category];
      const prices = p.variants.map((v) => v.price);
      const basePrice = Math.max(...p.variants.map((v) => v.compareAtPrice || v.price));
      const salePrice = Math.min(...prices) < basePrice ? Math.min(...prices) : null;
      product = new Product({
        brandId: brand._id,
        categoryId: categoryDoc ? categoryDoc._id : null,
        sku,
        name: p.title,
        description: (p.bodyHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || `${p.title} by Cougar.`,
        images: p.images.length ? p.images.slice(0, 3) : [IMG_FALLBACK(`${sku}-1`)],
        basePrice: Math.round(basePrice),
        salePrice: salePrice ? Math.round(salePrice) : null,
        variants: p.variants.map((v, vi) => ({
          size: v.size || 'One Size',
          color: v.color && v.color !== 'FREE' ? v.color : undefined,
          additionalPrice: 0,
          stockQuantity: stockFor(i, vi, v.available),
          sku: v.sku,
        })),
        isFeatured: i < 4,
        isNewArrival: i >= 4 && i < 8,
        tags: [brand.slug, p.gender.toLowerCase(), p.category.toLowerCase()],
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
        phone: brandSpec.contactPhone,
        email: `${slug}@metromatrix.pk`,
        openingHours: 'Mon–Sun: 11:00 AM – 10:00 PM',
        managerName: brandSpec.vendor.fullName,
        images: [IMG_FALLBACK(`${slug}-store`)],
        floorArea: 2400,
      });
      log(`outlet created: ${brandSpec.name} ${spot.name}`);
    }
  }
}

async function upsertCoupons(cougar, outfitters) {
  const now = Date.now();
  const day = 86400000;
  const coupons = [
    // minOrderAmount tuned to real scraped price ranges (Cougar variants
    // top out around PKR 3000, Outfitters around PKR 9000 — a generic 5000
    // minimum, reasonable for the old synthetic catalogue, made the coupon
    // nearly impossible to actually clear with 1-2 real items and broke
    // seeding when a real order tried to apply one).
    { couponCode: 'COUGAR15', brandId: cougar._id, type: 'percentage', value: 15, minOrderAmount: 1500, maxDiscount: 1000, validFrom: new Date(now - 7 * day), validUntil: new Date(now + 90 * day) },
    { couponCode: 'COUGARLEATHER', brandId: cougar._id, type: 'fixed', value: 300, minOrderAmount: 1200, maxDiscount: 0, validFrom: new Date(now - 7 * day), validUntil: new Date(now + 90 * day) },
    { couponCode: 'COUGAREXPIRED', brandId: cougar._id, type: 'percentage', value: 25, minOrderAmount: 0, maxDiscount: 1500, validFrom: new Date(now - 60 * day), validUntil: new Date(now - 30 * day) },
    { couponCode: 'OUTFIT20', brandId: outfitters._id, type: 'percentage', value: 20, minOrderAmount: 1000, maxDiscount: 1500, validFrom: new Date(now - 7 * day), validUntil: new Date(now + 90 * day) },
    { couponCode: 'OUTFITNEW', brandId: outfitters._id, type: 'fixed', value: 500, minOrderAmount: 1500, maxDiscount: 0, validFrom: new Date(now - 7 * day), validUntil: new Date(now + 90 * day) },
    { couponCode: 'OUTFITEXPIRED', brandId: outfitters._id, type: 'percentage', value: 30, minOrderAmount: 0, maxDiscount: 1500, validFrom: new Date(now - 60 * day), validUntil: new Date(now - 30 * day) },
  ].map((c) => ({ ...c, usageLimit: 500, usedCount: 0, isActive: true }));

  for (const c of coupons) {
    await Coupon.updateOne({ couponCode: c.couponCode }, { $setOnInsert: c }, { upsert: true });
  }
  log(`coupons upserted (${coupons.length}, incl. 2 expired)`);
}

const CUSTOMERS = [
  { email: 'shopper1.qa@metromatrix.pk', fullName: 'Hina Aslam', phoneNumber: '03005550011' },
  { email: 'shopper2.qa@metromatrix.pk', fullName: 'Usman Tariq', phoneNumber: '03005550012' },
  { email: 'shopper3.qa@metromatrix.pk', fullName: 'Mahnoor Fatima', phoneNumber: '03005550013' },
];
const CUSTOMER_PASSWORD = 'Shopper@123';

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

const NEXT_STATUSES = {
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
  for (const status of NEXT_STATUSES[targetStatus]) {
    order = await orderService.transition(order, status, { id: vendorProviderId, role: 'vendor' }, {
      trackingNumber: TRACKED_STATUSES.includes(status)
        ? `TCS-${29800000 + Math.floor(Math.random() * 99999)}`
        : undefined,
    });
  }
  return order;
}

/** Shift a just-created order/group cluster into the past by `daysAgo`.
 * Uses the raw driver, not the Mongoose model: Mongoose treats a schema's
 * `timestamps: true` createdAt path as immutable and silently drops it
 * from any $set on Model.updateOne (modifiedCount:1 reported, value
 * unchanged) — confirmed by direct testing against this exact schema. */
async function backdate(groupMongoId, orderMongoIds, daysAgo) {
  const shiftMs = daysAgo * 86400000;
  const db = mongoose.connection.db;
  const orderGroups = db.collection('shoppingordergroups');
  const orders = db.collection('shoppingorders');
  const walletTransactions = db.collection('wallettransactions');

  const group = await OrderGroup.findById(groupMongoId);
  await orderGroups.updateOne({ _id: group._id }, { $set: { createdAt: new Date(group.createdAt.getTime() - shiftMs) } });

  for (const orderId of orderMongoIds) {
    const order = await Order.findById(orderId);
    const newHistory = order.statusHistory.map((h) => ({
      ...h.toObject(),
      changedAt: new Date(h.changedAt.getTime() - shiftMs),
    }));
    const set = { createdAt: new Date(order.createdAt.getTime() - shiftMs), statusHistory: newHistory };
    if (order.deliveredAt) set.deliveredAt = new Date(order.deliveredAt.getTime() - shiftMs);
    await orders.updateOne({ _id: order._id }, { $set: set });
  }

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

const REVIEW_COMMENTS = [
  { rating: 5, title: 'Loved it', comment: 'Exactly as pictured, great fit and quick delivery.' },
  { rating: 4, title: 'Good quality', comment: 'Nice material, runs slightly large — order one size down.' },
  { rating: 3, title: 'Decent', comment: 'Fine for the price but the color was a bit different from the photos.' },
  { rating: 5, title: 'Will buy again', comment: 'Second time ordering from this brand, consistently good.' },
  { rating: 2, title: 'Not what I expected', comment: 'Stitching came loose after a couple of washes.' },
  { rating: 4, title: 'Solid pick', comment: 'Comfortable and true to size.' },
];

async function seedProductReviews(customers, productsBySlug) {
  let created = 0;
  for (const slug of Object.keys(productsBySlug)) {
    for (const product of productsBySlug[slug]) {
      const existingCount = await ProductReview.countDocuments({ productId: product._id });
      if (existingCount > 0) continue; // idempotent — only seed once per product
      const numReviews = 3 + (product.name.length % 4); // 3-6
      for (let i = 0; i < numReviews; i += 1) {
        const customer = customers[i % customers.length];
        const template = REVIEW_COMMENTS[(product.name.length + i) % REVIEW_COMMENTS.length];
        // Reviews need a real delivered order to satisfy the unique
        // (productId,userId,order) index and the "verified purchase"
        // model — reuse any existing order for that brand+customer if one
        // exists, else skip (this runs after order seeding).
        const anyOrder = await Order.findOne({ brandId: product.brandId, userId: customer._id, orderStatus: 'delivered' });
        if (!anyOrder) continue;
        const already = await ProductReview.findOne({ productId: product._id, userId: customer._id, order: anyOrder._id });
        if (already) continue;
        await ProductReview.create({
          productId: product._id,
          brandId: product.brandId,
          userId: customer._id,
          order: anyOrder._id,
          rating: template.rating,
          title: template.title,
          comment: template.comment,
          isVerifiedPurchase: true,
        });
        created += 1;
      }
      const [agg] = await ProductReview.aggregate([
        { $match: { productId: product._id } },
        { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
      ]);
      if (agg) {
        await Product.updateOne(
          { _id: product._id },
          { $set: { rating: Math.round(agg.avg * 10) / 10, totalReviews: agg.count } }
        );
      }
    }
  }
  log(`product reviews created: ${created} (realistic 2-5 star spread, not all 5-star)`);
}

async function seedCrossBrandOrders(customers, brands, productsBySlug) {
  const existing = await OrderGroup.countDocuments({ userId: { $in: customers.map((c) => c._id) } });
  if (existing > 0) {
    log(`orders already seeded for QA customers (${existing} groups) — skipping (idempotent)`);
    return { groups: existing, orders: null, skipped: true };
  }

  let createdGroups = 0;
  let createdOrders = 0;

  for (let i = 0; i < ORDER_PLAN.length; i += 1) {
    const plan = ORDER_PLAN[i];
    const customer = customers[i % customers.length];

    // A cart survives across seed runs. If an earlier run failed partway
    // (checkout throws before the cart is cleared), the next run's
    // addToCart calls would append to leftover items that still reference
    // now-purged product/variant ids — checkout then fails validating
    // those stale lines. Start every order from a guaranteed-empty cart.
    const staleCart = await cartService.getOrCreateCart(customer._id);
    staleCart.items = [];
    staleCart.appliedCoupon = null;
    await staleCart.save();

    for (let b = 0; b < plan.brands.length; b += 1) {
      const brandSlug = plan.brands[b];
      const products = productsBySlug[brandSlug];
      const { product: p1, variant: v1 } = pickLine(products, i + b);
      const { product: p2, variant: v2 } = pickLine(products, i + b + 5);
      // Orders carrying a coupon need enough margin above minOrderAmount
      // regardless of which specific (cheap or pricey) real product got
      // picked at this index — real scraped prices vary far more than the
      // old synthetic catalogue's, so a flat qty:1 risked landing under
      // the threshold and failing checkout entirely.
      const qty1 = plan.coupon ? 2 : 1;
      await addToCart(customer, p1, v1, qty1);
      if (p2._id.toString() !== p1._id.toString() || v2._id.toString() !== v1._id.toString()) {
        await addToCart(customer, p2, v2, 1);
      }
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

    await backdate(
      result.groupId,
      orderDocs.map((o) => o._id),
      ORDER_PLAN.length - i
    );

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
    }

    createdGroups += 1;
  }

  return { groups: createdGroups, orders: createdOrders, skipped: false };
}

/* ── Entry point ─────────────────────────────────────────────────── */

function loadScrapedCatalog(brandSlug) {
  const p = path.join(SCRAPED_DIR, `${brandSlug}-catalog.json`);
  if (!fs.existsSync(p)) {
    throw new Error(
      `Missing ${p} — run "python3 scripts/scrape-brands.py" first (see scripts/scrape-brands.py).`
    );
  }
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`${p} is empty — the scraper failed to fetch ${brandSlug}'s catalogue. Re-run the scraper.`);
  }
  return data;
}

async function seedBrands() {
  log('=== Cougar + Outfitters brand seed (REAL scraped data) ===');

  await purgeAllShoppingData();

  const cougarScraped = loadScrapedCatalog('cougar');
  const outfittersScraped = loadScrapedCatalog('outfitters');

  const cougarVendor = await upsertVendor(COUGAR.vendor);
  const cougarBrand = await upsertBrand(COUGAR, cougarVendor, ['Men', 'Women', 'Kids']);
  const cougarProducts = await upsertCougarCatalogue(cougarBrand, cougarScraped);
  await upsertOutlets(cougarBrand, COUGAR);

  const outfittersVendor = await upsertVendor(OUTFITTERS.vendor);
  const outfittersBrand = await upsertBrand(OUTFITTERS, outfittersVendor, ['Men', 'Women']);
  const outfittersProducts = await upsertOutfittersCatalogue(outfittersBrand, outfittersScraped);
  await upsertOutlets(outfittersBrand, OUTFITTERS);

  log(`catalogue ready — Cougar: ${cougarProducts.length} products (real), Outfitters: ${outfittersProducts.length} products (real)`);

  const finalBrandCount = await Brand.countDocuments();
  if (finalBrandCount !== 2) {
    throw new Error(`ASSERTION FAILED: expected exactly 2 brands after purge+seed, found ${finalBrandCount}`);
  }
  log(`✓ verified exactly 2 brands in the database`);

  await upsertCoupons(cougarBrand, outfittersBrand);
  const customers = await upsertCustomers();

  const brands = { cougar: cougarBrand, outfitters: outfittersBrand };
  const productsBySlug = { cougar: cougarProducts, outfitters: outfittersProducts };
  const orderResult = await seedCrossBrandOrders(customers, brands, productsBySlug);
  await seedProductReviews(customers, productsBySlug);

  const summary = {
    brandCount: finalBrandCount,
    brands: { cougar: cougarBrand.name, outfitters: outfittersBrand.name },
    products: { cougar: cougarProducts.length, outfitters: outfittersProducts.length, dataSource: 'real (scraped)' },
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
