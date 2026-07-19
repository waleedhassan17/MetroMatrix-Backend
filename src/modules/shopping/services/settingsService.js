const AdminSettings = require('../../../models/AdminSettings');

/**
 * Single source of truth for shopping platform settings.
 * Values live in the AdminSettings singleton under `shopping` and are
 * the SAME values checkout, inventory and admin analytics read —
 * no duplicated constants anywhere in the module.
 */
const SHOPPING_SETTINGS_DEFAULTS = Object.freeze({
  commissionPercent: 10,
  shippingFeePerBrand: 150,
  freeShippingThreshold: 3000,
  lowStockThreshold: 5,
  defaultReturnDays: 7,
  autoApproveBrands: false,
});

const getShoppingSettings = async () => {
  const settings = await AdminSettings.getSettings();
  const stored = settings.shopping ? settings.shopping.toObject() : {};
  return { ...SHOPPING_SETTINGS_DEFAULTS, ...stored };
};

const updateShoppingSettings = async (patch, adminId) => {
  const settings = await AdminSettings.getSettings();
  const current = settings.shopping ? settings.shopping.toObject() : {};
  const allowed = {};
  Object.keys(SHOPPING_SETTINGS_DEFAULTS).forEach((key) => {
    if (patch[key] !== undefined) allowed[key] = patch[key];
  });
  settings.shopping = { ...current, ...allowed };
  settings.lastUpdatedBy = adminId;
  await settings.save();
  return { ...SHOPPING_SETTINGS_DEFAULTS, ...settings.shopping.toObject() };
};

module.exports = { SHOPPING_SETTINGS_DEFAULTS, getShoppingSettings, updateShoppingSettings };
