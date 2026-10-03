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

const phone = (n) => `0300${String(1000000 + n).slice(-7)}`;

async function createUser(overrides = {}) {
  const User = require('../../src/models/User');
  const n = next();
  return User.create({
    email: `user${n}@example.com`,
    fullName: `Test User ${n}`,
    phoneNumber: phone(n),
    password: DEFAULT_PASSWORD,
    isActive: true,
    ...overrides,
  });
}

async function createProvider(overrides = {}) {
  const Provider = require('../../src/models/Provider');
  const n = next();
  return Provider.create({
    email: `provider${n}@example.com`,
    fullName: `Test Provider ${n}`,
    phoneNumber: phone(n),
    password: DEFAULT_PASSWORD,
    providerType: 'home_service',
    providerSubType: 'electrician',
    isActive: true,
    ...overrides,
  });
}

async function createWallet(owner, ownerType, balance = 0) {
  const Wallet = require('../../src/models/Wallet');
  return Wallet.create({ owner: owner._id || owner, ownerType, balance });
}

module.exports = { createAdmin, createModerator, createUser, createProvider, createWallet, DEFAULT_PASSWORD };
