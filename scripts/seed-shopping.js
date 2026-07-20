/**
 * Shopping module seed — entry point for `npm run seed:shopping`.
 *
 * Delegates entirely to src/modules/shopping/seed/brands.seed.js, which is
 * now the single source of truth for the Shopping module's seed data
 * (shop.md Prompt 1: "Replace all Shopping seed data with exactly TWO
 * brands — COUGAR and OUTFITTERS — populated with real catalogue data").
 *
 * The older synthetic 4-brand seed (Outfitters/Khaadi/Servis Steps/
 * TechMart with generated placeholder products) that used to live in this
 * file has been removed — brands.seed.js's purge step would delete all of
 * it on every run anyway, so keeping it here was pure wasted work.
 *
 * Requires scripts/scraped/{cougar,outfitters}-catalog.json to exist —
 * run `python3 scripts/scrape-brands.py` first if they're missing.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const seedBrands = require('../src/modules/shopping/seed/brands.seed');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected');
  await seedBrands();
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
