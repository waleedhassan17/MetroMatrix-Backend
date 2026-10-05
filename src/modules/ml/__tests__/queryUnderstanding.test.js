const { parseRules, cleanLlm } = require('../services/queryUnderstanding');

const catalog = {
  brands: [
    { id: 'b-nike', name: 'Nike' },
    { id: 'b-gul', name: 'Gul Ahmed' },
    { id: 'b-js', name: 'J.' },
  ],
  categories: [
    { id: 'c-sneakers', name: 'Sneakers' },
    { id: 'c-shoes', name: 'Running Shoes' },
    { id: 'c-kurta', name: 'Kurta' },
  ],
};

describe('natural-language query rules', () => {
  it.each([
    ['red nike running shoes for men under 5000', { color: 'red', gender: 'men', maxPrice: 5000, brandId: 'b-nike', category: 'shoes', terms: 'running' }],
    ['sneakers under 3k', { maxPrice: 3000, category: 'shoes' }],
    ['kurta 1,500 - 4,000', { minPrice: 1500, maxPrice: 4000, category: 'shirt' }],
    ['gul ahmed laal kurta larkiyon ke liye', { brandId: 'b-gul', color: 'red', gender: 'women', category: 'shirt' }],
    // no catalogue category covers these words: they stay searchable text
    ['black watch above rs 2000', { color: 'black', minPrice: 2000, terms: 'watch' }],
    ['bags upto 1500', { maxPrice: 1500, terms: 'bags' }],
  ])('%p', (q, expected) => {
    expect(parseRules(q, catalog)).toMatchObject(expected);
  });

  it('maps a category word onto the catalogue categories it covers', () => {
    expect(parseRules('nike sneakers', catalog).categoryIds).toEqual(['c-sneakers', 'c-shoes']);
  });

  it('never turns an unknown category word into a query with no condition', () => {
    const r = parseRules('watch', catalog);
    expect(r.category).toBeUndefined();
    expect(r.categoryIds).toBeUndefined();
    expect(r.terms).toBe('watch');
  });

  it('keeps the product words as text terms and drops filler', () => {
    expect(parseRules('show me some cotton lawn suit', catalog).terms).toBe('cotton lawn suit');
  });

  it('does not invent filters from nothing', () => {
    const p = parseRules('linen', catalog);
    expect(p).toEqual({ terms: 'linen' });
  });

  it('treats regex characters in input as text', () => {
    expect(() => parseRules('(((shoes', catalog)).not.toThrow();
  });
});

describe('LLM answers are validated, never trusted', () => {
  it('keeps known fields, maps brand names to ids, drops junk', () => {
    expect(
      cleanLlm({ terms: 'Running!!', color: 'Blue', gender: 'kids', maxPrice: '4500', brand: 'nike', category: 'shoes', hack: '$where' }, catalog)
    ).toEqual({ terms: 'running', color: 'blue', gender: 'kids', maxPrice: 4500, brandId: 'b-nike', brandName: 'Nike', category: 'shoes' });
  });

  it('rejects unknown brands, colours and absurd prices', () => {
    expect(cleanLlm({ brand: 'Gucci', color: 'ultraviolet', maxPrice: -5, gender: 'robots' }, catalog)).toEqual({});
    expect(cleanLlm('not json', catalog)).toBeNull();
  });
});
