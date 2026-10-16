const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const HealthcareBanner = require('../modules/healthcare/models/HealthcareBanner');
const Specialty = require('../modules/healthcare/models/Specialty');
const Doctor = require('../modules/healthcare/models/Doctor');
const auditService = require('../services/auditService');
const AppError = require('../utils/AppError');
const { ERROR_CODES } = require('../utils/errorCodes');
const { ok, created } = require('../utils/apiResponse');

// ============================================================================
// Health home banners (staff promotions) — /api/v1/admin/healthcare/banners.
// Mounted behind adminHealthcareRoutes' guard (canManageHealthcare).
// ============================================================================

const audit = (req, action, banner, { before, after } = {}) =>
  auditService.audit(req, {
    module: 'healthcare',
    action: `healthcare.${action}`,
    targetType: 'HealthcareBanner',
    targetId: banner._id,
    before,
    after,
  });

const invalid = (message) => new AppError(ERROR_CODES.VALIDATION_FAILED, message);

const isHttpsUrl = (v) => {
  try {
    return new URL(String(v)).protocol === 'https:';
  } catch {
    return false;
  }
};

const toDate = (v, field) => {
  if (v === null || v === '' || v === undefined) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw invalid(`${field} is not a valid date`);
  return d;
};

/**
 * The banner a request asks for, merged over `current` (an update) and
 * checked: a title and an https image, a target that matches its type, and a
 * window that ends after it starts. Pure — target existence is checked after.
 */
const normaliseBanner = (body = {}, current = {}) => {
  const pick = (k) => (body[k] !== undefined ? body[k] : current[k]);
  const title = String(pick('title') || '').trim();
  if (!title) throw invalid('A title is required');
  if (title.length > 80) throw invalid('Keep the title to 80 characters');
  const subtitle = String(pick('subtitle') || '').trim();
  if (subtitle.length > 160) throw invalid('Keep the subtitle to 160 characters');
  const image = String(pick('image') || '').trim();
  if (!isHttpsUrl(image)) throw invalid('The image must be an https URL');

  const targetType = pick('targetType') || 'none';
  if (!HealthcareBanner.TARGET_TYPES.includes(targetType)) throw invalid(`targetType must be one of ${HealthcareBanner.TARGET_TYPES.join(', ')}`);
  const out = {
    title,
    subtitle,
    image,
    targetType,
    targetScreen: null,
    specialtyId: null,
    doctorId: null,
    city: pick('city') ? String(pick('city')).trim().slice(0, 60) : null,
    sortOrder: Number(pick('sortOrder')) || 0,
    isActive: pick('isActive') === undefined ? true : pick('isActive') === true || pick('isActive') === 'true',
    validFrom: toDate(pick('validFrom'), 'validFrom'),
    validUntil: toDate(pick('validUntil'), 'validUntil'),
  };
  if (out.validFrom && out.validUntil && out.validUntil <= out.validFrom) throw invalid('validUntil must be after validFrom');

  if (targetType === 'screen') {
    const screen = pick('targetScreen');
    if (!HealthcareBanner.TARGET_SCREENS.includes(screen)) throw invalid(`targetScreen must be one of ${HealthcareBanner.TARGET_SCREENS.join(', ')}`);
    out.targetScreen = screen;
  } else if (targetType === 'specialty') {
    const id = pick('specialtyId');
    if (!mongoose.isValidObjectId(id)) throw invalid('specialtyId is required for a specialty banner');
    out.specialtyId = id;
  } else if (targetType === 'doctor') {
    const id = pick('doctorId');
    if (!mongoose.isValidObjectId(id)) throw invalid('doctorId is required for a doctor banner');
    out.doctorId = id;
  }
  return out;
};

/** A banner that leads to a missing specialty or doctor would open an error screen. */
const assertTargetExists = async (b) => {
  if (b.specialtyId && !(await Specialty.exists({ _id: b.specialtyId, isActive: true }))) throw invalid('That specialty does not exist');
  if (b.doctorId && !(await Doctor.exists({ _id: b.doctorId, verificationStatus: 'verified', isActive: true }))) {
    throw invalid('That doctor is not listed');
  }
};

const findBanner = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw invalid('Invalid banner ID');
  const banner = await HealthcareBanner.findById(id);
  if (!banner) throw new AppError(ERROR_CODES.NOT_FOUND, 'Banner not found');
  return banner;
};

// @desc    Every banner, live or not
// @route   GET /api/v1/admin/healthcare/banners
const listBanners = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';
  const banners = await HealthcareBanner.find(filter).sort({ sortOrder: 1, createdAt: -1 }).limit(200);
  return ok(res, banners.map((b) => b.toJSON()));
});

// @route   POST /api/v1/admin/healthcare/banners
const createBanner = asyncHandler(async (req, res) => {
  const value = normaliseBanner(req.body);
  await assertTargetExists(value);
  const banner = await HealthcareBanner.create(value);
  await audit(req, 'create_banner', banner, { after: banner.toJSON() });
  return created(res, banner.toJSON());
});

// @route   PATCH /api/v1/admin/healthcare/banners/:id
const updateBanner = asyncHandler(async (req, res) => {
  const banner = await findBanner(req.params.id);
  const before = banner.toJSON();
  const value = normaliseBanner(req.body, banner.toObject());
  await assertTargetExists(value);
  banner.set(value);
  await banner.save();
  await audit(req, 'update_banner', banner, { before, after: banner.toJSON() });
  return ok(res, banner.toJSON());
});

// @route   DELETE /api/v1/admin/healthcare/banners/:id
const deleteBanner = asyncHandler(async (req, res) => {
  const banner = await findBanner(req.params.id);
  const before = banner.toJSON();
  await banner.deleteOne();
  await audit(req, 'delete_banner', banner, { before });
  return ok(res, { id: req.params.id });
});

module.exports = { listBanners, createBanner, updateBanner, deleteBanner, normaliseBanner };
