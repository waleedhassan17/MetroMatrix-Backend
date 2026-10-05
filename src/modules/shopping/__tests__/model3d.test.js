const { inspectGlb, inspectUsdz, ModelFileError } = require('../services/model3dService');

/** A GLB header: "glTF", version, total length. */
function glbHeader({ magic = 0x46546c67, version = 2, length = 2048 } = {}) {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(magic, 0);
  b.writeUInt32LE(version, 4);
  b.writeUInt32LE(length, 8);
  return b;
}
const respond = (bytes, status = 206) => async () => new Response(new Uint8Array(bytes), { status });

describe('3D model file checks', () => {
  it('reads the size from a valid glTF 2.0 header', async () => {
    await expect(inspectGlb('https://x/m.glb', { fetchImpl: respond(glbHeader({ length: 123456 })) })).resolves.toEqual({ sizeBytes: 123456 });
  });

  it('asks for the first 12 bytes only', async () => {
    const fetchImpl = jest.fn(respond(glbHeader()));
    await inspectGlb('https://x/m.glb', { fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ Range: 'bytes=0-11' });
  });

  it('stops reading after the header when the server ignores Range', async () => {
    const big = Buffer.concat([glbHeader({ length: 4000 }), Buffer.alloc(4000)]);
    await expect(inspectGlb('https://x/m.glb', { fetchImpl: respond(big, 200) })).resolves.toEqual({ sizeBytes: 4000 });
  });

  it.each([
    ['not a glb at all', glbHeader({ magic: 0x12345678 }), /not a \.glb/],
    ['glTF 1.0', glbHeader({ version: 1 }), /Only glTF 2\.0/],
    ['over 10 MB', glbHeader({ length: 11 * 1024 * 1024 }), /10 MB/],
    ['truncated', Buffer.from('glT'), /not a \.glb/],
  ])('refuses a file that is %s', async (_, bytes, msg) => {
    await expect(inspectGlb('https://x/m.glb', { fetchImpl: respond(bytes) })).rejects.toThrow(msg);
  });

  it('turns network trouble into a message fit to show', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNRESET');
    };
    const err = await inspectGlb('https://x/m.glb', { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelFileError);
    expect(err.message).toMatch(/upload/);
    await expect(inspectGlb('https://x/m.glb', { fetchImpl: respond([], 404) })).rejects.toThrow(ModelFileError);
  });

  it('accepts a USDZ (zip) and refuses anything else', async () => {
    await expect(inspectUsdz('https://x/m.usdz', { fetchImpl: respond([0x50, 0x4b, 0x03, 0x04]) })).resolves.toBeUndefined();
    await expect(inspectUsdz('https://x/m.usdz', { fetchImpl: respond(glbHeader()) })).rejects.toThrow(/usdz/);
  });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('vendor 3D model endpoints (MongoDB)', () => {
  const mongoose = require('mongoose');
  const express = require('express');
  const request = require('supertest');
  let Product;
  let app;
  const vendor = new mongoose.Types.ObjectId();
  const brandId = new mongoose.Types.ObjectId();
  const url = (file, owner = vendor) => `https://res.cloudinary.com/demo/raw/upload/v1/metromatrix/models3d/${owner}/${file}`;
  let fetchSpy;

  beforeAll(async () => {
    process.env.CLOUDINARY_CLOUD_NAME = 'demo';
    await mongoose.connect(URI.replace(/\/[^/]*$/, '/mm_model3d_test'));
    await mongoose.connection.dropDatabase();
    Product = require('../models/Product');
    const ctrl = require('../controllers/vendorCatalogController');
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { _id: vendor };
      req.brand = { _id: brandId };
      next();
    });
    app.patch('/products/:productId/model3d', ctrl.attachModel3d);
    app.delete('/products/:productId/model3d', ctrl.removeModel3d);
    app.use(require('../../../middleware/errorMiddleware').errorHandler);
  });
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (u) =>
      String(u).endsWith('.usdz') ? new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 206 }) : new Response(new Uint8Array(glbHeader({ length: 5000 })), { status: 206 })
    );
  });
  afterEach(() => fetchSpy.mockRestore());
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('attaches a checked model, and removes it', async () => {
    const p = await Product.create({ brandId, name: 'Armchair', basePrice: 30000 });
    const res = await request(app).patch(`/products/${p._id}/model3d`).send({ glbUrl: url('chair.glb'), usdzUrl: url('chair.usdz') });
    expect(res.status).toBe(200);
    expect(res.body.data.model3d).toMatchObject({ glbUrl: url('chair.glb'), usdzUrl: url('chair.usdz'), sizeBytes: 5000 });
    expect(res.body.data.moderation.status).toBe('approved'); // auto-approve is the default

    const del = await request(app).delete(`/products/${p._id}/model3d`);
    expect(del.body.data.model3d.glbUrl).toBeNull();
  });

  it("refuses someone else's upload, a non-.glb name, and a file that is not glTF", async () => {
    const p = await Product.create({ brandId, name: 'Lamp', basePrice: 4000 });
    const other = new mongoose.Types.ObjectId();
    expect((await request(app).patch(`/products/${p._id}/model3d`).send({ glbUrl: url('lamp.glb', other) })).status).toBe(400);
    expect((await request(app).patch(`/products/${p._id}/model3d`).send({ glbUrl: url('lamp.obj') })).status).toBe(400);
    fetchSpy.mockImplementation(async () => new Response(new Uint8Array(Buffer.from('<html>nope</html>')), { status: 200 }));
    const bad = await request(app).patch(`/products/${p._id}/model3d`).send({ glbUrl: url('lamp.glb') });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatch(/not a \.glb/);
    expect((await Product.findById(p._id)).model3d.glbUrl).toBeNull();
  });

  it("cannot touch another brand's product", async () => {
    const p = await Product.create({ brandId: new mongoose.Types.ObjectId(), name: 'Not mine', basePrice: 10 });
    expect((await request(app).patch(`/products/${p._id}/model3d`).send({ glbUrl: url('x.glb') })).status).toBe(404);
  });
});
