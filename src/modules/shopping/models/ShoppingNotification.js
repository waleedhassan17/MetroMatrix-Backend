const mongoose = require('mongoose');

/**
 * Shopping notifications — the order inbox for customers and vendors.
 *
 * Shopping used to have none: an order confirmed, shipped, delivered or
 * cancelled told nobody, and a vendor learned of a new order only by opening
 * their order list. Same shape as the home-service HSNotification: the
 * recipient is polymorphic (a User for the customer, the brand owner's
 * Provider for the vendor) and `recipientRole` says which.
 */
const shoppingNotificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, required: true },
    recipientRole: { type: String, enum: ['user', 'vendor'], required: true },
    type: {
      type: String,
      enum: [
        'order_placed', // customer: your order went through
        'order_created', // vendor: a new order for your brand
        'order_update', // customer: confirmed / shipped / out for delivery / delivered / returned / refunded
        'order_cancelled',
        'return_requested', // vendor: a customer asked to return items
        'product_moderation', // vendor: a product was approved / rejected / removed
      ],
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, required: true },
    /** Routing payload — { orderId, odexId, status, ... }. */
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    isRead: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
  },
  { collection: 'shoppingnotifications', timestamps: { createdAt: true, updatedAt: false } }
);

shoppingNotificationSchema.index({ recipient: 1, createdAt: -1 });
shoppingNotificationSchema.index({ recipient: 1, isRead: 1 });

module.exports =
  mongoose.models.ShoppingNotification || mongoose.model('ShoppingNotification', shoppingNotificationSchema);
