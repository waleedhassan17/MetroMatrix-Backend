require('dotenv').config();
const mongoose = require('mongoose');
const WalletService = require('../src/services/walletService');
const WalletTransaction = require('../src/models/WalletTransaction');
const User = require('../src/models/User');
const Provider = require('../src/models/Provider');

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✓ MongoDB Connected');
  } catch (error) {
    console.error('✗ MongoDB connection failed:', error.message);
    process.exit(1);
  }
};

// Main smoke test
const runSmokeTest = async () => {
  console.log('\n=== Wallet Smoke Test ===\n');

  // Step 1: Get or create test User
  let user = await User.findOne({ email: 'smoke-test@example.com' });
  if (!user) {
    console.log('Creating test user...');
    user = await User.create({
      email: 'smoke-test@example.com',
      password: 'password123',
      fullName: 'Smoke Test User',
      phoneNumber: '1234567890',
      isActive: true,
    });
    console.log('✓ Test user created');
  } else {
    console.log('✓ Using existing test user');
  }

  // Step 2: Get or create test Provider
  let provider = await Provider.findOne({ email: 'smoke-provider@example.com' });
  if (!provider) {
    console.log('Creating test provider...');
    provider = await Provider.create({
      email: 'smoke-provider@example.com',
      password: 'password123',
      fullName: 'Smoke Test Provider',
      phoneNumber: '0987654321',
      providerType: 'home_service',
      isActive: true,
    });
    console.log('✓ Test provider created');
  } else {
    console.log('✓ Using existing test provider');
  }

  // Step 3: Get or create wallets for both
  console.log('\n--- Getting/Creating Wallets ---');
  const userWallet = await WalletService.getOrCreateWallet(user._id, 'User');
  console.log(`✓ User wallet: balance = $${userWallet.balance.toFixed(2)}`);

  const providerWallet = await WalletService.getOrCreateWallet(provider._id, 'Provider');
  console.log(`✓ Provider wallet: balance = $${providerWallet.balance.toFixed(2)}`);

  // Step 4: Apply top-up with mock Stripe session
  console.log('\n--- Applying Top-Up (First Time) ---');
  const mockSession = {
    id: 'cs_test_smoke_1',
    amount_total: 5000, // $50.00 in cents
    payment_intent: 'pi_smoke',
    metadata: {
      ownerId: String(user._id),
      ownerType: 'User',
      amount: '50',
    },
  };

  const result1 = await WalletService.applyTopUp(mockSession);
  console.log(`✓ Top-up applied: new balance = $${result1.wallet.balance.toFixed(2)}`);
  console.log(`✓ Transaction status: ${result1.transaction.status}`);

  // Step 5: Print last 3 transactions
  console.log('\n--- Last 3 Transactions ---');
  const { transactions } = await WalletService.getWalletWithTransactions(user._id, 'User', { limit: 3 });
  transactions.forEach((tx, i) => {
    console.log(`  ${i + 1}. ${tx.type.toUpperCase()} - $${tx.amount.toFixed(2)} - ${tx.status} - ${tx.source}`);
  });

  // Step 6: Re-run applyTopUp with SAME session id (idempotency test)
  console.log('\n--- Testing Idempotency (Same Session ID) ---');
  const result2 = await WalletService.applyTopUp(mockSession);
  console.log(`✓ Re-ran with same session id`);
  console.log(`✓ Balance after duplicate: $${result2.wallet.balance.toFixed(2)}`);

  if (result1.wallet.balance === result2.wallet.balance) {
    console.log('✓ Idempotency verified: balance did NOT double');
  } else {
    console.log('✗ Idempotency FAILED: balance changed!');
  }

  // Step 7: Print final wallet state
  console.log('\n--- Final Wallet States ---');
  console.log(`User wallet balance: $${result2.wallet.balance.toFixed(2)}`);
  const providerWalletFinal = await WalletService.getOrCreateWallet(provider._id, 'Provider');
  console.log(`Provider wallet balance: $${providerWalletFinal.balance.toFixed(2)}`);

  console.log('\n=== Smoke Test Complete ===\n');
};

// Run test and cleanup
const main = async () => {
  try {
    await connectDB();
    await runSmokeTest();
  } catch (error) {
    console.error('✗ Smoke test failed:', error.message);
    console.error(error);
  } finally {
    await mongoose.disconnect();
    console.log('✓ MongoDB Disconnected');
    process.exit(0);
  }
};

main();
