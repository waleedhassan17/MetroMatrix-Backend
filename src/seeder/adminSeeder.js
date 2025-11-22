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

    // Check if admin already exists
    const existingAdmin = await Admin.findOne({ email: 'waleedhassansfd@gmail.com' });

    if (existingAdmin) {
      console.log('⚠️  Admin user already exists!'.yellow);
      console.log('Email:', existingAdmin.email);
      console.log('To reset password, please use the password reset feature.\n'.yellow);
      process.exit(0);
    }

    // Create super admin
    const superAdmin = await Admin.create({
      email: 'waleedhassansfd@gmail.com',
      password: 'Waleed@107', // CHANGE THIS IMMEDIATELY AFTER FIRST LOGIN!
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

    console.log('✅ Super Admin created successfully!'.green.bold);
    console.log('\n📧 Admin Credentials:'.cyan.bold);
    console.log('Email:'.cyan, 'admin@metromatrix.com'.white);
    console.log('Password:'.cyan, 'Admin@123456'.white);
    console.log('\n⚠️  IMPORTANT:'.yellow.bold, 'Change this password immediately after first login!\n'.yellow);

    // Create additional admin (optional)
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

    console.log('✅ Moderator Admin created successfully!'.green);
    console.log('\n📧 Moderator Credentials:'.cyan.bold);
    console.log('Email:'.cyan, 'moderator@metromatrix.com'.white);
    console.log('Password:'.cyan, 'Moderator@123456'.white);
    console.log('\n⚠️  IMPORTANT:'.yellow.bold, 'Change this password immediately after first login!\n'.yellow);

    console.log('\n🎉 Admin seeding completed!'.green.bold);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding admin:'.red, error.message);
    process.exit(1);
  }
};

// Run seeder
seedAdmin();