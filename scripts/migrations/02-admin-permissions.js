/**
 * 02 — admin roles & new permission flags (phase B2).
 *
 * - role and isSuperAdmin used to be set independently. An admin with EITHER
 *   role 'super_admin' OR isSuperAdmin true becomes a consistent super admin
 *   (the Admin model now derives isSuperAdmin from role on every save).
 * - Adds the new flags (canManageHomeServices, canManageFinance, canBroadcast,
 *   canViewAudit) where missing: true for super admins, FALSE for everyone
 *   else — finance and audit access are granted deliberately, not by default.
 *   Home-services oversight was previously open to every admin, so admins
 *   (not moderators) that could manage the other modules keep it.
 *
 * Idempotent; only sets fields that are missing or inconsistent.
 * Rollback: the previous release ignores the new flags; nothing to undo.
 */
const { runMigration } = require('./lib');
const Admin = require('../../src/models/Admin');

const NEW_FLAGS = ['canManageHomeServices', 'canManageFinance', 'canBroadcast', 'canViewAudit'];

runMigration('02-admin-permissions', async ({ dry, log }) => {
  const coll = Admin.collection;
  const admins = await coll.find({}, { projection: { email: 1, role: 1, isSuperAdmin: 1, permissions: 1 } }).toArray();
  let changed = 0;
  for (const a of admins) {
    const isSuper = a.role === 'super_admin' || a.isSuperAdmin === true;
    const set = {};
    if (isSuper && a.role !== 'super_admin') set.role = 'super_admin';
    if (a.isSuperAdmin !== isSuper) set.isSuperAdmin = isSuper;
    for (const flag of NEW_FLAGS) {
      if (a.permissions?.[flag] !== undefined) continue;
      let value = isSuper;
      if (!isSuper && flag === 'canManageHomeServices') {
        value = a.role === 'admin' && (a.permissions?.canManageShopping === true || a.permissions?.canManageHealthcare === true);
      }
      set[`permissions.${flag}`] = value;
    }
    if (Object.keys(set).length) {
      changed += 1;
      log(`${a.email}: ${JSON.stringify(set)}`);
      if (!dry) await coll.updateOne({ _id: a._id }, { $set: set });
    }
  }
  return { admins: admins.length, changed };
}).catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
