const mongoose = require('mongoose');

const hcNotificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
    },
    title: {
      type: String,
      required: [true, 'Title is required'],
    },
    message: {
      type: String,
      required: [true, 'Message is required'],
    },
    type: {
      type: String,
      enum: [
        'appointment_booked',
        'appointment_confirmed',
        'appointment_cancelled',
        'appointment_reminder',
        'prescription_ready',
        'video_call_starting',
      ],
      required: [true, 'Notification type is required'],
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

// Indexes
hcNotificationSchema.index({ userId: 1, createdAt: -1 });
hcNotificationSchema.index({ userId: 1, isRead: 1 });
hcNotificationSchema.index({ type: 1 });

module.exports = mongoose.model('HCNotification', hcNotificationSchema);
