// src/models/CallLog.js
const mongoose = require('mongoose');

const CallLogSchema = new mongoose.Schema(
  {
    callerId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: 'callerType',
    },
    callerType: {
      type: String,
      enum: ['User', 'Provider'],
      required: true,
    },
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: 'receiverType',
    },
    receiverType: {
      type: String,
      enum: ['User', 'Provider'],
      required: true,
    },
    channelName: {
      type: String,
      required: true, // Agora channel name
    },
    status: {
      type: String,
      enum: ['initiated', 'ringing', 'accepted', 'rejected', 'missed', 'ended', 'failed'],
      default: 'initiated',
    },
    startedAt: {
      type: Date,
      default: null,
    },
    endedAt: {
      type: Date,
      default: null,
    },
    durationSeconds: {
      type: Number,
      default: 0,
    },
    serviceType: {
      type: String,
      enum: ['electricians', 'plumbers', 'ac-repairers', 'general'],
      default: 'general',
    },
  },
  { timestamps: true }
);

CallLogSchema.index({ callerId: 1, createdAt: -1 });
CallLogSchema.index({ receiverId: 1, createdAt: -1 });

module.exports = mongoose.model('CallLog', CallLogSchema);
