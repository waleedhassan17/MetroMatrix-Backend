const mongoose = require('mongoose');

const videoCallSchema = new mongoose.Schema(
  {
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Appointment',
      required: [true, 'Appointment reference is required'],
      unique: true,
    },
    roomId: {
      type: String,
      required: [true, 'Room ID is required'],
      unique: true,
    },
    status: {
      type: String,
      enum: ['waiting', 'active', 'ended'],
      default: 'waiting',
    },
    startedAt: {
      type: Date,
      default: null,
    },
    endedAt: {
      type: Date,
      default: null,
    },
    duration: {
      type: Number,
      default: null,
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
videoCallSchema.index({ appointmentId: 1 }, { unique: true });
videoCallSchema.index({ roomId: 1 }, { unique: true });
videoCallSchema.index({ status: 1 });

module.exports = mongoose.model('VideoCall', videoCallSchema);
