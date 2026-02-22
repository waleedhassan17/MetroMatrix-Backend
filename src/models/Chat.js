// src/models/Chat.js
const mongoose = require('mongoose');

/**
 * Individual message schema (embedded within ChatRoom)
 */
const MessageSchema = new mongoose.Schema(
  {
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: 'senderType',
    },
    senderType: {
      type: String,
      enum: ['User', 'Provider'],
      required: true,
    },
    content: {
      type: String,
      required: true,
      maxlength: 2000,
    },
    type: {
      type: String,
      enum: ['text', 'image', 'location', 'call_log'],
      default: 'text',
    },
    mediaUrl: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ['sent', 'delivered', 'read'],
      default: 'sent',
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

/**
 * Chat room between a specific User and Provider.
 * One room per user-provider pair per service category.
 */
const ChatRoomSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    providerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Provider',
      required: true,
    },
    serviceType: {
      type: String,
      enum: ['electricians', 'plumbers', 'ac-repairers', 'general'],
      default: 'general',
    },
    messages: [MessageSchema],
    lastMessage: {
      type: String,
      default: '',
    },
    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
    lastMessageBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    unreadCountUser: {
      type: Number,
      default: 0,
    },
    unreadCountProvider: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Compound index to ensure one room per user-provider-service combo
ChatRoomSchema.index({ userId: 1, providerId: 1, serviceType: 1 }, { unique: true });
ChatRoomSchema.index({ lastMessageAt: -1 });

module.exports = mongoose.model('ChatRoom', ChatRoomSchema);
