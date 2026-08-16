#!/usr/bin/env node
/**
 * Repairs product variants whose size and colour were stored the wrong way
 * round, and backfills missing colour swatches.
 *
 * WHY
 * ---
 * `scrape-brands.py` read Outfitters' Shopify options positionally
 * (option1 -> size, option2 -> colour). That store declares its options as
 * [Color, Size, Season], so all 30 Outfitters products were seeded with the
 * colour in `size` and the size in `color` — the app faithfully rendered
 * "Size: Black" / "Color: L". The scraper and the catalog JSON are fixed; this
 * repairs databases that were already seeded from the bad data.
 *
 * WHY NOT RE-SEED
 * ---------------
 * `npm run seed:shopping` calls purgeAllShoppingData(), which deleteMany({})s
 * Orders, Products, Categories, Reviews and Coupons and deletes any
 * vendor-created Brand — orphaning that vendor permanently. This script
 * touches nothing but the two variant fields.
 *
 * !! CRITICAL !!
 * Fields are assigned IN PLACE on the existing subdocuments. Never rebuild
 * `product.variants = [...]` — that mints fresh _ids and orphans every live
 * Cart.items.variantId and Order.items.variantId.
 *
 * Idempotent: run it twice; the second run reports zero changes.
 *
 *   node scripts/fix-variant-size-color.js --dry
 *   node scripts/fix-variant-size-color.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../src/modules/shopping/models/Product');
const {
  normaliseVariant,
  colorHexFor,
} = require('../src/modules/shopping/utils/variants');

const DRY = process.argv.includes('--dry');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log(`connected${DRY ? '  [DRY RUN — nothing will be written]' : ''}\n`);

  const products = await Product.find({});
  let scanned = 0;
  let productsTouched = 0;
  let variantsRewritten = 0;
  let colorCodesFilled = 0;

  for (const product of products) {
    scanned += 1;
    let dirty = false;

    for (const v of product.variants || []) {
      const before = { size: v.size, color: v.color };
      const after = normaliseVariant({ size: v.size, color: v.color });

      const sizeChanged = before.size !== after.size;
      const colorChanged = (before.color || undefined) !== after.color;

      if (sizeChanged || colorChanged) {
        // In place — preserves v._id, which carts and orders reference.
        v.size = after.size;
        v.color = after.color;
        variantsRewritten += 1;
        dirty = true;
        console.log(
          `  ${product.name}: size "${before.size ?? ''}" -> "${after.size}", ` +
            `color "${before.color ?? ''}" -> "${after.color ?? ''}"`
        );
      }

      if (!v.colorCode) {
        const hex = colorHexFor(v.color);
        if (hex) {
          v.colorCode = hex;
          colorCodesFilled += 1;
          dirty = true;
        }
      }
    }

    if (dirty) {
      productsTouched += 1;
      if (!DRY) await product.save();
    }
  }

  console.log(
    `\nproducts scanned=${scanned} touched=${productsTouched} ` +
      `variantsRewritten=${variantsRewritten} colorCodesFilled=${colorCodesFilled}`
  );
  if (DRY) console.log('[dry run] nothing was written.');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('FAILED:', err.message);
  try {
    await mongoose.disconnect();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
