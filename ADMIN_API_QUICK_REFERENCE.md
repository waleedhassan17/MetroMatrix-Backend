# Admin Panel API - Quick Reference Guide

## Base URL
```
https://metromatrix-api-2e35f5f074df.herokuapp.com/api
```

## Authentication Header
```
Authorization: Bearer <access_token>
```

---

## 🔐 Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/admin/auth/login` | ❌ | Admin login |
| POST | `/admin/auth/logout` | ✅ | Admin logout |
| GET | `/admin/profile` | ✅ | Get admin profile |
| PUT | `/admin/profile` | ✅ | Update profile |
| PUT | `/admin/change-password` | ✅ | Change password |

---

## 📊 Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/dashboard/stats` | Full dashboard statistics |
| GET | `/admin/dashboard/quick-stats` | Real-time online/pending counts |

---

## 👨‍⚕️ Provider Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/providers` | List all providers (with filters) |
| GET | `/admin/providers/pending` | Get pending providers |
| GET | `/admin/providers/:providerId` | Get provider details |
| PUT | `/admin/providers/:providerId/approve` | Approve provider |
| PUT | `/admin/providers/:providerId/reject` | Reject provider (requires `reason`) |
| PUT | `/admin/providers/:providerId/activate` | Activate provider |
| PUT | `/admin/providers/:providerId/deactivate` | Deactivate provider |
| DELETE | `/admin/providers/:providerId` | Delete provider |

---

## 👥 User Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/users` | List all users (with filters) |
| GET | `/admin/users/:userId` | Get user details |
| PUT | `/admin/users/:userId/activate` | Activate user |
| PUT | `/admin/users/:userId/deactivate` | Deactivate user |
| DELETE | `/admin/users/:userId` | Delete user |

---

## 🔔 Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/notifications` | Get notifications (paginated) |
| GET | `/admin/notifications/unread-count` | Get unread count |
| PUT | `/admin/notifications/:notificationId/read` | Mark as read |
| PUT | `/admin/notifications/read-all` | Mark all as read |
| DELETE | `/admin/notifications/:notificationId` | Delete notification |
| DELETE | `/admin/notifications/clear-all` | Clear all |

---

## ⚙️ Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/settings` | Get all settings |
| PUT | `/admin/settings/general` | Update general settings |
| GET | `/admin/settings/notifications` | Get notification settings |
| PUT | `/admin/settings/notifications` | Update notification settings |
| PUT | `/admin/settings/security` | Update security settings (super admin) |
| PUT | `/admin/settings/appearance` | Update appearance settings |

---

## 🔍 Query Parameters

### Providers
```
?page=1&limit=15
&status=pending|approved|rejected|all
&providerType=doctor|home_service|vendor|all
&search=name|email|phone
&city=Lahore
&isActive=true|false
&sortBy=createdAt|fullName|email
&sortOrder=asc|desc
```

### Users
```
?page=1&limit=15
&search=name|email|phone
&isActive=true|false
&isVerified=true|false
&sortBy=createdAt|fullName
&sortOrder=asc|desc
```

### Notifications
```
?page=1&limit=20
&type=provider_registration|provider_approved|...
&isRead=true|false
```

---

## 📝 Request Body Examples

### Login
```json
POST /admin/auth/login
{
  "email": "admin@example.com",
  "password": "password"
}
```

### Approve Provider
```json
PUT /admin/providers/:id/approve
{
  "adminNotes": "All documents verified"
}
```

### Reject Provider
```json
PUT /admin/providers/:id/reject
{
  "reason": "Invalid medical license",
  "adminNotes": "License expired"
}
```

### Update General Settings
```json
PUT /admin/settings/general
{
  "platformName": "MetroMatrix Pro",
  "contactEmail": "admin@metromatrix.com",
  "autoApproveProviders": false,
  "maintenanceMode": false
}
```

---

## ✅ Response Format

### Success
```json
{
  "success": true,
  "message": "Operation successful",
  "data": { },
  "pagination": {
    "page": 1,
    "limit": 15,
    "total": 100,
    "pages": 7
  }
}
```

### Error
```json
{
  "success": false,
  "message": "Error message",
  "error": "ERROR_CODE"
}
```

---

## 🚨 Error Codes

| Code | Description |
|------|-------------|
| `INVALID_CREDENTIALS` | Invalid email or password |
| `ACCOUNT_DEACTIVATED` | Admin account deactivated |
| `TOKEN_EXPIRED` | JWT token expired |
| `INSUFFICIENT_PERMISSIONS` | Lacks required permissions |
| `RESOURCE_NOT_FOUND` | Resource doesn't exist |
| `VALIDATION_ERROR` | Input validation failed |

---

## 🎯 Status Values

### Provider Status (`adminVerified`)
- `pending` - Awaiting approval
- `active` - Approved
- `inactive` - Rejected

### Email Verification (`emailVerified`)
- `pending` - Not verified
- `active` - Verified
- `inactive` - Failed

### Notification Types
- `provider_registration`
- `provider_approved`
- `provider_rejected`
- `user_registration`
- `system_alert`
- `report`

---

## 🔑 Admin Permissions

```javascript
{
  canApproveProviders: true,
  canManageUsers: true,
  canManagePosts: true,
  canViewAnalytics: true,
  canManageSettings: true,
  canManageNotifications: true
}
```

---

## 📦 Database Collections

1. **Admin** - Admin users
2. **Provider** - Service providers
3. **User** - App users
4. **Notification** - Admin notifications
5. **AdminSettings** - Platform settings (singleton)
6. **Post** - User posts
7. **ProviderSubmission** - Provider applications

---

## 🔔 Auto-Generated Notifications

Notifications are automatically created for:
- ✅ New provider registration
- ✅ Provider approval
- ✅ Provider rejection
- ✅ New user registration (if enabled)
- ✅ System alerts (if enabled)

---

## 💡 Tips

1. Always check `success` field in response
2. Store tokens securely
3. Implement token refresh on 401
4. Poll quick-stats for real-time updates
5. Display unread notification count
6. Use pagination for large lists
7. Check permissions before showing UI elements

---

**Version:** v70  
**Status:** Production Ready ✅  
**Last Updated:** December 5, 2025
