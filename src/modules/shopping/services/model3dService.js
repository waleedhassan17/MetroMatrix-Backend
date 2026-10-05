/**
 * Checks a 3D model file before a product links to it.
 *
 * "View in your room" hands the URL straight to Google's Scene Viewer (or
 * Apple's AR Quick Look), so a wrong file fails on the customer's phone with
 * a blank viewer. The upload is already ours (assertOwnedAsset); here we read
 * only the file's first bytes — a ranged request, not a download — and check
 * it really is what the viewer expects:
 *   .glb   12-byte header: magic "glTF", version 2, declared total length
 *          (refused above 10 MB: Scene Viewer needs it fetched quickly over
 *          mobile data).
 *   .usdz  a ZIP archive: "PK\x03\x04".
 */
const GLB_MAGIC = 0x46546c67; // "glTF", little-endian
const MAX_BYTES = 10 * 1024 * 1024;

class ModelFileError extends Error {}

async function headBytes(url, n, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(url, { headers: { Range: `bytes=0-${n - 1}` }, signal: controller.signal });
    } catch (e) {
      throw new ModelFileError('Could not read the uploaded model. Try uploading it again.');
    }
    if (!res.ok) throw new ModelFileError('Could not read the uploaded model. Try uploading it again.');
    // A server that ignores Range answers 200 with the whole file: read only
    // the first chunk and stop.
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) return Buffer.from(await res.arrayBuffer()).subarray(0, n);
    const chunks = [];
    let got = 0;
    while (got < n) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      got += value.length;
    }
    reader.cancel().catch(() => {});
    return Buffer.concat(chunks).subarray(0, n);
  } finally {
    clearTimeout(timer);
  }
}

/** → { sizeBytes } or throws ModelFileError with a message fit to show. */
async function inspectGlb(url, opts) {
  const b = await headBytes(url, 12, opts);
  if (b.length < 12 || b.readUInt32LE(0) !== GLB_MAGIC) {
    throw new ModelFileError('That file is not a .glb (binary glTF) model.');
  }
  const version = b.readUInt32LE(4);
  if (version !== 2) throw new ModelFileError(`Only glTF 2.0 models are supported (this one is version ${version}).`);
  const sizeBytes = b.readUInt32LE(8);
  if (sizeBytes > MAX_BYTES) throw new ModelFileError('Models must be 10 MB or smaller.');
  return { sizeBytes };
}

async function inspectUsdz(url, opts) {
  const b = await headBytes(url, 4, opts);
  if (b.length < 4 || b.readUInt32LE(0) !== 0x04034b50) {
    throw new ModelFileError('That file is not a .usdz model.');
  }
}

module.exports = { inspectGlb, inspectUsdz, ModelFileError, GLB_MAGIC, MAX_BYTES };
