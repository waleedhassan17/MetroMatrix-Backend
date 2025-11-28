# 📱 Frontend Integration Guide - MetroMatrix API v2.0

## 🌐 API Base URL
```
https://metromatrix-api-2e35f5f074df.herokuapp.com
```

---

## ✅ Complete User & Provider Signup/Login Flow

### 🔴 USER FLOW

#### 1. User Signs Up
```javascript
// Frontend: User enters fullName, phoneNumber, email, password

POST /api/auth/register
{
  "fullName": "John Doe",
  "phoneNumber": "1234567890",
  "email": "user@example.com",
  "password": "SecurePass123"
}

Response (201):
{
  "success": true,
  "message": "Signup successful! Please verify your email to complete registration.",
  "email": "user@example.com",
  "requiresEmailVerification": true,
  "expiresIn": "24 hours"
}
```

#### 2. User Receives Verification Email
- Email contains: `https://metromatrix-api-2e35f5f074df.herokuapp.com/verify-email?token=xxx&type=user`
- User clicks link → Web page shows verification status

#### 3. Frontend Receives Verification Token (from deep link or email)
```javascript
// When user clicks email link, token is passed to app
const token = "verification-token-from-email";

POST /api/auth/user/verify-email
{
  "token": "verification-token-from-email"
}

Response (200):
{
  "success": true,
  "message": "Email verified successfully! Welcome to MetroMatrix.",
  "isVerified": true,
  "emailVerified": true,
  "user": {
    "id": "user-id",
    "fullName": "John Doe",
    "email": "user@example.com",
    "phoneNumber": "1234567890",
    "profileComplete": false,
    "emailVerified": true
  },
  "accessToken": "jwt-access-token",
  "refreshToken": "jwt-refresh-token"
}
```

#### 4. User Logs In
```javascript
POST /api/auth/login
{
  "email": "user@example.com",
  "password": "SecurePass123"
}

Response (200):
{
  "success": true,
  "user": {
    "id": "user-id",
    "fullName": "John Doe",
    "email": "user@example.com",
    "phoneNumber": "1234567890",
    "profileComplete": false,
    "isVerified": true,
    "profilePhoto": null,
    "dateOfBirth": null,
    "gender": null,
    "address": null,
    "preferences": {
      "notifications": true,
      "newsletter": false,
      "language": "en"
    }
  },
  "accessToken": "jwt-access-token",
  "refreshToken": "jwt-refresh-token"
}
```

---

### 🟢 PROVIDER FLOW

#### 1. Provider Signs Up
```javascript
POST /api/auth/provider/register
{
  "fullName": "Dr. Ahmed",
  "phoneNumber": "1234567890",
  "email": "doctor@example.com",
  "password": "SecurePass123"
}

Response (201):
{
  "success": true,
  "message": "Provider signup successful! Please verify your email to complete registration.",
  "email": "doctor@example.com",
  "requiresEmailVerification": true,
  "expiresIn": "24 hours"
}
```

#### 2. Provider Receives Verification Email
- Same as user: `https://metromatrix-api-2e35f5f074df.herokuapp.com/verify-email?token=xxx&type=provider`

#### 3. Frontend Verifies Provider Email
```javascript
POST /api/auth/provider/verify-email
{
  "token": "verification-token-from-email"
}

Response (200):
{
  "success": true,
  "message": "Email verified successfully! You can now login. Your account is pending admin approval for full provider features.",
  "isVerified": true,
  "emailVerified": true,
  "canLogin": true,
  "verificationStatus": "pending",
  "provider": {
    "id": "provider-id",
    "fullName": "Dr. Ahmed",
    "email": "doctor@example.com",
    "phoneNumber": "1234567890",
    "emailVerified": true,
    "canLogin": true,
    "verificationStatus": "pending"
  },
  "accessToken": "jwt-access-token",
  "refreshToken": "jwt-refresh-token"
}
```

#### 4. Provider Logs In
```javascript
POST /api/auth/provider/login
{
  "email": "doctor@example.com",
  "password": "SecurePass123"
}

Response (200):
{
  "success": true,
  "provider": {
    "id": "provider-id",
    "fullName": "Dr. Ahmed",
    "email": "doctor@example.com",
    "phoneNumber": "1234567890",
    "providerType": "doctor",
    "providerSubType": null,
    "profileComplete": false,
    "verificationStatus": "pending",
    "isVerified": true,
    "city": null,
    "ratings": {
      "averageRating": 0,
      "totalReviews": 0,
      "reviews": []
    }
  },
  "accessToken": "jwt-access-token",
  "refreshToken": "jwt-refresh-token"
}
```

#### 5. Admin Reviews & Approves Provider
- Admin sees provider in: `GET /api/admin/providers/pending`
- Admin calls: `POST /api/admin/providers/:id/approve`
- Provider now has `verificationStatus: "approved"`
- Provider gains full access

---

## 🔑 Token Management

### Store Tokens (in your frontend)
```javascript
// After login/verification, store:
localStorage.setItem('accessToken', response.accessToken);
localStorage.setItem('refreshToken', response.refreshToken);
localStorage.setItem('userType', 'user'); // or 'provider'
localStorage.setItem('userId', response.user.id); // or response.provider.id
```

### Use Tokens in Requests
```javascript
// Add to every API request header:
headers: {
  'Authorization': `Bearer ${accessToken}`,
  'Content-Type': 'application/json'
}
```

### Refresh Expired Token
```javascript
POST /api/auth/refresh
{
  "refreshToken": "stored-refresh-token"
}

Response (200):
{
  "success": true,
  "accessToken": "new-access-token",
  "refreshToken": "new-refresh-token"
}
```

---

## 📝 Sample Requests & Responses

### Get User Profile
```javascript
GET /api/users/profile
Headers: Authorization: Bearer <token>

Response (200):
{
  "success": true,
  "user": {
    "id": "user-id",
    "fullName": "John Doe",
    "email": "user@example.com",
    // ... full profile data
  }
}
```

### Update User Profile
```javascript
PUT /api/users/profile
Headers: Authorization: Bearer <token>
Body: {
  "fullName": "John Updated",
  "dateOfBirth": "1990-01-01",
  "gender": "male",
  "address": "123 Main St"
}

Response (200):
{
  "success": true,
  "message": "Profile updated successfully",
  "user": { ... updated data ... }
}
```

### Upload Profile Photo
```javascript
POST /api/users/upload-photo
Headers: Authorization: Bearer <token>
Body: FormData {
  "photo": <File>
}

Response (200):
{
  "success": true,
  "message": "Photo uploaded successfully",
  "photoUrl": "https://res.cloudinary.com/..."
}
```

### Get All Providers (Public)
```javascript
GET /api/providers?page=1&limit=10&type=doctor&city=Lahore&rating=4

Response (200):
{
  "success": true,
  "data": [
    {
      "id": "provider-id",
      "fullName": "Dr. Ahmed",
      "providerType": "doctor",
      "city": "Lahore",
      "ratings": { ... }
      // ... provider data
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 45
  }
}
```

### Rate a Provider
```javascript
POST /api/providers/:id/rate
Headers: Authorization: Bearer <token>
Body: {
  "rating": 5,
  "review": "Excellent service!"
}

Response (200):
{
  "success": true,
  "message": "Rating submitted",
  "rating": {
    "rating": 5,
    "review": "Excellent service!",
    "userId": "user-id",
    "createdAt": "2025-11-29T..."
  }
}
```

### Create a Post
```javascript
POST /api/posts
Headers: Authorization: Bearer <token>
Body: FormData {
  "content": "Looking for a good doctor",
  "category": "question",
  "tags": ["health", "doctor"],
  "images": [<File>, <File>]
}

Response (201):
{
  "success": true,
  "post": {
    "id": "post-id",
    "content": "Looking for a good doctor",
    "category": "question",
    "tags": ["health", "doctor"],
    "images": ["url1", "url2"],
    "likes": 0,
    "commentsCount": 0,
    "createdAt": "2025-11-29T..."
  }
}
```

### Get All Posts
```javascript
GET /api/posts?page=1&limit=10&category=question&tags=doctor

Response (200):
{
  "success": true,
  "data": [
    {
      "id": "post-id",
      "content": "...",
      "author": { ... user data ... },
      "category": "question",
      "likes": 5,
      "commentsCount": 3,
      "comments": [ ... ],
      "isLikedByMe": false,
      "createdAt": "2025-11-29T..."
    }
  ],
  "pagination": { ... }
}
```

---

## ⚠️ Error Responses

All endpoints return standardized error format:

```javascript
Response (400/401/403/500):
{
  "success": false,
  "message": "Descriptive error message",
  "statusCode": 400,
  "errors": [] // Optional: array of field errors
}
```

### Common Status Codes
- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized (token missing/invalid)
- `403` - Forbidden (no permission)
- `404` - Not Found
- `500` - Server Error

---

## 🔐 Authentication Strategies

### 1. Email/Password Login
```javascript
// Best for: Traditional login form
POST /api/auth/login or /api/auth/provider/login
```

### 2. OAuth (Google/Facebook)
```javascript
// Best for: Social login buttons
// 1. Redirect to: GET /api/auth/google?type=user
// 2. User authorizes
// 3. Redirect back with tokens
// 4. App receives tokens
```

### 3. Email Verification
```javascript
// Best for: Email-verified signup
// 1. User signs up
// 2. Clicks email link
// 3. Call POST /api/auth/user/verify-email or /api/auth/provider/verify-email
// 4. Get tokens → auto-login
```

---

## 🚀 Quick Start Implementation

### React Native/Expo Example
```javascript
import axios from 'axios';

const API_BASE = 'https://metromatrix-api-2e35f5f074df.herokuapp.com';

// Create axios instance with interceptors
const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Add token to requests
api.interceptors.request.use((config) => {
  const token = await AsyncStorage.getItem('accessToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle token refresh
api.interceptors.response.use(
  response => response,
  async error => {
    if (error.response.status === 401) {
      // Token expired, refresh it
      const refreshToken = await AsyncStorage.getItem('refreshToken');
      const response = await axios.post(`${API_BASE}/api/auth/refresh`, {
        refreshToken
      });
      // Save new tokens
      await AsyncStorage.setItem('accessToken', response.data.accessToken);
      // Retry original request
    }
    return Promise.reject(error);
  }
);

export default api;
```

---

## 📞 Support

For API issues:
1. Check endpoint documentation above
2. Verify request format and headers
3. Check token validity
4. Review error message carefully
5. Check status code for issue type

---

**API Version:** 2.0 (Updated November 29, 2025)
**Status:** Ready for Production
**Support:** waleedhassansfd@gmail.com
