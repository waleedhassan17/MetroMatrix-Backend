const { assertOwnedAsset, folderFor } = require('../assetUrl');

const CLOUD = 'mmcloud';
const OWNER = '64b7f0c2a1b2c3d4e5f60718';
const ok = (purpose, path) => `https://res.cloudinary.com/${CLOUD}/${path}`;

describe('assertOwnedAsset', () => {
  const opts = { purpose: 'avatar', ownerId: OWNER, cloudName: CLOUD };

  it('accepts our upload in the caller\'s folder, versioned or not', () => {
    for (const url of [
      ok('avatar', `image/upload/v1712345678/metromatrix/avatars/${OWNER}/abc.jpg`),
      ok('avatar', `image/upload/metromatrix/avatars/${OWNER}/abc.jpg`),
    ]) {
      expect(assertOwnedAsset(url, opts)).toBe(url);
    }
  });

  it.each([
    ['file:///data/user/0/com.metromatrix/cache/a.jpg', /never uploaded/],
    ['content://media/external/images/1', /never uploaded/],
    ['http://res.cloudinary.com/mmcloud/image/upload/metromatrix/avatars/x/a.jpg', /through the app/],
    ['https://evil.example/a.jpg', /through the app/],
    [`https://res.cloudinary.com/othercloud/image/upload/metromatrix/avatars/${OWNER}/a.jpg`, /isn't one of your uploads/],
    ['https://res.cloudinary.com/mmcloud/image/upload/metromatrix/avatars/someoneelse/a.jpg', /isn't one of your uploads/],
    [`https://res.cloudinary.com/mmcloud/image/upload/metromatrix/disputes/${OWNER}/a.jpg`, /isn't one of your uploads/],
    [`https://res.cloudinary.com/mmcloud/image/upload/metromatrix/avatars/${OWNER}/../x/a.jpg`, /isn't one of your uploads/],
    ['', /required/],
    [null, /required/],
  ])('refuses %p', (url, msg) => {
    expect(() => assertOwnedAsset(url, opts)).toThrow(msg);
  });

  it('3D models live under raw/', () => {
    const url = `https://res.cloudinary.com/${CLOUD}/raw/upload/v1/metromatrix/models3d/${OWNER}/chair.glb`;
    expect(assertOwnedAsset(url, { purpose: 'product_model3d', ownerId: OWNER, cloudName: CLOUD })).toBe(url);
  });

  it('folders are per purpose and owner', () => {
    expect(folderFor('dispute_evidence', OWNER)).toBe(`metromatrix/disputes/${OWNER}`);
    expect(() => folderFor('nope', OWNER)).toThrow(/Unknown upload purpose/);
  });
});
