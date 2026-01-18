# MetroMatrix Admin Panel API Guide

**Base URL:** `https://metromatrix-api-2e35f5f074df.herokuapp.com/api`  
**Version:** v74  
**Last Updated:** December 9, 2025

---

## Quick Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/admin/auth/login` | Admin login |
| POST | `/admin/auth/logout` | Admin logout |
| POST | `/admin/auth/refresh-token` | Refresh tokens |
| GET | `/admin/profile` | Get admin profile |
| PUT | `/admin/profile` | Update admin profile |
| PUT | `/admin/change-password` | Change password |
| GET | `/admin/dashboard/stats` | Dashboard statistics |
| GET | `/admin/dashboard/quick-stats` | Quick stats |
| GET | `/admin/dashboard/recent-registrations` | Recent registrations |
| GET | `/admin/users` | List all users |
| GET | `/admin/users/:id` | Get user details |
| PUT | `/admin/users/:id/activate` | Activate user |
| PUT | `/admin/users/:id/deactivate` | Deactivate user |
| DELETE | `/admin/users/:id` | Delete user |
| GET | `/admin/providers` | List all providers |
| GET | `/admin/providers/pending` | List pending providers |
| GET | `/admin/providers/:id` | Get provider details |
| PUT | `/admin/providers/:id/approve` | Approve provider |
| PUT | `/admin/providers/:id/reject` | Reject provider |
| PUT | `/admin/providers/:id/activate` | Activate provider |
| PUT | `/admin/providers/:id/deactivate` | Deactivate provider |
| DELETE | `/admin/providers/:id` | Delete provider |
| GET | `/admin/notifications` | List notifications |
| GET | `/admin/notifications/unread-count` | Get unread count |
| PUT | `/admin/notifications/:id/read` | Mark as read |
| PUT | `/admin/notifications/read-all` | Mark all as read |
| DELETE | `/admin/notifications/:id` | Delete notification |
| DELETE | `/admin/notifications/clear-all` | Clear all |
| GET | `/admin/settings` | Get all settings |
| PUT | `/admin/settings/general` | Update general settings |
| PUT | `/admin/settings/notifications` | Update notification settings |
| PUT | `/admin/settings/security` | Update security settings |
| PUT | `/admin/settings/appearance` | Update appearance settings |

---

## Authentication

All admin endpoints (except login) require:
```
Authorization: Bearer <accessToken>
```

---

## 1. Authentication APIs

### 1.1 Admin Login
```http
POST /admin/auth/login
Content-Type: application/json
```

**Request:**
```json
{
  "email": "admin@metromatrix.com",
  "password": "password123"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Login successful",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 86400,
  "admin": {
    "id": "admin_id",
    "_id": "admin_id",
    "email": "admin@metromatrix.com",
    "fullName": "Admin User",
    "role": "super_admin",
    "avatar": "https://cloudinary.com/avatar.jpg",
    "permissions": {
      "canApproveProviders": true,
      "canManageUsers": true,
      "canManagePosts": true,
      "canViewAnalytics": true,
      "canManageSettings": true,
      "canSendNotifications": true
    },
    "isActive": true,
    "lastLoginDate": "2025-12-09T10:30:00Z",
    "createdAt": "2025-01-01T00:00:00Z"
  }
}
```

**Errors:**
| Code | Error | Message |
|------|-------|---------|
| 401 | INVALID_CREDENTIALS | Invalid email or password |
| 403 | ACCOUNT_DEACTIVATED | Your admin account has been deactivated |

---

### 1.2 Admin Logout
```http
POST /admin/auth/logout
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

---

### 1.3 Refresh Token
```http
POST /admin/auth/refresh-token
Content-Type: application/json
```

**Request:**
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response (200):**
```json
{
  "success": true,
  "accessToken": "new_access_token",
  "refreshToken": "new_refresh_token"
}
```

---

### 1.4 Get Admin Profile
```http
GET /admin/profile
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "admin": {
    "id": "admin_id",
    "_id": "admin_id",
    "email": "admin@metromatrix.com",
    "fullName": "Admin User",
    "role": "super_admin",
    "avatar": "https://cloudinary.com/avatar.jpg",
    "permissions": {
      "canApproveProviders": true,
      "canManageUsers": true,
      "canManagePosts": true,
      "canViewAnalytics": true,
      "canManageSettings": true,
      "canSendNotifications": true
    },
    "isActive": true,
    "lastLoginDate": "2025-12-09T10:30:00Z",
    "createdAt": "2025-01-01T00:00:00Z"
  }
}
```

---

## 2. Dashboard APIs

### 2.1 Get Dashboard Stats
```http
GET /admin/dashboard/stats
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "totalUsers": 1250,
    "totalProviders": 340,
    "pendingProviders": 15,
    "totalPosts": 890,
    "activeUsers": 45,
    "growth": {
      "users": 12.5,
      "providers": 8.3,
      "posts": 15.2
    },
    "recentRegistrations": [
      {
        "id": "provider_id",
        "_id": "provider_id",
        "fullName": "Dr. Ahmed Khan",
        "email": "ahmed@example.com",
        "providerType": "doctor",
        "specialty": "Cardiologist",
        "subType": null,
        "verificationStatus": "pending",
        "createdAt": "2025-12-09T10:30:00Z",
        "avatar": null
      }
    ]
  },
  "stats": {
    "providers": {
      "total": 340,
      "pending": 15,
      "approved": 300,
      "rejected": 25,
      "growthPercentage": 8.3,
      "byType": [
        { "type": "doctor", "count": 150, "percentage": 50 },
        { "type": "home_service", "count": 100, "percentage": 33 },
        { "type": "vendor", "count": 50, "percentage": 17 }
      ]
    },
    "users": {
      "total": 1250,
      "active": 1200,
      "inactive": 50,
      "newThisMonth": 120,
      "growthPercentage": 12.5
    },
    "posts": {
      "total": 890,
      "thisMonth": 150
    },
    "quickStats": {
      "online": 45,
      "pendingReviews": 15
    }
  }
}
```

---

### 2.2 Get Quick Stats
```http
GET /admin/dashboard/quick-stats
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "stats": {
    "online": 45,
    "pendingReviews": 15,
    "todayRegistrations": 5,
    "activeProviders": 320
  }
}
```

---

### 2.3 Get Recent Registrations
```http
GET /admin/dashboard/recent-registrations?limit=10
Authorization: Bearer <token>
```

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| limit | number | 10 | Number of recent registrations |

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": "provider_id",
      "_id": "provider_id",
      "fullName": "Dr. Ahmed Khan",
      "email": "ahmed@example.com",
      "providerType": "doctor",
      "specialty": "Cardiologist",
      "subType": null,
      "verificationStatus": "pending",
      "createdAt": "2025-12-09T10:30:00Z",
      "avatar": null
    }
  ]
}
```

---

## 3. User Management APIs

### 3.1 Get All Users
```http
GET /admin/users?page=1&limit=15&search=john&isActive=true
Authorization: Bearer <token>
```

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| page | number | 1 | Page number |
| limit | number | 15 | Items per page |
| search | string | - | Search by name/email/phone |
| isActive | boolean | - | Filter by active status |
| isVerified | boolean | - | Filter by verified status |
| sortBy | string | createdAt | Sort field |
| sortOrder | string | desc | Sort order (asc/desc) |

**Response (200):**
```json
{
  "success": true,
  "users": [
    {
      "id": "user_id",
      "_id": "user_id",
      "fullName": "John Doe",
      "email": "john@example.com",
      "phoneNumber": "03001234567",
      "profileImage": "https://cloudinary.com/profile.jpg",
      "isActive": true,
      "isVerified": true,
      "emailVerified": true,
      "address": {
        "street": "123 Main St",
        "city": "Lahore",
        "state": "Punjab",
        "country": "Pakistan",
        "zipCode": "54000"
      },
      "createdAt": "2025-01-01T00:00:00Z",
      "updatedAt": "2025-12-09T10:30:00Z",
      "lastLogin": "2025-12-09T08:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 15,
    "total": 150,
    "pages": 10,
    "hasNext": true,
    "hasPrev": false
  },
  "stats": {
    "total": 150,
    "active": 140,
    "inactive": 10
  }
}
```

---

### 3.2 Get User Details
```http
GET /admin/users/:userId
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "user": {
    "id": "user_id",
    "_id": "user_id",
    "fullName": "John Doe",
    "email": "john@example.com",
    "phoneNumber": "03001234567",
    "profileImage": "https://cloudinary.com/profile.jpg",
    "isActive": true,
    "isVerified": true,
    "emailVerified": true,
    "address": {
      "street": "123 Main St",
      "city": "Lahore"
    },
    "createdAt": "2025-01-01T00:00:00Z",
    "updatedAt": "2025-12-09T10:30:00Z",
    "lastLogin": "2025-12-09T08:00:00Z",
    "postsCount": 25
  }
}
```

---

### 3.3 Activate User
```http
PUT /admin/users/:userId/activate
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "message": "User activated successfully"
}
```

---

### 3.4 Deactivate User
```http
PUT /admin/users/:userId/deactivate
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "message": "User deactivated successfully"
}
```

---

### 3.5 Delete User
```http
DELETE /admin/users/:userId
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "message": "User deleted successfully"
}
```

---

## 4. Provider Management APIs

### 4.1 Get All Providers
```http
GET /admin/providers?page=1&limit=15&status=pending&providerType=doctor&search=ahmed
Authorization: Bearer <token>
```

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| page | number | 1 | Page number |
| limit | number | 15 | Items per page |
| status | string | all | pending/approved/rejected/all |
| providerType | string | all | doctor/home_service/vendor/all |
| search | string | - | Search by name/email/phone |
| city | string | - | Filter by city |
| isActive | boolean | - | Filter by active status |
| sortBy | string | createdAt | Sort field |
| sortOrder | string | desc | Sort order |

**Response (200):**
```json
{
  "success": true,
  "providers": [
    {
      "id": "provider_id",
      "_id": "provider_id",
      "email": "ahmed@example.com",
      "fullName": "Dr. Ahmed Khan",
      "phoneNumber": "03001234567",
      "providerType": "doctor",
      "providerSubType": null,
      "specialty": "Cardiologist",
      "profession": null,
      "category": null,
      "experience": "10 years",
      "briefDescription": "Experienced cardiologist...",
      "rate": null,
      "consultationFee": 2000,
      "professionalName": "Heart Care Clinic",
      "businessName": null,
      "city": "Lahore",
      "address": "123 Medical Center",
      "coordinates": { "lat": 31.5204, "lng": 74.3587 },
      "idNumber": "35201-1234567-1",
      "documents": {
        "medicalLicense": {
          "name": "license.pdf",
          "url": "https://cloudinary.com/docs/license.pdf",
          "publicId": "docs/license_abc123",
          "uploadedAt": "2025-12-01T10:00:00Z",
          "verified": false
        },
        "nationalIdCard": {
          "name": "cnic.jpg",
          "url": "https://cloudinary.com/docs/cnic.jpg",
          "publicId": "docs/cnic_abc123",
          "uploadedAt": "2025-12-01T10:00:00Z",
          "verified": false
        }
      },
      "ratings": { "average": 4.5, "count": 25 },
      "profileComplete": true,
      "emailVerified": true,
      "verificationStatus": "pending",
      "adminVerified": "pending",
      "rejectionReason": null,
      "isActive": true,
      "isOnline": false,
      "createdAt": "2025-12-01T10:00:00Z",
      "updatedAt": "2025-12-09T10:30:00Z",
      "approvedAt": null,
      "approvedBy": null
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 15,
    "total": 50,
    "pages": 4,
    "hasNext": true,
    "hasPrev": false
  },
  "stats": {
    "total": 50,
    "pending": 15,
    "approved": 30,
    "rejected": 5,
    "active": 28,
    "inactive": 2
  }
}
```

---

### 4.2 Get Pending Providers
```http
GET /admin/providers/pending?page=1&limit=15&providerType=doctor
Authorization: Bearer <token>
```

**Response:** Same as Get All Providers, but only returns `verificationStatus: "pending"`

---

### 4.3 Get Provider Details
```http
GET /admin/providers/:providerId
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "provider": {
    "id": "provider_id",
    "_id": "provider_id",
    "email": "ahmed@example.com",
    "fullName": "Dr. Ahmed Khan",
    "phoneNumber": "03001234567",
    "providerType": "doctor",
    "providerSubType": null,
    "specialty": "Cardiologist",
    "profession": null,
    "category": null,
    "experience": "10 years",
    "briefDescription": "Experienced cardiologist...",
    "consultationFee": 2000,
    "rate": null,
    "professionalName": "Heart Care Clinic",
    "businessName": null,
    "city": "Lahore",
    "address": "123 Medical Center",
    "coordinates": { "lat": 31.5204, "lng": 74.3587 },
    "idNumber": "35201-1234567-1",
    "documents": { /* ... */ },
    "ratings": { "average": 4.5, "count": 25 },
    "profileComplete": true,
    "emailVerified": true,
    "verificationStatus": "pending",
    "adminVerified": "pending",
    "rejectionReason": null,
    "isActive": true,
    "isOnline": false,
    "createdAt": "2025-12-01T10:00:00Z",
    "updatedAt": "2025-12-09T10:30:00Z",
    "approvedAt": null,
    "approvedBy": null
  }
}
```

---

### 4.4 Approve Provider ⭐
```http
PUT /admin/providers/:providerId/approve
Authorization: Bearer <token>
Content-Type: application/json
```

**Request:**
```json
{
  "adminNotes": "All documents verified successfully"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Provider approved successfully",
  "data": {
    "id": "provider_id",
    "verificationStatus": "approved",
    "approvedAt": "2025-12-09T10:30:00Z",
    "approvedBy": "admin_id"
  }
}
```

**Effect:** 
- Sets `adminVerified: 'active'`
- Sets `status: 'approved'`
- Sends approval email to provider
- Provider can now login

---

### 4.5 Reject Provider ⭐
```http
PUT /admin/providers/:providerId/reject
Authorization: Bearer <token>
Content-Type: application/json
```

**Request:**
```json
{
  "reason": "Documents are unclear. Please resubmit with better quality images."
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Provider rejected successfully",
  "data": {
    "id": "provider_id",
    "verificationStatus": "rejected",
    "rejectionReason": "Documents are unclear...",
    "rejectedAt": "2025-12-09T10:30:00Z"
  }
}
```

**Effect:**
- Sets `adminVerified: 'inactive'`
- Sets `status: 'rejected'`
- Sends rejection email with reason
- Provider cannot login

---

### 4.6 Activate Provider
```http
PUT /admin/providers/:providerId/activate
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "message": "Provider activated successfully"
}
```

---

### 4.7 Deactivate Provider
```http
PUT /admin/providers/:providerId/deactivate
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "message": "Provider deactivated successfully"
}
```

---

### 4.8 Delete Provider
```http
DELETE /admin/providers/:providerId
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "message": "Provider deleted successfully"
}
```

---

## 5. Notification APIs

### 5.1 Get Notifications
```http
GET /admin/notifications?page=1&limit=20&isRead=false&type=provider_registration
Authorization: Bearer <token>
```

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| page | number | 1 | Page number |
| limit | number | 20 | Items per page |
| isRead | boolean | - | Filter by read status |
| type | string | - | Filter by notification type |

**Notification Types:**
- `provider_registration` - New provider registered
- `provider_approved` - Provider was approved
- `provider_rejected` - Provider was rejected
- `user_registration` - New user registered
- `system_alert` - System alerts
- `report` - User reports

**Response (200):**
```json
{
  "success": true,
  "notifications": [
    {
      "id": "notification_id",
      "_id": "notification_id",
      "type": "provider_registration",
      "title": "New Provider Registration",
      "message": "Dr. Ahmed Khan has registered as a doctor",
      "data": {
        "providerId": "provider_id",
        "providerType": "doctor",
        "actionUrl": "/admin/providers/provider_id"
      },
      "isRead": false,
      "createdAt": "2025-12-09T10:30:00Z",
      "readAt": null
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 50,
    "pages": 3,
    "hasNext": true,
    "hasPrev": false
  },
  "unreadCount": 15
}
```

---

### 5.2 Get Unread Count
```http
GET /admin/notifications/unread-count
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "unreadCount": 15
}
```

---

### 5.3 Mark Notification as Read
```http
PUT /admin/notifications/:notificationId/read
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "message": "Notification marked as read"
}
```

---

### 5.4 Mark All as Read
```http
PUT /admin/notifications/read-all
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "message": "All notifications marked as read"
}
```

---

### 5.5 Delete Notification
```http
DELETE /admin/notifications/:notificationId
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "message": "Notification deleted successfully"
}
```

---

### 5.6 Clear All Notifications
```http
DELETE /admin/notifications/clear-all
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "message": "All notifications cleared"
}
```

---

## 6. Settings APIs

### 6.1 Get All Settings
```http
GET /admin/settings
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "settings": {
    "general": {
      "appName": "MetroMatrix",
      "appVersion": "1.0.0",
      "platformName": "MetroMatrix",
      "contactEmail": "waleedhassansfd@gmail.com",
      "supportPhone": "+92-300-1234567",
      "autoApproveProviders": false,
      "requireEmailVerification": true,
      "maintenanceMode": false,
      "maintenanceMessage": ""
    },
    "notifications": {
      "emailNotifications": true,
      "pushNotifications": true,
      "smsNotifications": false,
      "notifyOnNewProvider": true,
      "notifyOnNewUser": true,
      "dailyDigest": false,
      "providerRegistrations": true,
      "userRegistrations": true,
      "systemAlerts": true,
      "weeklyReports": false
    },
    "providers": {
      "autoApproveProviders": false,
      "requireDocumentVerification": true,
      "maxPendingDays": 7,
      "allowedProviderTypes": ["doctor", "home_service", "vendor"]
    },
    "security": {
      "sessionTimeout": 30,
      "maxLoginAttempts": 5,
      "requireTwoFactor": false,
      "twoFactorEnabled": false,
      "passwordMinLength": 8,
      "passwordExpiry": 90
    },
    "appearance": {
      "theme": "light",
      "primaryColor": "#6366f1"
    }
  }
}
```

---

### 6.2 Update General Settings
```http
PUT /admin/settings/general
Authorization: Bearer <token>
Content-Type: application/json
```

**Request:**
```json
{
  "platformName": "MetroMatrix",
  "contactEmail": "support@metromatrix.com",
  "maintenanceMode": false
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "General settings updated successfully",
  "data": { /* updated general settings */ }
}
```

---

### 6.3 Update Notification Settings
```http
PUT /admin/settings/notifications
Authorization: Bearer <token>
Content-Type: application/json
```

**Request:**
```json
{
  "emailNotifications": true,
  "providerRegistrations": true,
  "systemAlerts": true
}
```

---

### 6.4 Update Security Settings
```http
PUT /admin/settings/security
Authorization: Bearer <token>
Content-Type: application/json
```

**⚠️ Requires Super Admin Role**

**Request:**
```json
{
  "sessionTimeout": 60,
  "maxLoginAttempts": 5,
  "twoFactorEnabled": false
}
```

---

### 6.5 Update Appearance Settings
```http
PUT /admin/settings/appearance
Authorization: Bearer <token>
Content-Type: application/json
```

**Request:**
```json
{
  "theme": "dark",
  "primaryColor": "#6366f1"
}
```

---

## 7. Error Handling

### Standard Error Response
```json
{
  "success": false,
  "message": "Error description",
  "error": "ERROR_CODE"
}
```

### HTTP Status Codes
| Code | Description |
|------|-------------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request |
| 401 | Unauthorized (no token or invalid token) |
| 403 | Forbidden (no permission) |
| 404 | Not Found |
| 429 | Too Many Requests |
| 500 | Server Error |

### Common Error Codes
| Code | Description |
|------|-------------|
| `INVALID_CREDENTIALS` | Email or password incorrect |
| `ACCOUNT_DEACTIVATED` | Admin account deactivated |
| `TOKEN_EXPIRED` | JWT token expired |
| `UNAUTHORIZED` | No token provided |
| `FORBIDDEN` | No permission for action |
| `NOT_FOUND` | Resource not found |

---

## 8. Pagination Format

All list endpoints return pagination in this format:

```json
{
  "pagination": {
    "page": 1,
    "limit": 15,
    "total": 150,
    "pages": 10,
    "hasNext": true,
    "hasPrev": false
  }
}
```

---

## 9. Frontend Integration Notes

### Token Storage
- Store `accessToken` for API calls
- Store `refreshToken` for token refresh
- Use `expiresIn` to schedule token refresh

### Auto-Refresh Token
```javascript
// Refresh token 5 minutes before expiry
const refreshThreshold = 5 * 60 * 1000; // 5 minutes
setTimeout(refreshToken, (expiresIn * 1000) - refreshThreshold);
```

### Dashboard Stats Transformation
The `data` object provides simplified stats, while `stats` provides detailed breakdown:

```javascript
// For dashboard cards
const cards = {
  users: response.data.totalUsers,
  providers: response.data.totalProviders,
  pending: response.data.pendingProviders,
  posts: response.data.totalPosts
};

// For growth indicators
const growth = response.data.growth; // { users: 12.5, providers: 8.3, posts: 15.2 }

// For recent activity
const recent = response.data.recentRegistrations;
```

---

## Contact

**API Support:** waleedhassansfd@gmail.com  
**Base URL:** https://metromatrix-api-2e35f5f074df.herokuapp.com/api

---

*Generated for MetroMatrix Admin Panel v74*
