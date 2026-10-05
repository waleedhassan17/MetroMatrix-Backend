/**
 * Natural-language product search: "red nike running shoes for men under 5k"
 * → { brand: Nike, category: shoes, color: red, gender: men, maxPrice: 5000,
 *     terms: "running" }.
 *
 * Rules first — deterministic, instant, free, and they work without any API
 * key: prices ("under 3k", "1,500-4,000", "upto rs 2000"), colours and
 * gender (with common Roman-Urdu words: laal, kala, mard, larkiyon…), and the
 * catalogue's own brand and category names with synonyms. The LLM (Gemini) is
 * a second opinion only for longer free text the rules could not structure,
 * its output validated field by field. Parsed queries are cached for a day.
 */
const crypto = require('crypto');
const { getOrSet } = require('../../../lib/cache');
const { k } = require('../../../lib/redis');
const { generateJson } = require('../../../lib/gemini');

const COLORS = {
  red: 'red', laal: 'red', lal: 'red', maroon: 'maroon', blue: 'blue', neela: 'blue', navy: 'navy',
  green: 'green', hara: 'green', black: 'black', kala: 'black', kaala: 'black', white: 'white', safaid: 'white',
  safed: 'white', pink: 'pink', yellow: 'yellow', peela: 'yellow', grey: 'grey', gray: 'grey', brown: 'brown',
  beige: 'beige', purple: 'purple', orange: 'orange', golden: 'gold', gold: 'gold', silver: 'silver', cream: 'cream',
};
const GENDER = {
  men: 'men', man: 'men', mens: 'men', male: 'men', boys: 'men', boy: 'men', gents: 'men', mard: 'men', larkon: 'men',
  women: 'women', woman: 'women', womens: 'women', female: 'women', ladies: 'women', girls: 'women', girl: 'women',
  aurat: 'women', larkiyon: 'women', kids: 'kids', kid: 'kids', children: 'kids', child: 'kids', bachay: 'kids', bachon: 'kids',
};
// Customer words → catalogue category words.
const CATEGORY_SYNONYMS = {
  shoes: ['shoe', 'shoes', 'sneaker', 'sneakers', 'joggers', 'trainers', 'joote', 'jootay', 'footwear'],
  shirt: ['shirt', 'shirts', 'tee', 'tees', 't-shirt', 'tshirt', 'kameez', 'kurta', 'kurti'],
  trousers: ['trouser', 'trousers', 'pant', 'pants', 'jeans', 'shalwar', 'chinos'],
  dress: ['dress', 'dresses', 'frock', 'frocks', 'gown', 'maxi'],
  bag: ['bag', 'bags', 'handbag', 'purse', 'backpack'],
  watch: ['watch', 'watches', 'ghari'],
  jacket: ['jacket', 'jackets', 'coat', 'hoodie', 'sweater', 'sweatshirt'],
};
const STOP = new Set(['for', 'with', 'the', 'a', 'an', 'in', 'of', 'and', 'or', 'to', 'me', 'show', 'find', 'i', 'want', 'need', 'some', 'ke', 'liye', 'wala', 'wali', 'rs', 'pkr', 'price', 'cheap', 'best', 'new', 'buy']);

function money(raw, kSuffix) {
  const n = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(kSuffix ? n * 1000 : n);
}

/** Pure rules parser. `catalog` = { brands: [{id,name}], categories: [{id,name}] }. */
function parseRules(input, catalog = { brands: [], categories: [] }) {
  let q = ` ${String(input || '').toLowerCase().replace(/[^\p{L}\p{N}\s,.\-₨]/gu, ' ')} `;
  const out = {};
  const consume = (re) => {
    q = q.replace(re, ' ');
  };

  // Price range first ("1500-4000", "2k to 5k"), then bounds.
  const range = q.match(/(?:rs\.?|pkr|₨)?\s*([\d,]+(?:\.\d+)?)\s*(k)?\s*(?:-|to|se)\s*(?:rs\.?|pkr|₨)?\s*([\d,]+(?:\.\d+)?)\s*(k)?\b/);
  if (range) {
    const lo = money(range[1], range[2] || range[4]);
    const hi = money(range[3], range[4]);
    if (lo !== null && hi !== null && hi >= lo) {
      out.minPrice = lo;
      out.maxPrice = hi;
      consume(range[0]);
    }
  }
  const max = q.match(/\b(?:under|below|less than|upto|up to|within|max|tak|se kam)\s*(?:rs\.?|pkr|₨)?\s*([\d,]+(?:\.\d+)?)\s*(k)?\b/);
  if (max && out.maxPrice === undefined) {
    out.maxPrice = money(max[1], max[2]);
    consume(max[0]);
  }
  const min = q.match(/\b(?:over|above|more than|from|min|at least|se zyada)\s*(?:rs\.?|pkr|₨)?\s*([\d,]+(?:\.\d+)?)\s*(k)?\b/);
  if (min && out.minPrice === undefined) {
    out.minPrice = money(min[1], min[2]);
    consume(min[0]);
  }

  const tokens = q.split(/\s+/).filter(Boolean);
  const keep = [];
  for (const t of tokens) {
    if (!out.color && COLORS[t]) out.color = COLORS[t];
    else if (!out.gender && GENDER[t]) out.gender = GENDER[t];
    else keep.push(t);
  }
  let rest = ` ${keep.join(' ')} `;

  // Brands: longest catalogue name first, whole words.
  const brands = [...(catalog.brands || [])].sort((a, b) => b.name.length - a.name.length);
  for (const b of brands) {
    const name = b.name.toLowerCase().trim();
    if (name.length < 2) continue;
    const re = new RegExp(`\\s${escape(name)}\\s`);
    if (re.test(rest)) {
      out.brandId = b.id;
      out.brandName = b.name;
      rest = rest.replace(re, ' ');
      break;
    }
  }

  // Categories: synonym → canonical word → catalogue categories containing it.
  const words = rest.split(/\s+/).filter(Boolean);
  for (const [canon, syns] of Object.entries(CATEGORY_SYNONYMS)) {
    const hit = words.find((w) => syns.includes(w));
    if (!hit) continue;
    const matches = (catalog.categories || []).filter((c) => {
      const n = c.name.toLowerCase();
      return n.includes(canon) || syns.some((s) => n.includes(s));
    });
    // No catalogue category covers the word: leave it in the text terms so the
    // search still looks for it. Dropping it here turned "watch" into a search
    // with no condition at all — every product in the store.
    if (!matches.length) break;
    out.category = canon;
    out.categoryIds = matches.map((c) => c.id);
    rest = rest.replace(new RegExp(`\\s${escape(hit)}\\s`), ' ');
    break;
  }

  const terms = rest.split(/\s+/).filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w));
  out.terms = terms.join(' ');
  return out;
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function structuredCount(p) {
  return ['maxPrice', 'minPrice', 'color', 'gender', 'brandId', 'category'].filter((f) => p[f] !== undefined).length;
}

/** Validate an LLM answer field by field; anything odd is dropped, never trusted. */
function cleanLlm(raw, catalog) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) < 10000000 ? Math.round(Number(v)) : undefined);
  out.maxPrice = num(raw.maxPrice);
  out.minPrice = num(raw.minPrice);
  if (typeof raw.color === 'string' && COLORS[raw.color.toLowerCase()]) out.color = COLORS[raw.color.toLowerCase()];
  if (typeof raw.gender === 'string' && GENDER[raw.gender.toLowerCase()]) out.gender = GENDER[raw.gender.toLowerCase()];
  if (typeof raw.brand === 'string') {
    const b = (catalog.brands || []).find((x) => x.name.toLowerCase() === raw.brand.toLowerCase().trim());
    if (b) {
      out.brandId = b.id;
      out.brandName = b.name;
    }
  }
  if (typeof raw.category === 'string' && CATEGORY_SYNONYMS[raw.category.toLowerCase()]) out.category = raw.category.toLowerCase();
  if (typeof raw.terms === 'string') out.terms = raw.terms.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().slice(0, 60);
  Object.keys(out).forEach((key) => out[key] === undefined && delete out[key]);
  return out;
}

async function loadCatalog() {
  return getOrSet(k('c', 'shop', 'nlqcatalog'), 600, async () => {
    const Brand = require('../../shopping/models/Brand');
    const Category = require('../../shopping/models/Category');
    const [brands, categories] = await Promise.all([
      Brand.find({ status: 'active', isDeleted: false }).select('name').lean(),
      Category.find({}).select('name').lean(),
    ]);
    return {
      brands: brands.map((b) => ({ id: String(b._id), name: b.name })),
      categories: categories.map((c) => ({ id: String(c._id), name: c.name })),
    };
  });
}

/**
 * @returns {Promise<{interpreted: object, source: 'rules'|'llm'}>}
 */
async function understand(query, { catalog } = {}) {
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return { interpreted: { terms: '' }, source: 'rules' };
  const cat = catalog || (await loadCatalog());
  const key = k('nlq', 'v1', crypto.createHash('sha1').update(q.toLowerCase()).digest('hex'));
  return getOrSet(key, 24 * 60 * 60, async () => {
    const rules = parseRules(q, cat);
    const wordCount = q.split(/\s+/).length;
    if (structuredCount(rules) > 0 || wordCount < 4) return { interpreted: rules, source: 'rules' };
    const llm = cleanLlm(
      await generateJson(
        `Extract shopping search filters from this query. Answer JSON only with optional keys: ` +
          `terms (string, the product words), color (string), gender ("men"|"women"|"kids"), ` +
          `maxPrice (number, PKR), minPrice (number, PKR), brand (string), category (one of: ${Object.keys(CATEGORY_SYNONYMS).join(', ')}). ` +
          `Query: ${JSON.stringify(q)}`
      ),
      cat
    );
    if (llm && structuredCount(llm) > 0) {
      if (llm.category) {
        const syns = CATEGORY_SYNONYMS[llm.category];
        const ids = (cat.categories || []).filter((c) => syns.some((s) => c.name.toLowerCase().includes(s))).map((c) => c.id);
        if (ids.length) llm.categoryIds = ids;
      }
      return { interpreted: { terms: rules.terms, ...llm }, source: 'llm' };
    }
    return { interpreted: rules, source: 'rules' };
  });
}

module.exports = { understand, parseRules, cleanLlm, COLORS, GENDER, CATEGORY_SYNONYMS };
