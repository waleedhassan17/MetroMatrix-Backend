/**
 * Home Services data validation — read-only unless you pass --fix.
 *
 * QA reported that every category showed electricians. The cause turned out to
 * be a routing bug (an unmapped category slug fell through to the unfiltered
 * legacy provider listing), not bad provider data — but "the data is fine" is a
 * claim worth being able to check rather than assert, and a mistagged provider
 * would produce the identical symptom.
 *
 * Checks:
 *   1. Every home_service provider has a providerSubType in the enum.
 *   2. Every active ServiceCategory slug is a key of CATEGORY_TO_SUBTYPE.
 *   3. Every category's providerSubType matches what the mapping says.
 *   4. Each subtype actually has providers, so a category is not silently empty.
 *
 * Run:  node scripts/validate-homeservice.js
 *       node scripts/validate-homeservice.js --fix   (deactivates unmapped
 *                                                     categories; never edits
 *                                                     providers — a mistagged
 *                                                     provider needs a human)
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Provider = require('../src/models/Provider');
const ServiceCategory = require('../src/modules/homeservice/models/ServiceCategory');
const { CATEGORY_TO_SUBTYPE } = require('../src/modules/homeservice/services/serializers');

const FIX = process.argv.includes('--fix');
const SLUGS = Object.keys(CATEGORY_TO_SUBTYPE);
const SUBTYPES = Object.values(CATEGORY_TO_SUBTYPE);

const problems = [];
const note = (m) => console.log(`  ${m}`);
const fail = (m) => {
  problems.push(m);
  console.log(`  ✗ ${m}`);
};

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected\n=== Home Services validation ===');
  console.log(`  catalogue: ${SLUGS.join(', ')}\n`);

  // 1. Provider tagging
  const untagged = await Provider.find({
    providerType: 'home_service',
    $or: [
      { providerSubType: { $exists: false } },
      { providerSubType: null },
      { providerSubType: '' },
      { providerSubType: { $nin: SUBTYPES } },
    ],
  }).select('fullName email providerSubType');

  if (untagged.length === 0) {
    note(`✓ all home_service providers carry a valid providerSubType`);
  } else {
    fail(`${untagged.length} home_service provider(s) with a missing or unknown providerSubType:`);
    untagged.forEach((p) =>
      note(`    ${p.email || p._id} — ${p.fullName} — subType=${JSON.stringify(p.providerSubType)}`)
    );
  }

  // 2 & 3. Catalogue integrity
  const cats = await ServiceCategory.find({ isActive: true }).sort({ sortOrder: 1 });
  for (const c of cats) {
    if (!SLUGS.includes(c.slug)) {
      fail(
        `category "${c.slug}" is active but absent from CATEGORY_TO_SUBTYPE — ` +
          `provider search cannot filter it`
      );
      if (FIX) {
        c.isActive = false;
        await c.save();
        note(`    → deactivated`);
      }
    } else if (c.providerSubType !== CATEGORY_TO_SUBTYPE[c.slug]) {
      fail(
        `category "${c.slug}" stores providerSubType="${c.providerSubType}" but the ` +
          `mapping says "${CATEGORY_TO_SUBTYPE[c.slug]}" — the card and the search disagree`
      );
    }
  }
  const activeSlugs = cats.filter((c) => SLUGS.includes(c.slug)).map((c) => c.slug);
  const missing = SLUGS.filter((s) => !activeSlugs.includes(s));
  if (missing.length) fail(`catalogue is missing active categor(ies): ${missing.join(', ')}`);
  if (!problems.length) note(`✓ catalogue matches the mapping (${activeSlugs.length} categories)`);

  // 4. Population — a category with no providers is not corrupt, but it is the
  //    thing a tester reads as "filtering is broken", so say so plainly.
  console.log('\n  providers per category:');
  for (const slug of SLUGS) {
    const subType = CATEGORY_TO_SUBTYPE[slug];
    const total = await Provider.countDocuments({
      providerType: 'home_service',
      providerSubType: subType,
    });
    const active = await Provider.countDocuments({
      providerType: 'home_service',
      providerSubType: subType,
      adminVerified: 'active',
      isActive: true,
    });
    const flag = active === 0 ? '  ← nothing will show for this category' : '';
    note(`    ${slug.padEnd(18)} ${subType.padEnd(14)} ${String(active).padStart(3)} active / ${total} total${flag}`);
  }

  console.log(
    problems.length
      ? `\n✗ ${problems.length} problem(s) found${FIX ? '' : ' — re-run with --fix to deactivate unmapped categories'}`
      : '\n✓ no problems found'
  );

  await mongoose.disconnect();
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
