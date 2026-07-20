/**
 * Unit tests for the catalogue query/sort/tree logic (pure functions, no DB).
 */
const {
  buildProductQuery,
  buildProductSort,
  buildCategoryTree,
  parseBool,
} = require('../services/catalogService');

describe('buildProductQuery', () => {
  it('always restricts to active products', () => {
    expect(buildProductQuery({}).isActive).toBe(true);
  });

  it('filters by brandId when given', () => {
    const q = buildProductQuery({ brandId: 'abc' });
    expect(q.brandId).toBe('abc');
  });

  it('restricts to active brand ids when no brandId given', () => {
    const q = buildProductQuery({}, ['b1', 'b2']);
    expect(q.brandId).toEqual({ $in: ['b1', 'b2'] });
  });

  it('applies boolean flags from query-string strings', () => {
    const q = buildProductQuery({ isFeatured: 'true', inStock: 'true', isNewArrival: '1' });
    expect(q.isFeatured).toBe(true);
    expect(q.inStock).toBe(true);
    expect(q.isNewArrival).toBe(true);
  });

  it('ignores false/absent boolean flags', () => {
    const q = buildProductQuery({ isFeatured: 'false' });
    expect(q.isFeatured).toBeUndefined();
  });

  it('builds effective-price range on salePrice ?? basePrice', () => {
    const q = buildProductQuery({ minPrice: '1000', maxPrice: '5000' });
    expect(q.$expr).toEqual({
      $and: [
        { $gte: [{ $ifNull: ['$salePrice', '$basePrice'] }, 1000] },
        { $lte: [{ $ifNull: ['$salePrice', '$basePrice'] }, 5000] },
      ],
    });
  });

  it('builds single-sided price filter', () => {
    const q = buildProductQuery({ minPrice: 500 });
    expect(q.$expr).toEqual({ $gte: [{ $ifNull: ['$salePrice', '$basePrice'] }, 500] });
  });

  it('builds a case-insensitive search across name/description/tags', () => {
    const q = buildProductQuery({ search: 'denim' });
    expect(q.$or).toHaveLength(3);
    expect(q.$or[0].name.test('Slim DENIM jacket')).toBe(true);
  });

  it('escapes regex metacharacters in search', () => {
    const q = buildProductQuery({ search: 'a+b(c)' });
    expect(() => q.$or[0].name.test('x')).not.toThrow();
    expect(q.$or[0].name.test('a+b(c) shirt')).toBe(true);
  });

  it('filters by exact lowercased gender tag, not substring search', () => {
    const q = buildProductQuery({ gender: 'Men' });
    expect(q.tags).toBe('men');
  });
});

describe('buildProductSort', () => {
  it.each([
    ['price_asc', { effectivePrice: 1 }],
    ['price_desc', { effectivePrice: -1 }],
    ['rating', { rating: -1 }],
    ['newest', { createdAt: -1 }],
    ['popular', { totalReviews: -1 }],
    [undefined, { totalReviews: -1 }],
  ])('%s → %j', (input, expected) => {
    expect(buildProductSort(input)).toEqual(expected);
  });
});

describe('buildCategoryTree', () => {
  const cat = (id, name, parentId = null) => ({
    categoryId: id,
    name,
    parentId,
    toJSON: undefined,
  });

  it('nests children under parents and rolls up product counts', () => {
    const tree = buildCategoryTree(
      [cat('men', 'Men'), cat('men-shirts', 'Shirts', 'men'), cat('women', 'Women')],
      { men: 2, 'men-shirts': 5, women: 3 }
    );
    expect(tree).toHaveLength(2);
    const men = tree.find((c) => c.categoryId === 'men');
    expect(men.children).toHaveLength(1);
    expect(men.children[0].categoryId).toBe('men-shirts');
    expect(men.productCount).toBe(7); // own 2 + child 5
    expect(tree.find((c) => c.categoryId === 'women').productCount).toBe(3);
  });

  it('treats orphaned parentId as a root', () => {
    const tree = buildCategoryTree([cat('a', 'A', 'missing-parent')], {});
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toEqual([]);
  });

  it('defaults productCount to 0', () => {
    const tree = buildCategoryTree([cat('a', 'A')], {});
    expect(tree[0].productCount).toBe(0);
  });
});

describe('parseBool', () => {
  it('accepts true/"true"/"1"/1 only', () => {
    expect(parseBool(true)).toBe(true);
    expect(parseBool('true')).toBe(true);
    expect(parseBool('1')).toBe(true);
    expect(parseBool(1)).toBe(true);
    expect(parseBool('false')).toBe(false);
    expect(parseBool(undefined)).toBe(false);
    expect(parseBool('')).toBe(false);
  });
});
