const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema(
  {
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HSBooking',
      required: true,
    },
    sender: { type: mongoose.Schema.Types.ObjectId, required: true },
    senderRole: { type: String, enum: ['user', 'provider'], required: true },
    text: { type: String, required: true, maxlength: 2000 },
    attachments: [String],
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

chatMessageSchema.index({ booking: 1, createdAt: 1 });

module.exports = mongoose.model('HSChatMessage', chatMessageSchema);
