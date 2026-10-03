const { requirePermission } = require('../../../middleware/authMiddleware');
const auditService = require('../../../services/auditService');

/**
 * requireShoppingAdmin — authenticated Admin with canManageShopping (super
 * admins have every permission). The standard named permission guard, so the
 * route table and the admin route-guard test see it like every other one.
 * Runs after `protect`.
 */
const requireShoppingAdmin = requirePermission('canManageShopping');

/**
 * Record a shopping admin action in the unified AdminAuditLog (the old
 * ShoppingAuditLog was written and never read). Never throws into the
 * request path.
 */
const audit = (req, action, targetType, targetId, { before, after, reason } = {}) =>
  auditService.audit(req, {
    module: 'shopping',
    action: `shopping.${action}`,
    targetType,
    targetId,
    before,
    after,
    reason,
  });

module.exports = { requireShoppingAdmin, audit };
