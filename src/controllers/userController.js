const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const { deleteFile } = require('../config/cloudinary');

// @desc    Get user profile
// @route   GET /api/users/profile
// @access  Private
const getUserProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  res.json({
    success: true,
    user: {
      id: user._id,
      fullName: user.fullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      profilePhoto: user.profilePhoto,
      address: user.address,
      profileComplete: user.profileComplete,
      profileCompletionStep: user.profileCompletionStep,
      isVerified: user.isVerified,
      preferences: user.preferences,
      age: user.age,
      createdAt: user.createdAt,
    },
  });
});

// @desc    Update user profile
// @route   PUT /api/users/profile
// @access  Private
const updateUserProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  // Fields that can be updated
  const allowedUpdates = [
    'fullName',
    'phoneNumber',
    'dateOfBirth',
    'gender',
    'address',
    'preferences',
  ];

  // Update allowed fields
  allowedUpdates.forEach((field) => {
    if (req.body[field] !== undefined) {
      if (field === 'address' || field === 'preferences') {
        // For nested objects, merge with existing
        user[field] = { ...user[field], ...req.body[field] };
      } else {
        user[field] = req.body[field];
      }
    }
  });

  // Check if profile is complete
  user.checkProfileComplete();

  const updatedUser = await user.save();

  res.json({
    success: true,
    message: 'Profile updated successfully',
    user: updatedUser,
  });
});

// @desc    Complete profile (multi-step)
// @route   POST /api/users/complete-profile
// @access  Private
const completeProfile = asyncHandler(async (req, res) => {
  const { step, data } = req.body;
  const user = await User.findById(req.user.id);

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  switch (step) {
    case 1:
      // Personal Information
      if (!data.dateOfBirth || !data.gender) {
        res.status(400);
        throw new Error('Date of birth and gender are required');
      }

      user.dateOfBirth = data.dateOfBirth;
      user.gender = data.gender;
      user.profileCompletionStep = Math.max(user.profileCompletionStep, 1);
      break;

    case 2:
      // Location Information
      if (!data.address || !data.address.city) {
        res.status(400);
        throw new Error('City is required');
      }

      user.address = {
        street: data.address.street || '',
        city: data.address.city,
        postalCode: data.address.postalCode || '',
        country: data.address.country || 'Pakistan',
      };
      user.profileCompletionStep = Math.max(user.profileCompletionStep, 2);
      break;

    case 3:
      // Profile Photo (optional step)
      // Photo upload is handled separately via uploadProfilePhoto
      user.profileCompletionStep = 3;
      user.profileComplete = true;
      break;

    default:
      res.status(400);
      throw new Error('Invalid step number');
  }

  // Check if profile is complete
  user.checkProfileComplete();
  await user.save();

  res.json({
    success: true,
    message: `Profile step ${step} completed`,
    profileComplete: user.profileComplete,
    profileCompletionStep: user.profileCompletionStep,
    nextStep: user.profileComplete ? null : user.profileCompletionStep + 1,
    user: {
      id: user._id,
      fullName: user.fullName,
      email: user.email,
      phoneNumber: user.phoneNumber,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      address: user.address,
      profilePhoto: user.profilePhoto,
      profileComplete: user.profileComplete,
      profileCompletionStep: user.profileCompletionStep,
    },
  });
});

// @desc    Upload profile photo
// @route   POST /api/users/upload-photo
// @access  Private
const uploadProfilePhoto = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  if (!req.file) {
    res.status(400);
    throw new Error('Please upload a file');
  }

  // Delete old photo if exists
  if (user.profilePhotoId) {
    try {
      await deleteFile(user.profilePhotoId);
    } catch (error) {
      console.error('Error deleting old photo:', error);
    }
  }

  // Update user with new photo
  user.profilePhoto = req.file.path;
  user.profilePhotoId = req.file.filename;
  
  // If this is part of profile completion
  if (user.profileCompletionStep === 2) {
    user.profileCompletionStep = 3;
    user.checkProfileComplete();
  }

  await user.save();

  res.json({
    success: true,
    message: 'Profile photo uploaded successfully',
    profilePhoto: user.profilePhoto,
    profileComplete: user.profileComplete,
  });
});

// @desc    Update user preferences
// @route   PUT /api/users/preferences
// @access  Private
const updatePreferences = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  const { notifications, newsletter, language, theme } = req.body;

  if (notifications !== undefined) user.preferences.notifications = notifications;
  if (newsletter !== undefined) user.preferences.newsletter = newsletter;
  if (language) user.preferences.language = language;
  if (theme) user.preferences.theme = theme;

  await user.save();

  res.json({
    success: true,
    message: 'Preferences updated successfully',
    preferences: user.preferences,
  });
});

// @desc    Delete user account
// @route   DELETE /api/users/account
// @access  Private
const deleteAccount = asyncHandler(async (req, res) => {
  const { password } = req.body;
  const user = await User.findById(req.user.id).select('+password');

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  // Verify password if user has password (not social login)
  if (user.password) {
    const isPasswordMatch = await user.matchPassword(password);
    if (!isPasswordMatch) {
      res.status(401);
      throw new Error('Incorrect password');
    }
  }

  // Delete profile photo if exists
  if (user.profilePhotoId) {
    try {
      await deleteFile(user.profilePhotoId);
    } catch (error) {
      console.error('Error deleting profile photo:', error);
    }
  }

  // Soft delete - deactivate account
  user.isActive = false;
  user.email = `deleted_${user._id}@${user.email}`;
  user.phoneNumber = `deleted_${user.phoneNumber}`;
  await user.save();

  res.json({
    success: true,
    message: 'Account deleted successfully',
  });
});

// @desc    Get all users (Admin)
// @route   GET /api/users
// @access  Private/Admin
const getUsers = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const query = { isActive: true };

  // Search functionality
  if (req.query.search) {
    query.$or = [
      { fullName: { $regex: req.query.search, $options: 'i' } },
      { email: { $regex: req.query.search, $options: 'i' } },
    ];
  }

  const total = await User.countDocuments(query);
  const users = await User.find(query)
    .select('-refreshToken')
    .sort('-createdAt')
    .limit(limit)
    .skip(skip);

  res.json({
    success: true,
    users,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get user by ID (Admin)
// @route   GET /api/users/:id
// @access  Private/Admin
const getUserById = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('-refreshToken');

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  res.json({
    success: true,
    user,
  });
});

module.exports = {
  getUserProfile,
  updateUserProfile,
  completeProfile,
  uploadProfilePhoto,
  updatePreferences,
  deleteAccount,
  getUsers,
  getUserById,
};