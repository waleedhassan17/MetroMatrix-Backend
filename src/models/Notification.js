const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    // Target Admin (null for broadcast to all admins)
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
      index: true,
    },

    // Notification Type
    type: {
      type: String,
      enum: [
        'provider_registration',
        'provider_approved',
        'provider_rejected',
        'user_registration',
        'system_alert',
        'report',
        // Healthcare admin notifications
        'doctor_verification',
        'doctor_approved',
        'doctor_rejected',
      ],
      required: true,
      index: true,
    },

    // Content
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },

    // Additional Data
    data: {
      providerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Provider',
      },
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
      providerType: String,
      actionUrl: String,
      severity: {
        type: String,
        enum: ['info', 'warning', 'error', 'success'],
        default: 'info',
      },
    },

    // Status
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt
  }
);

// Indexes for performance
notificationSchema.index({ createdAt: -1 });
notificationSchema.index({ adminId: 1, isRead: 1 });
notificationSchema.index({ type: 1, createdAt: -1 });

// Static method to create notification
notificationSchema.statics.createNotification = async function (data) {
  return await this.create(data);
};

// Static method to get unread count for admin
notificationSchema.statics.getUnreadCount = async function (adminId = null) {
  const query = { isRead: false };
  if (adminId) {
    query.$or = [{ adminId }, { adminId: null }]; // Include broadcast notifications
  } else {
    query.adminId = null; // Only broadcast
  }
  return await this.countDocuments(query);
};

// Static method to mark all as read for admin
notificationSchema.statics.markAllAsRead = async function (adminId = null) {
  const query = { isRead: false };
  if (adminId) {
    query.$or = [{ adminId }, { adminId: null }];
  } else {
    query.adminId = null;
  }
  
  const result = await this.updateMany(
    query,
    { 
      $set: { 
        isRead: true, 
        readAt: new Date() 
      } 
    }
  );
  
  return result.modifiedCount;
};

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;
