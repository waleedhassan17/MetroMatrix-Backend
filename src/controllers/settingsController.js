const asyncHandler = require('express-async-handler');
const AdminSettings = require('../models/AdminSettings');

// @desc    Get all admin settings
// @route   GET /api/admin/settings
// @access  Private/Admin
const getSettings = asyncHandler(async (req, res) => {
  const settings = await AdminSettings.getSettings();
  
  res.json({
    success: true,
    settings: {
      general: {
        appName: settings.general.platformName || 'MetroMatrix',
        appVersion: '1.0.0',
        platformName: settings.general.platformName,
        contactEmail: settings.general.contactEmail,
        supportPhone: settings.general.supportPhone,
        autoApproveProviders: settings.general.autoApproveProviders,
        requireEmailVerification: settings.general.requireEmailVerification,
        maintenanceMode: settings.general.maintenanceMode,
        maintenanceMessage: '',
      },
      notifications: {
        emailNotifications: settings.notifications.emailNotifications,
        pushNotifications: settings.notifications.pushNotifications,
        smsNotifications: false,
        notifyOnNewProvider: settings.notifications.providerRegistrations,
        notifyOnNewUser: settings.notifications.userRegistrations,
        dailyDigest: false,
        providerRegistrations: settings.notifications.providerRegistrations,
        userRegistrations: settings.notifications.userRegistrations,
        systemAlerts: settings.notifications.systemAlerts,
        weeklyReports: settings.notifications.weeklyReports,
      },
      providers: {
        autoApproveProviders: settings.general.autoApproveProviders,
        requireDocumentVerification: true,
        maxPendingDays: 7,
        allowedProviderTypes: ['doctor', 'home_service', 'vendor'],
      },
      security: {
        sessionTimeout: settings.security.sessionTimeout,
        maxLoginAttempts: settings.security.maxLoginAttempts,
        requireTwoFactor: false,
        twoFactorEnabled: settings.security.twoFactorEnabled,
        passwordMinLength: 8,
        passwordExpiry: settings.security.passwordExpiry,
      },
      appearance: {
        theme: settings.appearance.theme,
        primaryColor: settings.appearance.primaryColor,
      },
    },
  });
});

// @desc    Update general settings
// @route   PUT /api/admin/settings/general
// @access  Private/Admin (with permission)
const updateGeneralSettings = asyncHandler(async (req, res) => {
  // Check permission
  if (!req.user.permissions.canManageSettings && !req.user.isSuperAdmin) {
    res.status(403);
    throw new Error('You do not have permission to manage settings');
  }
  
  const {
    platformName,
    contactEmail,
    supportPhone,
    timezone,
    language,
    autoApproveProviders,
    requireEmailVerification,
    maintenanceMode,
  } = req.body;
  
  const updateData = {};
  if (platformName !== undefined) updateData.platformName = platformName;
  if (contactEmail !== undefined) updateData.contactEmail = contactEmail;
  if (supportPhone !== undefined) updateData.supportPhone = supportPhone;
  if (timezone !== undefined) updateData.timezone = timezone;
  if (language !== undefined) updateData.language = language;
  if (autoApproveProviders !== undefined) updateData.autoApproveProviders = autoApproveProviders;
  if (requireEmailVerification !== undefined) updateData.requireEmailVerification = requireEmailVerification;
  if (maintenanceMode !== undefined) updateData.maintenanceMode = maintenanceMode;
  
  const settings = await AdminSettings.updateSettings('general', updateData, req.user._id);
  
  // Log activity
  req.user.logActivity('update_settings', settings._id, 'AdminSettings', 
    'Updated general settings');
  await req.user.save();
  
  res.json({
    success: true,
    message: 'General settings updated successfully',
    data: settings.general,
  });
});

// @desc    Get notification settings
// @route   GET /api/admin/settings/notifications
// @access  Private/Admin
const getNotificationSettings = asyncHandler(async (req, res) => {
  const settings = await AdminSettings.getSettings();
  
  res.json({
    success: true,
    data: settings.notifications,
  });
});

// @desc    Update notification settings
// @route   PUT /api/admin/settings/notifications
// @access  Private/Admin
const updateNotificationSettings = asyncHandler(async (req, res) => {
  const {
    emailNotifications,
    pushNotifications,
    providerRegistrations,
    userRegistrations,
    systemAlerts,
    weeklyReports,
  } = req.body;
  
  const updateData = {};
  if (emailNotifications !== undefined) updateData.emailNotifications = emailNotifications;
  if (pushNotifications !== undefined) updateData.pushNotifications = pushNotifications;
  if (providerRegistrations !== undefined) updateData.providerRegistrations = providerRegistrations;
  if (userRegistrations !== undefined) updateData.userRegistrations = userRegistrations;
  if (systemAlerts !== undefined) updateData.systemAlerts = systemAlerts;
  if (weeklyReports !== undefined) updateData.weeklyReports = weeklyReports;
  
  const settings = await AdminSettings.updateSettings('notifications', updateData, req.user._id);
  
  // Log activity
  req.user.logActivity('update_settings', settings._id, 'AdminSettings', 
    'Updated notification settings');
  await req.user.save();
  
  res.json({
    success: true,
    message: 'Notification settings updated successfully',
    data: settings.notifications,
  });
});

// @desc    Update security settings
// @route   PUT /api/admin/settings/security
// @access  Private/Admin (Super Admin only)
const updateSecuritySettings = asyncHandler(async (req, res) => {
  // Check permission
  if (!req.user.isSuperAdmin) {
    res.status(403);
    throw new Error('Only super admins can update security settings');
  }
  
  const {
    twoFactorEnabled,
    sessionTimeout,
    maxLoginAttempts,
    passwordExpiry,
    ipWhitelist,
  } = req.body;
  
  const updateData = {};
  if (twoFactorEnabled !== undefined) updateData.twoFactorEnabled = twoFactorEnabled;
  if (sessionTimeout !== undefined) updateData.sessionTimeout = sessionTimeout;
  if (maxLoginAttempts !== undefined) updateData.maxLoginAttempts = maxLoginAttempts;
  if (passwordExpiry !== undefined) updateData.passwordExpiry = passwordExpiry;
  if (ipWhitelist !== undefined) updateData.ipWhitelist = ipWhitelist;
  
  const settings = await AdminSettings.updateSettings('security', updateData, req.user._id);
  
  // Log activity
  req.user.logActivity('update_settings', settings._id, 'AdminSettings', 
    'Updated security settings');
  await req.user.save();
  
  res.json({
    success: true,
    message: 'Security settings updated successfully',
    data: settings.security,
  });
});

// @desc    Update appearance settings
// @route   PUT /api/admin/settings/appearance
// @access  Private/Admin
const updateAppearanceSettings = asyncHandler(async (req, res) => {
  const {
    theme,
    primaryColor,
    accentColor,
    compactMode,
  } = req.body;
  
  const updateData = {};
  if (theme !== undefined) updateData.theme = theme;
  if (primaryColor !== undefined) updateData.primaryColor = primaryColor;
  if (accentColor !== undefined) updateData.accentColor = accentColor;
  if (compactMode !== undefined) updateData.compactMode = compactMode;
  
  const settings = await AdminSettings.updateSettings('appearance', updateData, req.user._id);
  
  res.json({
    success: true,
    message: 'Appearance settings updated successfully',
    data: settings.appearance,
  });
});

module.exports = {
  getSettings,
  updateGeneralSettings,
  getNotificationSettings,
  updateNotificationSettings,
  updateSecuritySettings,
  updateAppearanceSettings,
};
