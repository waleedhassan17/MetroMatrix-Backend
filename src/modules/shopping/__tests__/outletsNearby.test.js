const { buildProductQuery } = require('../services/catalogService');

describe('product rating filter', () => {
  it('adds a minimum rating, capped at 5', () => {
    expect(buildProductQuery({ minRating: '4' }).rating).toEqual({ $gte: 4 });
    expect(buildProductQuery({ minRating: '9' }).rating).toEqual({ $gte: 5 });
    expect(buildProductQuery({ minRating: 'x' }).rating).toBeUndefined();
    expect(buildProductQuery({}).rating).toBeUndefined();
  });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('outlets near a customer (MongoDB)', () => {
  const mongoose = require('mongoose');
  const Outlet = require('../models/Outlet');
  require('../models/Brand');
  const { listOutlets } = require('../services/catalogService');

  beforeAll(async () => {
    await mongoose.connect(URI.replace(/\/[^/]*$/, '/mm_outlet_test'));
    await Outlet.syncIndexes();
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('returns nearest first with distanceKm, inside the radius only', async () => {
    const at = (km) => ({ type: 'Point', coordinates: [74.35, 31.52 + km * 0.009] });
    await Outlet.create([
      { name: 'Far Store', geo: at(8) },
      { name: 'Near Store', geo: at(1) },
      { name: 'Out Of Range', geo: at(40) },
      { name: 'Closed Store', geo: at(2), isActive: false },
    ]);
    const { outlets, total } = await listOutlets({ lat: '31.52', lng: '74.35', radiusKm: '25' }, { skip: 0, limit: 10 });
    expect(outlets.map((o) => o.name)).toEqual(['Near Store', 'Far Store']);
    expect(total).toBe(2);
    expect(outlets[0].distanceKm).toBeCloseTo(1, 0);
    expect(outlets[0].outletId).toBeDefined();
    expect(outlets[0].location.latitude).toBeCloseTo(31.529, 2);
  });
});
