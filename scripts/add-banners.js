/**
 * Seed the storefront promo banners — `npm run seed:banners`.
 *
 * ADDITIVE BY DESIGN. Unlike scripts/seed-shopping.js (which purges nine
 * collections before it writes), this script only ever inserts or updates
 * ShoppingBanner rows. It is safe to run against the live database, which is
 * the point: the banners it replaces were a hardcoded fixture in the app.
 *
 * Content comes from the brands themselves rather than stock photography —
 * the title is the brand name, the subtitle is the brand's own tagline, and
 * the artwork is the brand's banner image, falling back to a real product
 * photo from its catalogue. Add editorial banners through the admin screen
 * (POST /api/shopping/admin/banners); this only guarantees a sensible,
 * non-empty starting state and can be re-run at any time.
 *
 * Idempotent: one banner per active brand, matched on brandId.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Brand = require('../src/modules/shopping/models/Brand');
const Product = require('../src/modules/shopping/models/Product');
const ShoppingBanner = require('../src/modules/shopping/models/ShoppingBanner');

/**
 * Hosts that serve random stand-in imagery. A brand whose banner still points
 * at one of these has no real artwork yet, so a genuine product photo from its
 * own catalogue is the better choice — the whole point of this work was to stop
 * shipping placeholder pictures.
 */
const PLACEHOLDER_HOSTS = ['picsum.photos', 'placehold.co', 'via.placeholder.com', 'unsplash.com'];
const isPlaceholder = (url) => PLACEHOLDER_HOSTS.some((h) => String(url).includes(h));

/** A real photo from the brand's own catalogue, preferring a featured product. */
const artworkFor = async (brand) => {
  if (brand.bannerImage && !isPlaceholder(brand.bannerImage)) return brand.bannerImage;

  const candidates = await Product.find({
    brandId: brand._id,
    isActive: true,
    images: { $exists: true, $ne: [] },
  })
    .sort({ isFeatured: -1, totalReviews: -1 })
    .limit(1)
    .select('images');

  if (candidates.length && candidates[0].images.length) return candidates[0].images[0];
  // Last resort: whatever the brand has, placeholder or not, beats no banner.
  return brand.bannerImage || brand.logo || null;
};

const seedBanners = async () => {
  const brands = await Brand.find({ status: 'active', isDeleted: false }).sort({ createdAt: 1 });
  if (brands.length === 0) {
    console.log('  No active brands — nothing to do.');
    return { created: 0, updated: 0, skipped: 0 };
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < brands.length; i += 1) {
    const brand = brands[i];
    const image = await artworkFor(brand);
    if (!image) {
      console.log(`  ⚠ ${brand.name}: no usable artwork (no banner, logo or product image) — skipped`);
      skipped += 1;
      continue;
    }

    const fields = {
      title: brand.name,
      subtitle: brand.tagline || brand.description.slice(0, 80),
      image,
      brandId: brand._id,
      productId: null,
      sortOrder: i,
      isActive: true,
      validFrom: null,
      validUntil: null,
    };

    const existing = await ShoppingBanner.findOne({ brandId: brand._id });
    if (existing) {
      Object.assign(existing, fields);
      await existing.save();
      updated += 1;
      console.log(`  ↻ updated banner for ${brand.name}`);
    } else {
      await ShoppingBanner.create(fields);
      created += 1;
      console.log(`  ✓ created banner for ${brand.name}`);
    }
  }

  return { created, updated, skipped };
};

const main = async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set — refusing to run.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected');
  const summary = await seedBanners();
  const total = await ShoppingBanner.countDocuments();
  console.log(`=== banners done === ${JSON.stringify(summary)} · ${total} banner(s) in total`);
  await mongoose.disconnect();
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Banner seed failed:', err);
    process.exit(1);
  });
}

module.exports = seedBanners;
