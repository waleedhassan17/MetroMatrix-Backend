# Two-Phase Authentication for Providers - Complete Guide (v51)

## Overview

The MetroMatrix backend now implements a **two-phase authentication system** for providers to solve the chicken-and-egg problem:

**Problem**: Providers couldn't submit documents without logging in, but couldn't login without admin approval.

**Solution**: Two distinct token types issued at different onboarding stages.

---

## Architecture

### Two Phases

#### **Phase 1: LIMITED Token** (After Email Verification)
- **When Issued**: Immediately after provider verifies their email
- **What It Allows**:
  - ✅ Submit personal information: `POST /api/providers/personal-info`
  - ✅ Upload documents for verification
  - ✅ Check verification status: `GET /api/providers/verification`
  - ❌ Cannot access dashboard
  - ❌ Cannot accept bookings/orders
  - ❌ Cannot use other provider features

#### **Phase 2: FULL Token** (After Admin Approval)
- **When Issued**: When admin approves provider application
- **What It Allows**:
  - ✅ All Limited Token features
  - ✅ Access provider dashboard
  - ✅ Accept bookings and orders
  - ✅ Update profile and services
  - ✅ Manage availability
  - ✅ All other provider features

---

## Onboarding Status States

```
pending_email        → Email not verified yet (no token)
    ↓
pending_profile      → Email verified, LIMITED token issued, can submit personal info
    ↓
pending_approval     → Profile submitted, waiting for admin review (still LIMITED token)
    ↓
approved             → Admin approved, FULL token issued, full access
    ↓ (if rejected)
rejected             → Admin rejected, can resubmit (goes back to pending_approval)
```

---

## Detailed Flow Diagram

```
1. Provider Signs Up
   └─ Account created with onboardingStatus: "pending_email"
   └─ Email verification link sent
   └─ No token issued yet

2. Provider Verifies Email ✉️
   └─ Endpoint: POST /api/auth/verify-email-token
   └─ onboardingStatus changes to: "pending_profile"
   └─ LIMITED token issued
   └─ Response includes: { tokenType: "LIMITED", accessToken: "...", refreshToken: "..." }

3. Provider Uses LIMITED Token
   └─ Endpoint: POST /api/providers/personal-info
   └─ Submits: Personal info + Document uploads
   └─ onboardingStatus changes to: "pending_approval"
   └─ Admin email notification sent

4. Admin Reviews Documents
   └─ Endpoint: GET /api/admin/providers/pending
   └─ Admin views all provider info + documents

5. Admin Approves Provider ✅
   └─ Endpoint: POST /api/admin/providers/:id/approve
   └─ onboardingStatus changes to: "approved"
   └─ FULL token generated and returned in response
   └─ Provider receives approval email
   └─ Response includes: { tokenType: "FULL", accessToken: "...", tokens: {...} }

6. Provider Can Now Login or Use FULL Token
   └─ Option A: Use FULL token from approval response immediately
   └─ Option B: Login with email/password to get FULL token
   └─ Can now access all features
```

---

## Updated Endpoints with Token Type Protection

### Provider Endpoints

| Endpoint | Method | Phase 1 (LIMITED) | Phase 2 (FULL) | Status |
|----------|--------|------------------|----------------|--------|
| `/api/providers/personal-info` | POST | ✅ Required | ✅ Allowed | Submit profile + docs |
| `/api/providers/verification` | GET | ✅ Allowed | ✅ Allowed | Check status |
| `/api/providers/profile` | GET | ❌ Denied | ✅ Required | View profile |
| `/api/providers/profile` | PUT | ❌ Denied | ✅ Required | Update profile |
| `/api/providers/upload-document` | POST | ❌ Denied | ✅ Required | Single doc upload |
| `/api/providers/availability` | PUT | ❌ Denied | ✅ Required | Manage availability |
| `/api/providers/dashboard` | GET | ❌ Denied | ✅ Required | View dashboard |
| `/api/providers/bookings` | GET | ❌ Denied | ✅ Required | View bookings |

### Authentication Endpoints

| Endpoint | Method | Purpose | Token Issued |
|----------|--------|---------|--------------|
| `/api/auth/signup` | POST | Create provider account | None (pending email) |
| `/api/auth/verify-email-token` | POST | Verify email & get LIMITED token | LIMITED (pending_profile) |
| `/api/auth/login` | POST | Login provider (only after approval) | FULL (if approved) |
| `/api/auth/refresh` | POST | Refresh token | Same type as current |

### Admin Endpoints

| Endpoint | Method | Purpose | Result |
|----------|--------|---------|--------|
| `/api/admin/providers/pending` | GET | View pending with documents | Lists all pending_approval status |
| `/api/admin/providers/:id` | GET | View provider for review | Full details + all documents |
| `/api/admin/providers/:id/approve` | POST | Approve provider | Issues FULL token, sends approval email |
| `/api/admin/providers/:id/reject` | POST | Reject with reason | Keeps pending_approval status for resubmit |

---

## API Response Examples

### 1. After Email Verification (LIMITED Token)

**Request:**
```bash
POST /api/auth/verify-email-token
Content-Type: application/json

{
  "token": "abc123...",
  "userType": "provider"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Email verified! You can now submit your personal information and documents. LIMITED ACCESS - Full access after admin approval.",
  "tokenType": "LIMITED",
  "provider": {
    "id": "507f1f77bcf86cd799439011",
    "fullName": "Dr. Ahmed Hassan",
    "email": "ahmed@example.com",
    "onboardingStatus": "pending_profile",
    "emailVerified": true,
    "canLogin": false
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

### 2. Submit Personal Info with LIMITED Token

**Request:**
```bash
POST /api/providers/personal-info
Authorization: Bearer <LIMITED_TOKEN>
Content-Type: multipart/form-data

Form Data:
- providerType: "doctor"
- fullName: "Dr. Ahmed Hassan"
- email: "ahmed@example.com"
- phoneNumber: "+201234567890"
- specialty: "Cardiology"
- city: "Cairo"
- idNumber: "12345678"
- experience: "10"
- medicalLicense: (file)
- nationalIdCard: (file)
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Profile submitted for review. Admin will review your documents and contact you within 24 hours.",
  "provider": {
    "id": "507f1f77bcf86cd799439011",
    "fullName": "Dr. Ahmed Hassan",
    "email": "ahmed@example.com",
    "onboardingStatus": "pending_approval"
  },
  "documents": [
    {
      "id": "607f1f77bcf86cd799439012",
      "documentType": "medicalLicense",
      "fileName": "license.pdf",
      "uploadedAt": "2024-01-20T10:30:00Z",
      "verified": false
    }
  ]
}
```

---

### 3. Admin Approves Provider (Issues FULL Token)

**Request:**
```bash
POST /api/admin/providers/507f1f77bcf86cd799439011/approve
Authorization: Bearer <ADMIN_TOKEN>
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Provider approved successfully. FULL access token issued.",
  "tokenType": "FULL",
  "provider": {
    "id": "507f1f77bcf86cd799439011",
    "fullName": "Dr. Ahmed Hassan",
    "email": "ahmed@example.com",
    "onboardingStatus": "approved"
  },
  "tokens": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

**Email Sent to Provider:**
```
Subject: Your Provider Account Has Been Approved - MetroMatrix

Dear Dr. Ahmed Hassan,

Your provider account has been approved! You can now start offering your services on MetroMatrix.

You have been issued a FULL access token. You can use it immediately to access your dashboard and manage your services.

If you prefer to login, use your email and password on the login page.

Best regards,
MetroMatrix Team
```

---

### 4. Provider Attempts to Access Full-Token-Only Endpoint with LIMITED Token

**Request:**
```bash
GET /api/providers/profile
Authorization: Bearer <LIMITED_TOKEN>
```

**Response (403 Forbidden):**
```json
{
  "success": false,
  "error": "You do not have full access yet. Current status: pending_approval. Please wait for admin approval."
}
```

---

### 5. Provider Tries to Login Before Approval

**Request:**
```bash
POST /api/auth/login
Content-Type: application/json

{
  "email": "ahmed@example.com",
  "password": "SecurePassword123!"
}
```

**Response (403 Forbidden):**
```json
{
  "success": false,
  "error": "Cannot login yet. Current status: pending_approval. Please wait for admin approval."
}
```

---

### 6. Provider Logs In After Approval (Gets FULL Token)

**Request:**
```bash
POST /api/auth/login
Content-Type: application/json

{
  "email": "ahmed@example.com",
  "password": "SecurePassword123!"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Login successful! You have FULL access.",
  "tokenType": "FULL",
  "provider": {
    "id": "507f1f77bcf86cd799439011",
    "fullName": "Dr. Ahmed Hassan",
    "email": "ahmed@example.com",
    "onboardingStatus": "approved",
    "verificationStatus": "approved"
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

## Middleware Protection

### New Middleware: `onboardingMiddleware.js`

Three middleware functions protect routes based on onboarding status:

#### 1. `allowLimitedOrFullToken`
Allows access with LIMITED or FULL token
```javascript
// Allows: pending_profile, pending_approval, approved
router.post('/personal-info', allowLimitedOrFullToken, submitPersonalInfo);
```

#### 2. `requireFullToken`
Requires FULL token only (approved status)
```javascript
// Allows: approved only
router.get('/profile', requireFullToken, getProviderProfile);
router.put('/availability', requireFullToken, updateAvailability);
```

#### 3. `getProviderStatus`
Retrieves provider status without restricting (for read-only checks)
```javascript
router.get('/verification', getProviderStatus, getVerificationStatus);
```

---

## Database Schema Changes

### Provider Model Updates

```javascript
{
  // ... existing fields ...
  
  // NEW: Two-phase authentication tracking
  onboardingStatus: {
    type: String,
    enum: ['pending_email', 'pending_profile', 'pending_approval', 'approved', 'rejected'],
    default: 'pending_email'
  },
  
  // UPDATED: canLogin only true when onboarding status is 'approved'
  canLogin: {
    type: Boolean,
    default: false
  }
}
```

---

## Frontend Integration Examples

### React Provider Signup Flow

```javascript
// Step 1: Signup
const signup = async (formData) => {
  const response = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: formData.fullName,
      email: formData.email,
      password: formData.password,
      userType: 'provider'
    })
  });
  return response.json(); // Shows email verification page
};

// Step 2: Verify Email
const verifyEmail = async (token) => {
  const response = await fetch('/api/auth/verify-email-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: token,
      userType: 'provider'
    })
  });
  const data = await response.json();
  
  if (data.tokenType === 'LIMITED') {
    // Store LIMITED token
    localStorage.setItem('limitedToken', data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
    
    // Show: "You have LIMITED access. Submit your personal information."
    navigate('/provider/submit-info');
  }
};

// Step 3: Submit Personal Info (with LIMITED Token)
const submitPersonalInfo = async (formData) => {
  const limitedToken = localStorage.getItem('limitedToken');
  
  const form = new FormData();
  form.append('providerType', formData.providerType);
  form.append('fullName', formData.fullName);
  form.append('medicalLicense', formData.medicalLicense);
  // ... other fields ...
  
  const response = await fetch('/api/providers/personal-info', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${limitedToken}`
    },
    body: form
  });
  
  if (response.ok) {
    // Show: "Submitted! Waiting for admin approval..."
    navigate('/provider/pending');
  }
};

// Step 4: Check Status
const checkStatus = async () => {
  const limitedToken = localStorage.getItem('limitedToken');
  
  const response = await fetch('/api/providers/verification', {
    headers: {
      'Authorization': `Bearer ${limitedToken}`
    }
  });
  
  const data = await response.json();
  
  if (data.onboardingStatus === 'approved') {
    // Use FULL token from approval response or login again
    // Can now show dashboard and full features
  }
};

// Step 5: After Approval - Login to Get FULL Token
const login = async (credentials) => {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password
    })
  });
  
  const data = await response.json();
  
  if (response.ok && data.tokenType === 'FULL') {
    // Store FULL token
    localStorage.setItem('accessToken', data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
    localStorage.removeItem('limitedToken'); // Clear LIMITED token
    
    // Show full provider dashboard
    navigate('/provider/dashboard');
  }
};
```

---

## Token Lifecycle

| Phase | Status | Token Type | Can Submit Docs | Can Login | Can Access Dashboard |
|-------|--------|-----------|----------------|-----------|----------------------|
| 1 | pending_email | None | ❌ | ❌ | ❌ |
| 2 | pending_profile | LIMITED | ✅ | ❌ | ❌ |
| 3 | pending_approval | LIMITED | ✅ | ❌ | ❌ |
| 4 | approved | FULL | ✅ | ✅ | ✅ |

---

## Error Handling

### Common Errors During Flow

#### Attempting to Use LIMITED Token on FULL-Token-Only Endpoint
```json
{
  "success": false,
  "error": "You do not have full access yet. Current status: pending_approval. Please wait for admin approval.",
  "code": "INSUFFICIENT_ACCESS"
}
```

#### Attempting to Login During Onboarding
```json
{
  "success": false,
  "error": "Cannot login yet. Current status: pending_approval. Please wait for admin approval.",
  "code": "STATUS_NOT_APPROVED"
}
```

#### Expired LIMITED Token
```json
{
  "success": false,
  "error": "Invalid or expired authentication token",
  "code": "TOKEN_EXPIRED"
}
```

---

## Security Considerations

1. **Token Segregation**: LIMITED and FULL tokens are cryptographically distinct
2. **Status Enforcement**: Server checks onboarding status on EVERY request
3. **No Privilege Escalation**: Provider cannot manually change status
4. **Admin Control**: Only admins can issue FULL tokens via approval
5. **Email Verification**: Required before LIMITED token issuance
6. **Document Upload**: Verified before admin review
7. **Rejection Handling**: Keeps pending_approval so provider can fix issues

---

## Transition Guide

### From Old System (v50)
- Old: Providers got immediate full access after email verification
- New: Providers get LIMITED token, must wait for admin approval for FULL token

### Existing Providers
- Will have onboardingStatus: "approved" (assumed already verified)
- Can continue using app normally with FULL tokens
- No action required

### New Providers (After v51)
- Must follow two-phase flow
- Cannot login until admin approves
- Can still submit profile with LIMITED token

---

## Deployment Notes

**Version**: v51
**Release Date**: January 20, 2024
**Breaking Changes**: None (existing providers unaffected)
**Database Changes**: New `onboardingStatus` field added

---

## Files Modified

1. `src/models/Provider.js` - Added onboardingStatus field
2. `src/controllers/authController.js` - Updated verifyEmailToken, loginProvider
3. `src/controllers/providerController.js` - Updated submitPersonalInfo
4. `src/controllers/adminController.js` - Updated approveProvider, rejectProvider
5. `src/middleware/onboardingMiddleware.js` - NEW middleware for token protection
6. `src/routes/providerRoutes.js` - Updated routes with middleware

---

## Testing Checklist

- ✅ Provider signup creates account with pending_email status
- ✅ Email verification issues LIMITED token
- ✅ LIMITED token allows /personal-info endpoint
- ✅ LIMITED token denied on /profile endpoint
- ✅ Login blocked until approved
- ✅ Admin approval issues FULL token
- ✅ FULL token allows all endpoints
- ✅ Token refresh maintains token type
- ✅ Rejection keeps pending_approval status
- ✅ Provider can resubmit after rejection

---

## Support

For issues with two-phase authentication:

1. Check `onboardingStatus` field in database
2. Verify token type in response headers: `X-Token-Type`
3. Check error messages for specific status requirements
4. Ensure admin approval before expecting FULL token access

---

**Documentation Version**: v51
**Last Updated**: January 20, 2024
**Status**: Production Ready ✅
