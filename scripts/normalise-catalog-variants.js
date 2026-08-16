#!/usr/bin/env node
/**
 * Corrects size/colour on the committed scraped catalogs.
 *
 * The Outfitters scrape stored the colour in `size` and the size in `color`
 * (Shopify options were read positionally; that store declares them as
 * [Color, Size, Season]). `scrape-brands.py` is fixed at source, but the raw
 * scrape cache is gitignored — so the committed catalog JSON is the durable
 * artifact and this script is the offline, network-free way to correct it.
 *
 * Idempotent: run it twice and the second run reports zero changes.
 *
 *   node scripts/normalise-catalog-variants.js --dry
 *   node scripts/normalise-catalog-variants.js
 */
const fs = require('fs');
const path = require('path');
const { normaliseVariant, colorHexFor } = require('../src/modules/shopping/utils/variants');

const DRY = process.argv.includes('--dry');
const DIR = path.join(__dirname, 'scraped');
const FILES = ['outfitters-catalog.json', 'cougar-catalog.json'];

let totalChanged = 0;

for (const file of FILES) {
  const full = path.join(DIR, file);
  if (!fs.existsSync(full)) {
    console.log(`skip  ${file} (not present)`);
    continue;
  }

  const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
  const products = Array.isArray(raw) ? raw : raw.products || [];

  let changed = 0;
  for (const product of products) {
    for (const v of product.variants || []) {
      const before = { size: v.size, color: v.color };
      const after = normaliseVariant(v);

      if (before.size !== after.size || (before.color || undefined) !== after.color) {
        console.log(
          `  ${product.name || product.title}: ` +
            `size "${before.size ?? ''}" -> "${after.size}", ` +
            `color "${before.color ?? ''}" -> "${after.color ?? ''}"`
        );
        changed += 1;
      }

      v.size = after.size;
      if (after.color) v.color = after.color;
      else delete v.color;

      const hex = colorHexFor(v.color);
      if (hex && !v.colorCode) v.colorCode = hex;
    }
  }

  console.log(`${file}: ${changed} variant(s) corrected`);
  totalChanged += changed;

  if (!DRY && changed > 0) {
    // Match the Python writer's formatting so the diff stays readable.
    fs.writeFileSync(full, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  }
}

console.log(
  DRY
    ? `\n[dry run] ${totalChanged} variant(s) would change. Nothing written.`
    : `\nDone. ${totalChanged} variant(s) corrected.`
);
