# 📡 MetroMatrix API - Complete Endpoints Documentation (UPDATED)

## 🌐 Base URL
```
https://metromatrix-api-2e35f5f074df.herokuapp.com
```

---

## 🔐 Authentication Endpoints (17 total)

### User Authentication
- **POST** `/api/auth/register`
  - Register new user
  - Body: `fullName`, `phoneNumber`, `email`, `password`
  - Response: Verification email sent

- **POST** `/api/auth/login`
  - Login user
  - Body: `email`, `password`
  - Response: `accessToken`, `refreshToken`, `user` object

### Provider Authentication
- **POST** `/api/auth/provider/register`
  - Register new provider
  - Body: `fullName`, `phoneNumber`, `email`, `password`
  - Response: Verification email sent

- **POST** `/api/auth/provider/login`
  - Login provider
  - Body: `email`, `password`
  - Response: `accessToken`, `refreshToken`, `provider` object

### OAuth Integration
- **GET** `/api/auth/google`
  - Google OAuth initiation
  - Query: `type=user` or `type=provider`

- **GET** `/api/auth/google/callback`
  - Google OAuth callback (redirects from Google)

- **GET** `/api/auth/facebook`
  - Facebook OAuth initiation
  - Query: `type=user` or `type=provider`

- **GET** `/api/auth/facebook/callback`
  - Facebook OAuth callback (redirects from Facebook)

### Email Verification (NEW IMPROVED FLOW)
- **POST** `/api/auth/user/verify-email`
  - ✅ NEW: Verify user email after signup
  - Body: `token`
  - Response: `accessToken`, `refreshToken`, auto-login enabled
  - Note: User created AFTER verification

- **POST** `/api/auth/provider/verify-email`
  - ✅ NEW: Verify provider email after signup
  - Body: `token`
  - Response: `accessToken`, `refreshToken`, `canLogin: true`, pending admin approval
  - Note: Provider created AFTER verification

- **POST** `/api/auth/verify-email-token`
  - Generic verification (backward compatible)
  - Body: `token`, `userType` (user|provider)
  - Response: Tokens and user/provider data

- **POST** `/api/auth/send-verification-email`
  - Resend verification email
  - Body: `email`, `userType`

- **POST** `/api/auth/user/check-verification-status`
  - Check user verification status
  - Body: `email`

- **POST** `/api/auth/provider/check-verification-status`
  - Check provider verification status
  - Body: `email`

### Password Management
- **POST** `/api/auth/forgot-password`
  - Request password reset
  - Body: `email`
  - Response: Reset email sent

- **POST** `/api/auth/reset-password`
  - Reset password with token
  - Body: `token`, `password`
  - Response: Success message

### Token & Session Management
- **POST** `/api/auth/refresh`
  - Refresh access token
  - Body: `refreshToken`
  - Response: New `accessToken`

- **POST** `/api/auth/logout`
  - Logout user/provider
  - Headers: `Authorization: Bearer <token>`
  - Response: Success message

---

## 👤 User Endpoints (6 total)

### Profile Management
- **GET** `/api/users/profile`
  - Get user profile
  - Headers: `Authorization: Bearer <token>`
  - Response: User profile data

- **PUT** `/api/users/profile`
  - Update user profile
  - Headers: `Authorization: Bearer <token>`
  - Body: `fullName`, `phoneNumber`, `dateOfBirth`, `gender`, `address`, etc.

- **POST** `/api/users/complete-profile`
  - Complete profile (multi-step onboarding)
  - Headers: `Authorization: Bearer <token>`
  - Body: `step` (1-3), `data` (object with step-specific data)

### Media & Preferences
- **POST** `/api/users/upload-photo`
  - Upload profile photo
  - Headers: `Authorization: Bearer <token>`
  - Form: `photo` (file)
  - Response: Photo URL

- **PUT** `/api/users/preferences`
  - Update user preferences
  - Headers: `Authorization: Bearer <token>`
  - Body: `notifications`, `newsletter`, `language`, etc.

### Account Management
- **DELETE** `/api/users/account`
  - Delete user account
  - Headers: `Authorization: Bearer <token>`
  - Response: Account deleted message

---

## 🏥 Provider Endpoints (11 total)

### Provider Information
- **GET** `/api/providers`
  - Get all providers (public, paginated with filters)
  - Query: `page`, `limit`, `type`, `city`, `rating`
  - Response: Array of providers

- **GET** `/api/providers/search`
  - Search providers (public)
  - Query: `q` (search term), `type`, `city`
  - Response: Matching providers

- **GET** `/api/providers/by-type/:type`
  - Get providers by type (doctor, home_service, vendor)
  - Query: `page`, `limit`, `city`, `rating`
  - Response: Filtered providers

- **GET** `/api/providers/:id`
  - Get single provider details (public)
  - Response: Provider profile with ratings

### Provider Profile Management
- **GET** `/api/providers/profile`
  - Get authenticated provider's profile
  - Headers: `Authorization: Bearer <token>`
  - Response: Complete provider profile

- **PUT** `/api/providers/profile`
  - Update provider profile
  - Headers: `Authorization: Bearer <token>`
  - Body: `providerType`, `experience`, `city`, `bio`, etc.

### Provider Onboarding & Verification
- **POST** `/api/providers/personal-info`
  - Submit personal information during onboarding
  - Headers: `Authorization: Bearer <token>`
  - Body: `providerType`, `experience`, `city`
  - Response: Onboarding step completed

- **POST** `/api/providers/upload-document`
  - Upload verification document
  - Headers: `Authorization: Bearer <token>`
  - Form: `document` (file)
  - Response: Document upload confirmation

- **GET** `/api/providers/verification`
  - Get provider's verification status
  - Headers: `Authorization: Bearer <token>`
  - Response: `verificationStatus` (pending|approved|rejected)

### Availability & Ratings
- **PUT** `/api/providers/availability`
  - Update availability schedule
  - Headers: `Authorization: Bearer <token>`
  - Body: `availability` (object with day schedules)

- **POST** `/api/providers/:id/rate`
  - Rate a provider
  - Headers: `Authorization: Bearer <token>`
  - Body: `rating` (1-5), `review` (optional)
  - Response: Rating saved

---

## 📱 Post Endpoints (10 total)

### Post Retrieval
- **GET** `/api/posts`
  - Get all posts (public, paginated)
  - Query: `page`, `limit`, `category`, `tags`
  - Response: Array of posts

- **GET** `/api/posts/:id`
  - Get single post details (public)
  - Response: Post with comments and likes

### Post Management
- **POST** `/api/posts`
  - Create new post
  - Headers: `Authorization: Bearer <token>`
  - Form: `content`, `category`, `tags`, `images` (files, optional)
  - Response: Created post

- **PUT** `/api/posts/:id`
  - Update post
  - Headers: `Authorization: Bearer <token>`
  - Body: `content`, `category`, `tags`
  - Response: Updated post

- **DELETE** `/api/posts/:id`
  - Delete post
  - Headers: `Authorization: Bearer <token>`
  - Response: Success message

### Post Interactions
- **POST** `/api/posts/:id/like`
  - Like/unlike post
  - Headers: `Authorization: Bearer <token>`
  - Response: Like status

- **POST** `/api/posts/:id/comment`
  - Add comment to post
  - Headers: `Authorization: Bearer <token>`
  - Body: `content`, `parentComment` (optional for nested comments)
  - Response: Comment saved

- **DELETE** `/api/posts/comments/:id`
  - Delete comment
  - Headers: `Authorization: Bearer <token>`
  - Response: Success message

### Post Reporting & Management
- **POST** `/api/posts/:id/report`
  - Report post (spam, inappropriate, etc.)
  - Headers: `Authorization: Bearer <token>`
  - Body: `reason`, `description` (optional)
  - Response: Report submitted

- **GET** `/api/posts/my-posts`
  - Get user's own posts
  - Headers: `Authorization: Bearer <token>`
  - Response: Array of user's posts

---

## 👨‍💼 Admin Endpoints (12 total)

### Admin Authentication
- **POST** `/api/admin/login`
  - Admin login
  - Body: `email`, `password`
  - Response: `accessToken`, `refreshToken`, `admin` object

### Dashboard & Analytics
- **GET** `/api/admin/dashboard`
  - Get dashboard statistics
  - Headers: `Authorization: Bearer <token>`
  - Response: Stats (user count, provider count, pending approvals, etc.)

### Provider Management
- **GET** `/api/admin/providers/pending`
  - Get all pending providers awaiting approval
  - Headers: `Authorization: Bearer <token>`
  - Response: Array of pending providers

- **GET** `/api/admin/providers/:id`
  - Get provider details for review
  - Headers: `Authorization: Bearer <token>`
  - Response: Provider profile with documents

- **POST** `/api/admin/providers/:id/approve`
  - Approve provider
  - Headers: `Authorization: Bearer <token>`
  - Response: Provider approved, can now login

- **POST** `/api/admin/providers/:id/reject`
  - Reject provider
  - Headers: `Authorization: Bearer <token>`
  - Body: `reason` (rejection reason)
  - Response: Provider rejected

- **GET** `/api/admin/providers`
  - Get all providers (with filters)
  - Headers: `Authorization: Bearer <token>`
  - Query: `page`, `limit`, `status` (pending|approved|rejected)

- **PUT** `/api/admin/providers/:id/deactivate`
  - Deactivate provider account
  - Headers: `Authorization: Bearer <token>`
  - Response: Provider deactivated

- **PUT** `/api/admin/providers/:id/activate`
  - Activate provider account
  - Headers: `Authorization: Bearer <token>`
  - Response: Provider activated

### User Management
- **GET** `/api/admin/users`
  - Get all users (with filters)
  - Headers: `Authorization: Bearer <token>`
  - Query: `page`, `limit`, `status` (active|inactive)
  - Response: Array of users

- **PUT** `/api/admin/users/:id/deactivate`
  - Deactivate user account
  - Headers: `Authorization: Bearer <token>`
  - Response: User deactivated

- **PUT** `/api/admin/users/:id/activate`
  - Activate user account
  - Headers: `Authorization: Bearer <token>`
  - Response: User activated

### Content Moderation
- **DELETE** `/api/admin/posts/:id`
  - Delete post (admin moderation)
  - Headers: `Authorization: Bearer <token>`
  - Response: Post deleted

---

## 📊 Total Endpoints Summary

| Category | Count | Details |
|----------|-------|---------|
| Authentication | 17 | User/Provider signup, login, OAuth, email verification, password reset |
| Users | 6 | Profile management, preferences, account operations |
| Providers | 11 | Profile, onboarding, verification, availability, ratings |
| Posts | 10 | Create, read, update, delete, comments, likes, reports |
| Admin | 12 | Dashboard, provider approval, user management, moderation |
| **TOTAL** | **56** | **Complete API** |

---

## 🔑 Admin Credentials
```
Email: waleedhassansfd@gmail.com
Password: Waleed@107
```

---

## ✅ Key Updates in This Version

### Email Verification Improvements ✅
- **Separate user and provider verification flows**
- Users created AFTER email verification (no fake emails in DB)
- Providers created AFTER email verification
- PendingSignup collection for temporary data (auto-deletes in 24 hours)
- Both get auth tokens immediately

### Provider Approval Flow ✅
- Email verification: `verificationStatus: 'pending'`, `canLogin: true`
- Admin approval: `verificationStatus: 'approved'`
- Admin rejection: `verificationStatus: 'rejected'`, `canLogin: false`

### Security Improvements ✅
- Email verification required before account creation
- Rate limiting on email verification
- Token expiration (24 hours)
- Separate endpoints for user/provider flows
- Admin-only routes protected

### New Features ✅
- `/api/auth/user/verify-email` - User email verification
- `/api/auth/provider/verify-email` - Provider email verification
- `/api/auth/user/check-verification-status` - User verification check
- `/api/auth/provider/check-verification-status` - Provider verification check
- Web verification page: `GET /verify-email?token=xxx&type=user|provider`

---

## 📱 Frontend Integration Notes

### For User Signup
1. Call `POST /api/auth/register`
2. User receives verification email
3. User clicks email link → `/verify-email?token=xxx&type=user`
4. Call `POST /api/auth/user/verify-email` with token
5. Receive `accessToken` and `refreshToken` → Auto-login

### For Provider Signup
1. Call `POST /api/auth/provider/register`
2. Provider receives verification email
3. Provider clicks email link → `/verify-email?token=xxx&type=provider`
4. Call `POST /api/auth/provider/verify-email` with token
5. Receive `accessToken` and `refreshToken` → Can login with limited access
6. Await admin approval for full features
7. After approval: Full feature access

### Error Handling
All endpoints return standardized error responses:
```json
{
  "success": false,
  "message": "Error description",
  "statusCode": 400
}
```

---

## 🚀 Deployment Checklist

- [x] Fixed email verification logic
- [x] Separate user and provider flows
- [x] PendingSignup model created
- [x] Auth tokens for both user and provider
- [x] Admin provider approval workflow
- [x] Security improvements
- [ ] Deploy to Heroku
- [ ] Update environment variables
- [ ] Test all endpoints
- [ ] Share with frontend team

---

Generated: November 29, 2025
API Version: 2.0 (UPDATED)
Status: Ready for Deployment
