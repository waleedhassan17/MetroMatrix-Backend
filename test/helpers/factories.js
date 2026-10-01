const Admin = require('../../src/models/Admin');

let seq = 0;
const next = () => (seq += 1);

const DEFAULT_PASSWORD = 'Correct-Horse-Battery-9';

/**
 * An admin with explicit permissions. `role: 'super_admin'` also sets
 * isSuperAdmin. passwordChangedAt defaults to now so password expiry doesn't
 * restrict the session unless a test wants it to.
 */
async function createAdmin({ role = 'admin', permissions, password = DEFAULT_PASSWORD, ...overrides } = {}) {
  const n = next();
  const admin = new Admin({
    email: `admin${n}@example.com`,
    fullName: `Test Admin ${n}`,
    role,
    isSuperAdmin: role === 'super_admin',
    isActive: true,
    passwordChangedAt: new Date(),
    ...overrides,
  });
  if (permissions) {
    for (const key of Admin.PERMISSION_KEYS) admin.permissions[key] = permissions[key] === true;
  }
  admin.password = password;
  await admin.save();
  return admin;
}

// A moderator as the old seeder created one: default permission flags only.
const createModerator = (overrides) => createAdmin({ role: 'moderator', ...overrides });

module.exports = { createAdmin, createModerator, DEFAULT_PASSWORD };
