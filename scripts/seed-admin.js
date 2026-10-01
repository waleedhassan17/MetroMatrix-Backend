/**
 * Bootstrap super-admin. Replaces src/seeder/adminSeeder.js, which hardcoded
 * a real email + password (and a moderator with a known password) in this
 * public repo and printed them to the console.
 *
 * Credentials come from the environment and the password is never printed:
 *   ADMIN_SEED_EMAIL      the super-admin's email
 *   ADMIN_SEED_PASSWORD   a temporary password (12+ characters)
 *   ADMIN_SEED_NAME       optional display name
 *
 * The account is created with mustChangePassword, so the first sign-in can do
 * nothing but set a new password. An existing admin with that email is left
 * untouched unless --reset-password is passed.
 *
 * Run: ADMIN_SEED_EMAIL=… ADMIN_SEED_PASSWORD=… npm run seed:admin -- --confirm-db=<db name>
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('../src/models/Admin');
const { assertSafeSeedTarget } = require('./lib/seedSafety');

const fail = (message) => {
  console.error(`\n✋ ${message}\n`);
  process.exit(1);
};

// Every permission flag the schema defines — new flags are picked up without
// editing this script.
const allPermissions = () =>
  Object.fromEntries(
    Object.keys(Admin.schema.paths)
      .filter((p) => p.startsWith('permissions.'))
      .map((p) => [p.slice('permissions.'.length), true])
  );

async function main() {
  const argv = process.argv.slice(2);
  assertSafeSeedTarget({ argv });

  const email = (process.env.ADMIN_SEED_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_SEED_PASSWORD || '';
  if (!email) fail('Set ADMIN_SEED_EMAIL.');
  if (password.length < 12) fail('Set ADMIN_SEED_PASSWORD (12+ characters). It is temporary — the first sign-in must change it.');

  await mongoose.connect(process.env.MONGODB_URI);

  const existing = await Admin.findOne({ email }).select('+password');
  if (existing && !argv.includes('--reset-password')) {
    console.log(`Admin ${email} already exists — nothing changed. Pass --reset-password to issue a new temporary password.`);
    await mongoose.disconnect();
    return;
  }

  const admin =
    existing ||
    new Admin({
      email,
      fullName: process.env.ADMIN_SEED_NAME || 'Super Administrator',
      role: 'super_admin',
      isSuperAdmin: true,
      isActive: true,
    });
  admin.password = password; // pre-save hook hashes it
  admin.mustChangePassword = true;
  admin.role = 'super_admin';
  admin.isSuperAdmin = true;
  admin.isActive = true;
  admin.permissions = allPermissions();
  await admin.save();

  console.log(
    existing
      ? `Super-admin ${email}: temporary password reset; a password change is required at next sign-in.`
      : `Super-admin ${email} created; a password change is required at first sign-in.`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Admin seed failed:', err.message);
  process.exit(1);
});
