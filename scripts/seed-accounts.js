/**
 * Demo/production account seed — idempotent (upsert by email).
 *
 * Creates:
 *   - Super admin:        waleedhassansfd@gmail.com / Waleed@104
 *   - Outfitters vendor:  vendor.outfitters@metromatrix.pk / 123456 (approved)
 *   - 3 dummy customers:  user1|user2|user3@metromatrix.pk / 123456
 *
 * Passwords are set through the models so the pre-save bcrypt hooks run.
 * Run: node scripts/seed-accounts.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Admin = require('../src/models/Admin');
const User = require('../src/models/User');
const Provider = require('../src/models/Provider');
const WalletService = require('../src/services/walletService');

const log = (msg) => console.log(`  ${msg}`);

async function upsertAdmin() {
  const email = 'waleedhassansfd@gmail.com';
  let admin = await Admin.findOne({ email }).select('+password');
  if (!admin) {
    admin = new Admin({
      email,
      fullName: 'Waleed Hassan',
      role: 'super_admin',
      isSuperAdmin: true,
      isActive: true,
    });
    log(`admin created: ${email}`);
  } else {
    log(`admin exists: ${email} (password + permissions refreshed)`);
  }
  admin.password = 'Waleed@104'; // pre-save hook hashes it
  admin.isSuperAdmin = true;
  admin.isActive = true;
  admin.permissions = {
    ...(admin.permissions ? admin.permissions.toObject() : {}),
    canManageShopping: true,
    canManageSettings: true,
    canApproveProviders: true,
    canViewAnalytics: true,
  };
  await admin.save();
}

async function upsertVendor() {
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
  vendor.password = '123456';
  vendor.providerType = 'vendor';
  vendor.emailVerified = 'active';
  vendor.adminVerified = 'active';
  vendor.isActive = true;
  await vendor.save();
}

async function upsertUsers() {
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
    user.password = '123456';
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
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected\n=== Account seed ===');
  await upsertAdmin();
  await upsertVendor();
  await upsertUsers();
  console.log('=== Done ===');
  console.log('Logins:');
  console.log('  admin:  waleedhassansfd@gmail.com / Waleed@104');
  console.log('  vendor: vendor.outfitters@metromatrix.pk / 123456');
  console.log('  users:  user1|user2|user3@metromatrix.pk / 123456');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Account seed failed:', err);
  process.exit(1);
});
