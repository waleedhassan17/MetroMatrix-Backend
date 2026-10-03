const asyncHandler = require('express-async-handler');
const Provider = require('../../models/Provider');
const WalletAdjustment = require('../../models/WalletAdjustment');
const Booking = require('../../modules/homeservice/models/Booking');
const Dispute = require('../../modules/homeservice/models/Dispute');
const PayoutRequest = require('../../modules/homeservice/models/PayoutRequest');
const ServiceCategory = require('../../modules/homeservice/models/ServiceCategory');
const Appointment = require('../../modules/healthcare/models/Appointment');
const Doctor = require('../../modules/healthcare/models/Doctor');
const Specialty = require('../../modules/healthcare/models/Specialty');
const Order = require('../../modules/shopping/models/Order');
const ReturnRequest = require('../../modules/shopping/models/ReturnRequest');
const Brand = require('../../modules/shopping/models/Brand');
const { ok } = require('../../utils/apiResponse');
const { MAX_PAGE_SIZE } = require('../../utils/pagination');
const { DEFAULT_TIMEZONE } = require('../../utils/time');
const { WALLET_CURRENCY } = require('../../config/currency');
const { PERMISSIONS, ROLES, ROLE_PRESETS, SUPER_ADMIN_ONLY } = require('../../config/adminRoles');
const { present } = require('../../config/statusPresentation');
const { PROVIDER_STATES } = require('../../services/admin/providerStatus');
const { SOURCES } = require('../../services/admin/queueService');
const { getAdminSettings } = require('../../services/settingsCache');
const { presentAdmin } = require('../../services/admin/presenter');

/*
 * GET /api/admin/meta — every list, option and limit the admin app needs,
 * so none of it is hardcoded in the app.
 *
 * Status VALUES are read from the schemas themselves (adding a status to a
 * model adds it here); labels and semantic tones come from
 * config/statusPresentation.js. Reference data (specialties, categories,
 * cities) is read live. The app caches this per session.
 */

const enumOf = (Model, path) => Model.schema.path(path)?.enumValues || [];

// Cities providers actually list, most common first (there is no city list).
async function knownCities() {
  const rows = await Provider.aggregate([
    { $match: { city: { $type: 'string', $ne: '' } } },
    { $group: { _id: { $trim: { input: '$city' } }, n: { $sum: 1 } } },
    { $sort: { n: -1, _id: 1 } },
    { $limit: 50 },
  ]);
  return rows.map((r) => r._id).filter(Boolean);
}

const getMeta = asyncHandler(async (req, res) => {
  const [settings, specialties, categories, cities] = await Promise.all([
    getAdminSettings(),
    Specialty.find({ isActive: { $ne: false } }).select('name icon').sort({ name: 1 }).lean(),
    ServiceCategory.find({ isActive: { $ne: false } }).select('name slug providerSubType icon').sort({ sortOrder: 1, name: 1 }).lean(),
    knownCities(),
  ]);

  ok(res, {
    serverTime: new Date().toISOString(),
    timezone: DEFAULT_TIMEZONE,
    currency: WALLET_CURRENCY,
    platform: {
      name: settings.general?.platformName || 'MetroMatrix',
      supportPhone: settings.general?.supportPhone || null,
    },
    viewer: presentAdmin(req.user, { restrict: req.sessionRestriction || null }),
    limits: {
      maxPageSize: MAX_PAGE_SIZE,
      adjustmentApprovalThreshold: settings.finance?.adjustmentApprovalThreshold ?? 10000,
    },
    featureFlags: {
      twoFactorRequiredForSuperAdmins: settings.security?.twoFactorEnabled === true,
      maintenanceMode: settings.general?.maintenanceMode === true,
      // Not built yet (phase B4) — the app hides these entry points.
      auditLog: false,
      globalSearch: false,
      broadcasts: false,
      exports: false,
    },
    roles: ROLES.map((r) => ({ ...r, preset: ROLE_PRESETS[r.value] })),
    permissions: PERMISSIONS,
    superAdminOnly: SUPER_ADMIN_ONLY,
    enums: {
      providerStates: present('providerState', PROVIDER_STATES),
      providerTypes: present('providerType', enumOf(Provider, 'providerType').filter((t) => t !== 'pending')),
      providerSubTypes: present('providerSubType', enumOf(Provider, 'providerSubType')),
      bookingStatuses: present('bookingStatus', enumOf(Booking, 'status')),
      disputeStatuses: present('disputeStatus', enumOf(Dispute, 'status')),
      payoutStatuses: present('payoutStatus', enumOf(PayoutRequest, 'status')),
      appointmentStatuses: present('appointmentStatus', enumOf(Appointment, 'status')),
      doctorVerificationStatuses: present('doctorVerificationStatus', enumOf(Doctor, 'verificationStatus')),
      orderStatuses: present('orderStatus', enumOf(Order, 'orderStatus')),
      returnStatuses: present('returnStatus', enumOf(ReturnRequest, 'status')),
      brandStatuses: present('brandStatus', enumOf(Brand, 'status')),
      adjustmentStatuses: present('adjustmentStatus', enumOf(WalletAdjustment, 'status')),
      queueTypes: SOURCES.map((s) => ({ value: s.type, label: s.label, permission: s.permission })),
    },
    specialties: specialties.map((s) => ({ id: String(s._id), name: s.name, icon: s.icon || null })),
    serviceCategories: categories.map((c) => ({
      id: String(c._id),
      name: c.name,
      slug: c.slug,
      providerSubType: c.providerSubType,
      icon: c.icon || null,
    })),
    cities,
  });
});

module.exports = { getMeta };
