const AdminSettings = require('../../../models/AdminSettings');

/**
 * Single source of truth for shopping platform settings.
 * Values live in the AdminSettings singleton under `shopping` and are
 * the SAME values checkout, inventory and admin analytics read —
 * no duplicated constants anywhere in the module.
 */

/**
 * Delivery speed tiers. The surcharge is charged on top of the per-brand
 * shipping fee. These defaults reproduce exactly what the app used to show
 * from a client-side constant, so making them server-priced changes no price —
 * it only makes the amount charged match the amount displayed.
 */
const DEFAULT_DELIVERY_TIERS = Object.freeze([
  {
    id: 'standard',
    name: 'Standard',
    eta: '5-7 days',
    description: 'Our regular delivery window',
    surcharge: 0,
    isActive: true,
  },
  {
    id: 'express',
    name: 'Express',
    eta: '2-3 days',
    description: 'Faster delivery for urgent orders',
    surcharge: 250,
    isActive: true,
  },
  {
    id: 'same-day',
    name: 'Same Day',
    eta: 'Today',
    description: 'Available in select cities only',
    surcharge: 500,
    isActive: true,
  },
]);

const SHOPPING_SETTINGS_DEFAULTS = Object.freeze({
  commissionPercent: 10,
  shippingFeePerBrand: 150,
  freeShippingThreshold: 3000,
  lowStockThreshold: 5,
  defaultReturnDays: 7,
  autoApproveBrands: false,
  deliveryTiers: DEFAULT_DELIVERY_TIERS,
});

const cloneDefaultTiers = () => DEFAULT_DELIVERY_TIERS.map((t) => ({ ...t }));

/** A stored document written before deliveryTiers existed can carry the field
 *  as an empty array, which would leave checkout with nothing to offer. */
const withTierFallback = (merged) => {
  if (!Array.isArray(merged.deliveryTiers) || merged.deliveryTiers.length === 0) {
    return { ...merged, deliveryTiers: cloneDefaultTiers() };
  }
  return merged;
};

/**
 * Accept only well-formed tiers, and only the fields we own. An admin can
 * reprice, rename or disable a tier; ids stay as sent because placed orders
 * reference them.
 */
const normaliseDeliveryTiers = (tiers) => {
  if (!Array.isArray(tiers)) return null;
  const seen = new Set();
  const clean = [];
  for (const t of tiers) {
    if (!t || typeof t !== 'object') continue;
    const id = String(t.id || '').trim();
    const name = String(t.name || '').trim();
    if (!id || !name || seen.has(id)) continue;
    const surcharge = Number(t.surcharge);
    seen.add(id);
    clean.push({
      id,
      name,
      eta: String(t.eta || ''),
      description: String(t.description || ''),
      surcharge: Number.isFinite(surcharge) && surcharge >= 0 ? Math.round(surcharge) : 0,
      isActive: t.isActive !== false,
    });
  }
  return clean.length ? clean : null;
};

/**
 * Resolve a tier id sent by a client. Returns the tier, or null when the id is
 * unknown or disabled — the caller decides whether that is a 400.
 */
const resolveDeliveryTier = (settings, tierId) => {
  const tiers = Array.isArray(settings.deliveryTiers) ? settings.deliveryTiers : [];
  const tier = tiers.find((t) => t.id === tierId);
  if (!tier || tier.isActive === false) return null;
  return tier;
};

const getShoppingSettings = async () => {
  const settings = await AdminSettings.getSettings();
  const stored = settings.shopping ? settings.shopping.toObject() : {};
  return withTierFallback({ ...SHOPPING_SETTINGS_DEFAULTS, ...stored });
};

const updateShoppingSettings = async (patch, adminId) => {
  const settings = await AdminSettings.getSettings();
  const current = settings.shopping ? settings.shopping.toObject() : {};
  const allowed = {};
  Object.keys(SHOPPING_SETTINGS_DEFAULTS).forEach((key) => {
    if (patch[key] === undefined) return;
    if (key === 'deliveryTiers') {
      // Malformed tiers are ignored rather than saved — a bad payload must not
      // be able to empty the tier list and break checkout.
      const tiers = normaliseDeliveryTiers(patch.deliveryTiers);
      if (tiers) allowed.deliveryTiers = tiers;
      return;
    }
    allowed[key] = patch[key];
  });
  settings.shopping = { ...current, ...allowed };
  settings.lastUpdatedBy = adminId;
  await settings.save();
  return withTierFallback({ ...SHOPPING_SETTINGS_DEFAULTS, ...settings.shopping.toObject() });
};

module.exports = {
  SHOPPING_SETTINGS_DEFAULTS,
  DEFAULT_DELIVERY_TIERS,
  normaliseDeliveryTiers,
  resolveDeliveryTier,
  getShoppingSettings,
  updateShoppingSettings,
};
