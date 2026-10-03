/**
 * Demo account seed — idempotent (upsert by email).
 *
 * Creates:
 *   - Outfitters vendor:  vendor.outfitters@metromatrix.pk (approved)
 *   - 3 dummy customers:  user1|user2|user3@metromatrix.pk
 *
 * Every account gets SEED_DEMO_PASSWORD (never printed). Admins are NOT seeded
 * here — use `npm run seed:admin`, which reads its credentials from the
 * environment and forces a password change on first sign-in.
 *
 * Passwords are set through the models so the pre-save bcrypt hooks run.
 * Run: SEED_DEMO_PASSWORD=… node scripts/seed-accounts.js --confirm-db=<db name>
 */
require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../src/models/User');
const Provider = require('../src/models/Provider');
const WalletService = require('../src/services/walletService');
const { assertSafeSeedTarget, demoPassword } = require('./lib/seedSafety');

const log = (msg) => console.log(`  ${msg}`);

async function upsertVendor(password) {
  const email = 'vendor.outfitters@metromatrix.pk';
  let vendor = await Provider.findOne({ email }).select('+password');
  if (!vendor) {
    vendor = new Provider({
      email,
      fullName: 'Ahmed Raza',
      phoneNumber: '03001234501',
      providerType: 'vendor',
      category: 'retail',
    });
    log(`vendor created: ${email}`);
  } else {
    log(`vendor exists: ${email} (password refreshed)`);
  }
  vendor.password = password;
  vendor.providerType = 'vendor';
  vendor.emailVerified = 'active';
  vendor.adminVerified = 'active';
  vendor.isActive = true;
  await vendor.save();
}

async function upsertUsers(password) {
  const USERS = [
    { email: 'user1@metromatrix.pk', fullName: 'Ali Hamza', phoneNumber: '03005550101' },
    { email: 'user2@metromatrix.pk', fullName: 'Zara Ahmed', phoneNumber: '03005550102' },
    { email: 'user3@metromatrix.pk', fullName: 'Bilal Shah', phoneNumber: '03005550103' },
  ];
  for (const spec of USERS) {
    let user = await User.findOne({ email: spec.email }).select('+password');
    if (!user) {
      user = new User({ ...spec, isActive: true, isEmailVerified: true });
      log(`user created: ${spec.email}`);
    } else {
      log(`user exists: ${spec.email} (password refreshed)`);
    }
    user.password = password;
    user.isActive = true;
    await user.save();

    // Small wallet balance so demo checkouts work
    const wallet = await WalletService.getOrCreateWallet(user._id, 'User');
    if (wallet.balance < 20000) {
      const amount = 50000 - wallet.balance;
      await wallet.credit(amount);
      await WalletService.recordTransaction(wallet._id, {
        type: 'credit',
        amount,
        description: 'Seed top-up for demo account',
        source: 'admin_adjustment',
        status: 'completed',
      });
    }
  }
}

async function main() {
  assertSafeSeedTarget();
  const password = demoPassword();
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected\n=== Account seed ===');
  await upsertVendor(password);
  await upsertUsers(password);
  console.log('=== Done ===');
  console.log('Logins (password: SEED_DEMO_PASSWORD):');
  console.log('  vendor: vendor.outfitters@metromatrix.pk');
  console.log('  users:  user1|user2|user3@metromatrix.pk');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Account seed failed:', err);
  process.exit(1);
});
