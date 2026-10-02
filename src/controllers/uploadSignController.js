const asyncHandler = require('express-async-handler');
const { cloudinary } = require('../config/cloudinary');
const { PURPOSES, folderFor } = require('../utils/assetUrl');

/**
 * POST /api/uploads/sign   { purpose }
 *
 * A signature for ONE direct upload from the phone to Cloudinary, valid for
 * Cloudinary's standard window, confined to `metromatrix/<purpose>/<you>/`.
 * The client posts the file to `uploadUrl` with exactly the returned params,
 * then gives the resulting `secure_url` to the endpoint that uses it — which
 * re-checks it with utils/assetUrl.assertOwnedAsset.
 */
const signUpload = asyncHandler(async (req, res) => {
  const { purpose } = req.body || {};
  const spec = PURPOSES[purpose];
  if (!spec) {
    res.status(400);
    throw new Error(`purpose must be one of: ${Object.keys(PURPOSES).join(', ')}`);
  }
  const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: secret } = process.env;
  if (!cloudName || !apiKey || !secret) {
    res.status(503);
    throw new Error('File uploads are not configured on this server');
  }

  const timestamp = Math.round(Date.now() / 1000);
  const folder = folderFor(purpose, req.user._id);
  const allowedFormats = spec.formats.join(',');
  // Everything sent to Cloudinary except file/api_key/resource_type is signed,
  // so the client cannot change the folder or the allowed formats.
  const params = { timestamp, folder, allowed_formats: allowedFormats };
  const signature = cloudinary.utils.api_sign_request(params, secret);

  res.json({
    success: true,
    data: {
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/${spec.resourceType}/upload`,
      cloudName,
      apiKey,
      timestamp,
      signature,
      folder,
      allowedFormats,
      resourceType: spec.resourceType,
      maxBytes: spec.maxBytes,
    },
  });
});

module.exports = { signUpload };
