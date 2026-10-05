/**
 * Uploaded-file URLs the API will accept from a client.
 *
 * Files go from the phone straight to Cloudinary with a short-lived signature
 * (POST /api/uploads/sign) — Vercel caps request bodies at 4.5 MB, and the API
 * should not be a file proxy anyway. The client then hands the API the URL.
 * That URL is untrusted input: it must be https, on OUR Cloudinary cloud, and
 * inside the folder the signature was issued for — this purpose, this owner.
 * Anything else (a `file://` path from the phone, someone else's upload, an
 * arbitrary site) is refused. `file://` "evidence" is exactly what disputes
 * used to store.
 */

/** purpose → { folder, resourceType, formats, maxBytes } */
const PURPOSES = {
  avatar: { folder: 'avatars', resourceType: 'image', formats: ['jpg', 'jpeg', 'png', 'webp', 'heic'], maxBytes: 5e6 },
  dispute_evidence: { folder: 'disputes', resourceType: 'image', formats: ['jpg', 'jpeg', 'png', 'webp', 'heic'], maxBytes: 10e6 },
  health_record: { folder: 'health-records', resourceType: 'auto', formats: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'pdf'], maxBytes: 10e6 },
  product_image: { folder: 'products', resourceType: 'image', formats: ['jpg', 'jpeg', 'png', 'webp'], maxBytes: 8e6 },
  product_model3d: { folder: 'models3d', resourceType: 'raw', formats: ['glb', 'usdz'], maxBytes: 10e6 },
};

function folderFor(purpose, ownerId) {
  const p = PURPOSES[purpose];
  if (!p) throw new Error(`Unknown upload purpose "${purpose}"`);
  return `metromatrix/${p.folder}/${String(ownerId)}`;
}

/**
 * Throws an Error (with a message fit to show) unless `url` is an upload we
 * signed for this purpose and owner. Returns the normalised URL.
 */
function assertOwnedAsset(url, { purpose, ownerId, cloudName = process.env.CLOUDINARY_CLOUD_NAME } = {}) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('A file URL is required');
  const value = url.trim();
  if (/^(file|content|ph|assets-library):/i.test(value)) {
    throw new Error('That file was never uploaded — upload it first, then save');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (e) {
    throw new Error('That is not a valid file URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com') {
    throw new Error('Files must be uploaded through the app');
  }
  const folder = folderFor(purpose, ownerId);
  // /<cloud>/<image|raw|video>/upload/[v123/]<folder>/<file>
  const re = new RegExp(
    `^/${escape(cloudName || '')}/(image|raw|video)/upload/(?:v\\d+/)?${escape(folder)}/[^/]+$`
  );
  if (!cloudName || !re.test(parsed.pathname)) {
    throw new Error("That file isn't one of your uploads");
  }
  return value;
}

function escape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { PURPOSES, folderFor, assertOwnedAsset };
