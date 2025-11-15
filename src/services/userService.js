const User = require('../models/User');
const Post = require('../models/Post');
const { deleteFile } = require('../config/cloudinary');

class UserService {
  // Get user with sanitized data
  static async getUserData(userId) {
    const user = await User.findById(userId).select('-password -refreshToken -resetPasswordToken -emailVerificationToken');
    if (!user) {
      throw new Error('User not found');
    }
    return user.toJSON();
  }

  // Update user profile
  static async updateProfile(userId, updateData) {
    const user = await User.findById(userId);

    if (!user) {
      throw new Error('User not found');
    }

    // Allowed fields for update
    const allowedFields = [
      'fullName',
      'phoneNumber',
      'dateOfBirth',
      'gender',
      'address',
      'preferences',
    ];

    // Update only allowed fields
    allowedFields.forEach((field) => {
      if (updateData[field] !== undefined) {
        if (typeof updateData[field] === 'object' && user[field] && typeof user[field] === 'object') {
          user[field] = { ...user[field], ...updateData[field] };
        } else {
          user[field] = updateData[field];
        }
      }
    });

    // Check profile completion
    user.checkProfileComplete();
    await user.save();

    return user.toJSON();
  }

  // Complete profile step
  static async completeProfileStep(userId, step, data) {
    const user = await User.findById(userId);

    if (!user) {
      throw new Error('User not found');
    }

    switch (step) {
      case 1:
        // Personal information
        if (!data.dateOfBirth || !data.gender) {
          throw new Error('Date of birth and gender are required');
        }
        user.dateOfBirth = new Date(data.dateOfBirth);
        user.gender = data.gender;
        user.profileCompletionStep = Math.max(user.profileCompletionStep, 1);
        break;

      case 2:
        // Location information
        if (!data.address || !data.address.city) {
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
        // Final step
        user.profileCompletionStep = 3;
        break;

      default:
        throw new Error('Invalid step');
    }

    user.checkProfileComplete();
    await user.save();

    return {
      profileComplete: user.profileComplete,
      profileCompletionStep: user.profileCompletionStep,
      nextStep: user.profileComplete ? null : user.profileCompletionStep + 1,
    };
  }

  // Upload profile photo
  static async uploadProfilePhoto(userId, fileData) {
    const user = await User.findById(userId);

    if (!user) {
      throw new Error('User not found');
    }

    // Delete old photo if exists
    if (user.profilePhotoId) {
      try {
        await deleteFile(user.profilePhotoId);
      } catch (error) {
        console.error('Error deleting old photo:', error);
      }
    }

    // Update profile photo
    user.profilePhoto = fileData.path;
    user.profilePhotoId = fileData.filename;

    // Update profile completion if in step 2
    if (user.profileCompletionStep === 2) {
      user.profileCompletionStep = 3;
      user.checkProfileComplete();
    }

    await user.save();

    return {
      profilePhoto: user.profilePhoto,
      profileComplete: user.profileComplete,
    };
  }

  // Update preferences
  static async updatePreferences(userId, preferences) {
    const user = await User.findById(userId);

    if (!user) {
      throw new Error('User not found');
    }

    if (preferences.notifications !== undefined) {
      user.preferences.notifications = preferences.notifications;
    }
    if (preferences.newsletter !== undefined) {
      user.preferences.newsletter = preferences.newsletter;
    }
    if (preferences.language) {
      user.preferences.language = preferences.language;
    }
    if (preferences.theme) {
      user.preferences.theme = preferences.theme;
    }

    await user.save();

    return user.preferences;
  }

  // Deactivate account (soft delete)
  static async deleteAccount(userId, password) {
    const user = await User.findById(userId).select('+password');

    if (!user) {
      throw new Error('User not found');
    }

    // Verify password if user has one (not social login)
    if (user.password) {
      const isPasswordMatch = await user.matchPassword(password);
      if (!isPasswordMatch) {
        throw new Error('Incorrect password');
      }
    }

    // Delete profile photo
    if (user.profilePhotoId) {
      try {
        await deleteFile(user.profilePhotoId);
      } catch (error) {
        console.error('Error deleting profile photo:', error);
      }
    }

    // Soft delete user
    user.isActive = false;
    user.email = `deleted_${user._id}_${Date.now()}@deleted.com`;
    user.phoneNumber = `deleted_${user._id}`;

    await user.save();

    return { success: true, message: 'Account deleted successfully' };
  }

  // Get user statistics
  static async getUserStats(userId) {
    const user = await User.findById(userId);

    if (!user) {
      throw new Error('User not found');
    }

    const totalPosts = await Post.countDocuments({ author: userId, authorType: 'User' });
    const totalComments = await Post.aggregate([
      {
        $match: { 'comments': { $exists: true } },
      },
      {
        $group: {
          _id: null,
          count: { $sum: { $size: '$comments' } },
        },
      },
    ]);

    return {
      totalPosts,
      totalComments: totalComments[0]?.count || 0,
      profileComplete: user.profileComplete,
      isVerified: user.isVerified,
      createdAt: user.createdAt,
    };
  }

  // Search users (admin)
  static async searchUsers(query, page = 1, limit = 10) {
    const skip = (page - 1) * limit;

    const searchQuery = {
      isActive: true,
      ...(query && {
        $or: [
          { fullName: { $regex: query, $options: 'i' } },
          { email: { $regex: query, $options: 'i' } },
        ],
      }),
    };

    const total = await User.countDocuments(searchQuery);
    const users = await User.find(searchQuery)
      .select('-password -refreshToken')
      .sort('-createdAt')
      .limit(limit)
      .skip(skip);

    return {
      users: users.map((u) => u.toJSON()),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Check if user is adult
  static isUserAdult(dateOfBirth) {
    const birthDate = new Date(dateOfBirth);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }

    return age >= 18;
  }

  // Get user age
  static getUserAge(dateOfBirth) {
    const birthDate = new Date(dateOfBirth);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }

    return age;
  }
}

module.exports = UserService;