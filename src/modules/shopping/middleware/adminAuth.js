const ShoppingAuditLog = require('../models/ShoppingAuditLog');

/**
 * requireShoppingAdmin — authenticated Admin with the shopping permission
 * (canManageShopping, following the existing Admin.permissions pattern).
 * Runs after `protect`.
 */
const requireShoppingAdmin = (req, res, next) => {
  if (!req.isAdmin) {
    return res.status(403).json({ success: false, error: 'This route is for admins only' });
  }
  const perms = req.user.permissions || {};
  if (!req.user.isSuperAdmin && perms.canManageShopping !== true) {
    return res
      .status(403)
      .json({ success: false, error: 'You do not have the shopping permission' });
  }
  return next();
};

/** Append to the shopping audit trail. Never throws into the request path. */
const audit = async (adminId, action, targetType, targetId, { before, after, reason } = {}) => {
  try {
    await ShoppingAuditLog.create({
      admin: adminId,
      action,
      targetType,
      targetId,
      before,
      after,
      reason,
    });
  } catch (e) {
    console.error('[shopping] audit write failed:', e.message);
  }
};

module.exports = { requireShoppingAdmin, audit };
