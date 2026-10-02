const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('natural-language product search (MongoDB)', () => {
  const mongoose = require('mongoose');
  let Product;
  let listProducts;
  const ids = {};

  beforeAll(async () => {
    delete process.env.GEMINI_API_KEY; // rules only — the path that must always work
    await mongoose.connect(URI.replace(/\/[^/]*$/, '/mm_nlq_test'));
    await mongoose.connection.dropDatabase();
    const Brand = require('../models/Brand');
    const Category = require('../models/Category');
    Product = require('../models/Product');
    await Product.syncIndexes();
    const nike = await mongoose.connection.collection('brands').insertOne({ odexId: 'B-NIKE', name: 'Nike', slug: 'nike', status: 'active', isDeleted: false });
    const gul = await mongoose.connection.collection('brands').insertOne({ odexId: 'B-GUL', name: 'Gul Ahmed', slug: 'gul', status: 'active', isDeleted: false });
    const shoes = await mongoose.connection.collection(Category.collection.name).insertOne({ name: 'Running Shoes', brandId: nike.insertedId });
    ids.nike = nike.insertedId;
    const mk = (o) => ({ isActive: true, inStock: true, variants: [{ color: o.color, stockQuantity: 5 }], ...o });
    await Product.create([
      mk({ name: 'Air Zoom Runner', brandId: nike.insertedId, categoryId: shoes.insertedId, basePrice: 2800, color: 'Red', tags: ['men', 'running'] }),
      mk({ name: 'Air Zoom Runner Pro', brandId: nike.insertedId, categoryId: shoes.insertedId, basePrice: 9000, color: 'Red', tags: ['men', 'running'] }),
      mk({ name: 'Pegasus Trail', brandId: nike.insertedId, categoryId: shoes.insertedId, basePrice: 2500, color: 'Blue', tags: ['men'] }),
      mk({ name: 'Lawn Kurta', brandId: gul.insertedId, basePrice: 2200, color: 'Red', tags: ['women'], description: 'printed lawn' }),
    ]);
    ({ listProducts } = require('../services/catalogService'));
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  const page = { page: 1, limit: 20, skip: 0 };

  it('"red nike running shoes under 3000" → only the red Nike shoe in budget', async () => {
    const { products, interpreted } = await listProducts({ q: 'red nike running shoes under 3000' }, page);
    expect(products.map((p) => p.name)).toEqual(['Air Zoom Runner']);
    expect(interpreted).toMatchObject({ color: 'red', maxPrice: 3000, brandName: 'Nike', source: 'rules' });
  });

  it('text relevance ranks a name match above a description match', async () => {
    const { products } = await listProducts({ q: 'lawn' }, page);
    expect(products[0].name).toBe('Lawn Kurta');
  });

  it('a partial word falls back to substring matching instead of returning nothing', async () => {
    const { products } = await listProducts({ q: 'pegas' }, page);
    expect(products.map((p) => p.name)).toEqual(['Pegasus Trail']);
  });

  it('a removed chip (ignore=price) drops that understood filter and says so', async () => {
    const { products, interpreted } = await listProducts({ q: 'red nike running shoes under 3000', ignore: 'price,bogus' }, page);
    expect(products.map((p) => p.name).sort()).toEqual(['Air Zoom Runner', 'Air Zoom Runner Pro']);
    expect(interpreted.maxPrice).toBeUndefined();
    expect(interpreted.ignored).toEqual(['price']);
    expect(interpreted.color).toBe('red');
  });

  it('still answers, by substring, while the text index is missing', async () => {
    await mongoose.connection.collection('shoppingproducts').dropIndex('product_text_v2');
    try {
      const { products } = await listProducts({ q: 'lawn' }, page);
      expect(products.map((p) => p.name)).toEqual(['Lawn Kurta']);
    } finally {
      await Product.syncIndexes();
    }
  });

  it('an explicit filter from the screen wins over the parsed one', async () => {
    const { products } = await listProducts({ q: 'shoes under 3000', maxPrice: '10000' }, page);
    expect(products.map((p) => p.name)).toContain('Air Zoom Runner Pro');
  });
});
