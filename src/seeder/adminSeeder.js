const mongoose = require('mongoose');
const colors = require('colors');
const dotenv = require('dotenv');
const Admin = require('../models/Admin');
const connectDB = require('../config/db');

// Load env vars
dotenv.config();

// Connect to database
connectDB();

/**
 * Seed initial admin user
 * Run with: node seeders/adminSeeder.js
 */
const seedAdmin = async () => {
  try {
    console.log('🌱 Seeding Admin User...'.cyan.bold);

    // YOUR EMAIL + PASSWORD
    const myEmail = 'waleedhassansfd@gmail.com';
    const myPassword = 'Waleed@107';

    // Check if your admin already exists
    const existingAdmin = await Admin.findOne({ email: myEmail });

    if (existingAdmin) {
      console.log('⚠️  Your Admin user already exists!'.yellow);
      console.log('Email:', existingAdmin.email);
      process.exit(0);
    }

    // Create **your** super admin
    const superAdmin = await Admin.create({
      email: myEmail,
      password: myPassword,
      fullName: 'Super Administrator',
      phoneNumber: '03124890176',
      role: 'super_admin',
      isSuperAdmin: true,
      permissions: {
        canApproveProviders: true,
        canManageUsers: true,
        canManagePosts: true,
        canViewAnalytics: true,
        canManageAdmins: true,
      },
    });

    console.log('✅ Your Super Admin was created successfully!'.green.bold);
    console.log('\n📧 Your Login Credentials:'.cyan.bold);
    console.log('Email:', myEmail.white);
    console.log('Password:', myPassword.white);

    // OPTIONAL — create moderator
    const admin = await Admin.create({
      email: 'moderator@metromatrix.com',
      password: 'Moderator@123456',
      fullName: 'Moderator Admin',
      phoneNumber: '0987654321',
      role: 'moderator',
      permissions: {
        canApproveProviders: true,
        canManageUsers: false,
        canManagePosts: true,
        canViewAnalytics: true,
        canManageAdmins: false,
      },
      createdBy: superAdmin._id,
    });

    console.log('✅ Optional Moderator Admin created!'.green);

    console.log('\n🎉 Admin seeding completed!'.green.bold);
    process.exit(0);

  } catch (error) {
    console.error('❌ Error seeding admin:'.red, error.message);
    process.exit(1);
  }
};

// Run seeder
seedAdmin();
