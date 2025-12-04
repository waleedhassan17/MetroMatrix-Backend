const Notification = require('../models/Notification');
const AdminSettings = require('../models/AdminSettings');

/**
 * Notification Service
 * Handles automatic notification creation for admin panel events
 */

class NotificationService {
  /**
   * Create notification for provider registration
   */
  static async notifyProviderRegistration(provider) {
    try {
      const settings = await AdminSettings.getSettings();
      
      if (!settings.notifications.providerRegistrations) {
        return; // Notifications disabled for this event
      }
      
      await Notification.create({
        adminId: null, // Broadcast to all admins
        type: 'provider_registration',
        title: 'New Provider Registration',
        message: `${provider.fullName} has registered as a ${provider.providerType} and is awaiting approval.`,
        data: {
          providerId: provider._id,
          providerType: provider.providerType,
          actionUrl: `/admin/providers/${provider._id}`,
          severity: 'info',
        },
      });
      
      console.log(`✅ Notification created: Provider registration - ${provider.fullName}`);
    } catch (error) {
      console.error('Error creating provider registration notification:', error);
    }
  }
  
  /**
   * Create notification for provider approval
   */
  static async notifyProviderApproved(provider, admin) {
    try {
      await Notification.create({
        adminId: null, // Broadcast
        type: 'provider_approved',
        title: 'Provider Approved',
        message: `${provider.fullName} (${provider.providerType}) has been approved by ${admin.fullName}.`,
        data: {
          providerId: provider._id,
          providerType: provider.providerType,
          actionUrl: `/admin/providers/${provider._id}`,
          severity: 'success',
        },
      });
      
      console.log(`✅ Notification created: Provider approved - ${provider.fullName}`);
    } catch (error) {
      console.error('Error creating provider approval notification:', error);
    }
  }
  
  /**
   * Create notification for provider rejection
   */
  static async notifyProviderRejected(provider, admin, reason) {
    try {
      await Notification.create({
        adminId: null, // Broadcast
        type: 'provider_rejected',
        title: 'Provider Rejected',
        message: `${provider.fullName} (${provider.providerType}) has been rejected by ${admin.fullName}. Reason: ${reason}`,
        data: {
          providerId: provider._id,
          providerType: provider.providerType,
          actionUrl: `/admin/providers/${provider._id}`,
          severity: 'warning',
        },
      });
      
      console.log(`✅ Notification created: Provider rejected - ${provider.fullName}`);
    } catch (error) {
      console.error('Error creating provider rejection notification:', error);
    }
  }
  
  /**
   * Create notification for user registration
   */
  static async notifyUserRegistration(user) {
    try {
      const settings = await AdminSettings.getSettings();
      
      if (!settings.notifications.userRegistrations) {
        return; // Notifications disabled for this event
      }
      
      await Notification.create({
        adminId: null, // Broadcast
        type: 'user_registration',
        title: 'New User Registration',
        message: `${user.fullName} has registered on the platform.`,
        data: {
          userId: user._id,
          actionUrl: `/admin/users/${user._id}`,
          severity: 'info',
        },
      });
      
      console.log(`✅ Notification created: User registration - ${user.fullName}`);
    } catch (error) {
      console.error('Error creating user registration notification:', error);
    }
  }
  
  /**
   * Create system alert notification
   */
  static async notifySystemAlert(title, message, severity = 'warning') {
    try {
      const settings = await AdminSettings.getSettings();
      
      if (!settings.notifications.systemAlerts) {
        return; // Notifications disabled for this event
      }
      
      await Notification.create({
        adminId: null, // Broadcast
        type: 'system_alert',
        title,
        message,
        data: {
          severity,
        },
      });
      
      console.log(`✅ Notification created: System alert - ${title}`);
    } catch (error) {
      console.error('Error creating system alert notification:', error);
    }
  }
  
  /**
   * Create report notification
   */
  static async notifyReport(reportType, reportedId, reportedBy, reason) {
    try {
      await Notification.create({
        adminId: null, // Broadcast
        type: 'report',
        title: `New ${reportType} Report`,
        message: `A ${reportType} has been reported. Reason: ${reason}`,
        data: {
          providerId: reportType === 'provider' ? reportedId : null,
          userId: reportType === 'user' ? reportedId : null,
          severity: 'error',
          actionUrl: `/admin/${reportType}s/${reportedId}`,
        },
      });
      
      console.log(`✅ Notification created: Report - ${reportType}`);
    } catch (error) {
      console.error('Error creating report notification:', error);
    }
  }
}

module.exports = NotificationService;
