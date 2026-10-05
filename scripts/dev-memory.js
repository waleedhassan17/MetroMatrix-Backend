/**
 * The API on a throwaway in-memory MongoDB replica set — for running the app,
 * or the app's admin end-to-end test, against a real backend with nothing
 * shared and nothing persisted.
 *
 *   DEV_ADMIN_PASSWORD=<10+ chars> node scripts/dev-memory.js
 *   (optional) DEV_ADMIN_EMAIL=admin@example.com  PORT=5055  JWT_EXPIRE=1m
 *              DEV_ADMIN_READY=1   skip the forced password change
 *
 * Isolation, on purpose:
 *  - the local .env is NOT loaded (dotenv is stubbed before the app loads), so
 *    no real mail, payment or storage credentials reach this process;
 *  - JWT / refresh / cron / TOTP secrets are random for each run;
 *  - the database lives in memory and is gone when the process exits.
 * The admin password comes from the environment and is never printed.
 *
 * Seeds: one super admin (must change the password at first sign-in unless
 * DEV_ADMIN_READY=1), a customer, a provider waiting for review, a paid
 * home-service booking (for refunds), and an approved doctor and vendor with a
 * completed consultation and a delivered order (for provider analytics).
 */
const crypto = require('crypto');

// Stub dotenv first: every later `require('dotenv').config()` becomes a no-op.
const dotenv = require('dotenv');
dotenv.config = () => ({ parsed: {} });

const random = () => crypto.randomBytes(32).toString('hex');

async function main() {
  const email = (process.env.DEV_ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const password = process.env.DEV_ADMIN_PASSWORD;
  if (!password || password.length < 10) {
    console.error('Set DEV_ADMIN_PASSWORD (at least 10 characters) for the seeded super admin.');
    process.exit(1);
  }

  const { MongoMemoryReplSet } = require('mongodb-memory-server');
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = replSet.getUri('metromatrix_dev');

  Object.assign(process.env, {
    NODE_ENV: 'development',
    MONGODB_URI: uri,
    JWT_SECRET: random(),
    REFRESH_TOKEN_SECRET: random(),
    CRON_SECRET: random(),
    TOTP_ENC_KEY: crypto.randomBytes(32).toString('base64'),
    JWT_EXPIRE: process.env.JWT_EXPIRE || '15m',
    DISABLE_RATE_LIMIT: 'true',
  });
  const port = Number(process.env.PORT || 5055);

  require('../src/config/validateEnv')();
  const mongoose = require('mongoose');
  await mongoose.connect(uri);
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));

  await seed({ email, password, ready: process.env.DEV_ADMIN_READY === '1' });

  const app = require('../src/app');
  const server = app.listen(port, () => {
    console.log(`dev-memory API on http://localhost:${port}/api  (admin: ${email})`);
  });

  const stop = async () => {
    server.close();
    await mongoose.disconnect();
    await replSet.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function seed({ email, password, ready }) {
  const mongoose = require('mongoose');
  const Admin = require('../src/models/Admin');
  const User = require('../src/models/User');
  const Provider = require('../src/models/Provider');
  const Booking = require('../src/modules/homeservice/models/Booking');

  const admin = new Admin({
    email,
    fullName: 'Local Super Admin',
    role: 'super_admin',
    isSuperAdmin: true,
    isActive: true,
    mustChangePassword: !ready,
    passwordChangedAt: new Date(),
  });
  admin.password = password;
  await admin.save();

  const throwaway = crypto.randomBytes(12).toString('base64url');
  const customer = await User.create({
    email: 'customer@example.com',
    fullName: 'Ayesha Customer',
    phoneNumber: '03001234567',
    password: throwaway,
    isActive: true,
  });
  const provider = await Provider.create({
    email: 'provider@example.com',
    fullName: 'Bilal Electrician',
    phoneNumber: '03007654321',
    password: throwaway,
    providerType: 'home_service',
    providerSubType: 'electrician',
    city: 'Lahore',
    isActive: true,
    verificationStatus: 'pending',
    submittedAt: new Date(Date.now() - 3 * 3600_000),
  });
  await Booking.create({
    customer: customer._id,
    provider: provider._id,
    serviceCategory: 'electricians',
    scheduledFor: new Date(Date.now() - 86_400_000),
    address: { line1: '12 Main Boulevard', city: 'Lahore' },
    status: 'COMPLETED',
    pricing: { estimatedPrice: 2500, finalPrice: 2500 },
    payment: { status: 'paid', method: 'wallet', requestedAmount: 2500, paidAt: new Date() },
  });

  // An approved doctor with one completed, paid consultation, and an approved
  // vendor whose brand has one delivered order — so provider analytics has
  // something to show for every kind of provider. Written straight to the
  // collections: these are fixtures, not flows under test.
  const Doctor = require('../src/modules/healthcare/models/Doctor');
  const Appointment = require('../src/modules/healthcare/models/Appointment');
  const Brand = require('../src/modules/shopping/models/Brand');
  const Order = require('../src/modules/shopping/models/Order');
  const day = 86_400_000;
  const doctorProvider = await Provider.create({
    email: 'doctor@example.com',
    fullName: 'Sana Physician',
    phoneNumber: '03001112233',
    password: throwaway,
    providerType: 'doctor',
    city: 'Lahore',
    isActive: true,
    verificationStatus: 'approved',
    approvedAt: new Date(Date.now() - 30 * day),
  });
  const doctor = await Doctor.collection.insertOne({
    providerId: doctorProvider._id,
    pmcNumber: 'DEV-12345',
    consultationFee: 2000,
    rating: 4.6,
    totalReviews: 5,
    verificationStatus: 'verified',
    isActive: true,
    isAvailable: true,
    createdAt: new Date(Date.now() - 30 * day),
  });
  await Appointment.collection.insertOne({
    patientId: customer._id,
    doctorId: doctor.insertedId,
    type: 'video',
    status: 'completed',
    fee: 2000,
    totalAmount: 2000,
    payment: { status: 'paid', method: 'wallet', amount: 2000, paidAt: new Date(Date.now() - 3 * day) },
    payout: { amount: 2000, commission: 0, paidAt: new Date(Date.now() - 2 * day) },
    completedAt: new Date(Date.now() - 2 * day),
    createdAt: new Date(Date.now() - 4 * day),
  });

  const vendor = await Provider.create({
    email: 'vendor@example.com',
    fullName: 'Usman Vendor',
    phoneNumber: '03004445566',
    password: throwaway,
    providerType: 'vendor',
    city: 'Karachi',
    isActive: true,
    verificationStatus: 'approved',
    approvedAt: new Date(Date.now() - 60 * day),
  });
  const brand = await Brand.collection.insertOne({
    odexId: 'BR-DEV-1',
    name: 'Dev Threads',
    slug: 'dev-threads',
    owner: vendor._id,
    status: 'active',
    isDeleted: false,
    createdAt: new Date(Date.now() - 60 * day),
  });
  await Order.collection.insertOne({
    odexId: 'OD-DEV-1',
    orderGroup: new mongoose.Types.ObjectId(),
    userId: customer._id,
    brandId: brand.insertedId,
    items: [
      {
        _id: new mongoose.Types.ObjectId(),
        productId: new mongoose.Types.ObjectId(),
        brandId: brand.insertedId,
        variantId: new mongoose.Types.ObjectId(),
        productName: 'Cotton Kurta',
        quantity: 2,
        unitPrice: 1800,
        totalPrice: 3600,
      },
    ],
    shippingAddress: { fullName: 'Ayesha Customer', phone: '03001234567', addressLine1: 'House 1', city: 'Lahore' },
    paymentMethod: 'wallet',
    paymentStatus: 'paid',
    orderStatus: 'delivered',
    subtotal: 3600,
    shippingFee: 150,
    total: 3750,
    vendorPayout: { amount: 3750, commission: 0, paidAt: new Date(Date.now() - day) },
    createdAt: new Date(Date.now() - 5 * day),
    deliveredAt: new Date(Date.now() - day),
  });
}

main().catch((err) => {
  console.error('dev-memory failed:', err.message);
  process.exit(1);
});
