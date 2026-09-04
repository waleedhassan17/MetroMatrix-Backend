/**
 * The category catalogue and the category->subtype mapping must agree.
 *
 * They did not: the seed created an 'appliance-technicians' category that was
 * absent from CATEGORY_TO_SUBTYPE. `searchProviders` met a slug it could not
 * map, called next(), and the request landed on the legacy /api/providers
 * listing — which applies no subtype filter at all. So tapping that category
 * returned EVERY provider in the system, and QA reported "electricians show up
 * under every category".
 *
 * These tests pin the two halves of that fix: an unmapped category is never
 * offered, and if one is somehow requested it returns nothing rather than
 * everything.
 */
const {
  CATEGORY_TO_SUBTYPE,
  SUBTYPE_TO_CATEGORY,
} = require('../services/serializers');

describe('category <-> subtype mapping', () => {
  it('covers exactly the three trades the app ships', () => {
    expect(Object.keys(CATEGORY_TO_SUBTYPE).sort()).toEqual([
      'ac-repairers',
      'electricians',
      'plumbers',
    ]);
  });

  it('round-trips: every category maps to a subtype that maps back to it', () => {
    for (const [slug, subType] of Object.entries(CATEGORY_TO_SUBTYPE)) {
      expect(SUBTYPE_TO_CATEGORY[subType]).toBe(slug);
    }
  });

  it('maps no two categories onto the same provider pool', () => {
    const subTypes = Object.values(CATEGORY_TO_SUBTYPE);
    expect(new Set(subTypes).size).toBe(subTypes.length);
  });
});

describe('seed catalogue', () => {
  // The seed is the source of what exists in the database, so it is the thing
  // that has to agree with the mapping — checking the mapping against itself
  // would not have caught the original bug.
  const seed = require('fs').readFileSync(
    require('path').join(__dirname, '../../../../scripts/seed-homeservice.js'),
    'utf8'
  );

  it('seeds a slug for every mapped category and no others', () => {
    const block = seed.slice(seed.indexOf('const CATEGORIES = ['));
    const slugs = Object.keys(CATEGORY_TO_SUBTYPE);

    for (const slug of slugs) {
      expect(block).toContain(`'${slug}'`);
    }
    // The row that caused the bug must not come back.
    expect(block).not.toContain("'appliance-technicians'");
  });

  it('gives every seeded category a real image', () => {
    const block = seed.slice(
      seed.indexOf('const CATEGORIES = ['),
      seed.indexOf('const LAHORE')
    );
    const images = block.match(/https:\/\/\S+/g) || [];
    expect(images.length).toBe(Object.keys(CATEGORY_TO_SUBTYPE).length);
  });
});

describe('searchProviders category guard', () => {
  const searchController = require('../controllers/providerSearchController');

  const makeRes = () => {
    const res = { body: null, statusCode: 200 };
    res.json = jest.fn((b) => {
      res.body = b;
      return res;
    });
    res.status = jest.fn((c) => {
      res.statusCode = c;
      return res;
    });
    return res;
  };

  it('falls through to the legacy listing when NO category is named', async () => {
    const req = { query: {} };
    const res = makeRes();
    const next = jest.fn();

    await searchController.searchProviders(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns an empty page — never everyone — for an unknown category', async () => {
    const req = { query: { category: 'appliance-technicians' } };
    const res = makeRes();
    const next = jest.fn();

    await searchController.searchProviders(req, res, next);

    // The whole point: it must NOT reach the unfiltered legacy handler.
    expect(next).not.toHaveBeenCalled();
    expect(res.body.success).toBe(true);
    expect(res.body.data.providers).toEqual([]);
    expect(res.body.data.pagination.totalItems).toBe(0);
    expect(res.body.message).toMatch(/appliance-technicians/);
  });
});
