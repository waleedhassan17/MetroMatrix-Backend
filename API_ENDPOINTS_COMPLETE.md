# MetroMatrix API v49 - Complete Endpoint List

## Base URL
```
https://metromatrix-api-2e35f5f074df.herokuapp.com
```

## Summary Statistics
- **Total Endpoints**: 47+
- **Authentication Required**: 35+
- **Public Endpoints**: 12
- **Admin-Only**: 8
- **Provider-Only**: 12

---

## Authentication Endpoints

### User/Provider Authentication

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| POST | `/api/auth/signup` | No | Create user or provider account |
| POST | `/api/auth/login` | No | Login with email/password |
| POST | `/api/auth/verify-email` | No | Verify email with code |
| POST | `/api/auth/refresh` | No | Refresh access token |
| POST | `/api/auth/logout` | Yes | Logout and invalidate token |

### Password Management

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| POST | `/api/auth/forgot-password` | No | Request password reset OTP |
| POST | `/api/auth/verify-reset-otp` | No | Verify OTP code |
| POST | `/api/auth/reset-password` | No | Reset password with token |
| POST | `/api/auth/resend-reset-otp` | No | Resend OTP email |

---

## User Endpoints (Regular Users)

### Profile Management

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| GET | `/api/users/profile` | Yes | Get own profile |
| PUT | `/api/users/profile` | Yes | Update own profile |
| GET | `/api/users/:id` | Optional | Get user public profile |
| DELETE | `/api/users/account` | Yes | Delete own account |

### Photo Management

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| POST | `/api/upload/profile-photo` | Yes | Upload profile photo |
| DELETE | `/api/users/profile-photo` | Yes | Remove profile photo |

### User Interaction

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| POST | `/api/users/follow/:id` | Yes | Follow a user |
| POST | `/api/users/unfollow/:id` | Yes | Unfollow a user |
| GET | `/api/users/followers` | Yes | Get followers list |
| GET | `/api/users/following` | Yes | Get following list |

---

## Provider Endpoints (Providers Only)

### Profile & Verification

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| GET | `/api/providers/profile` | Yes (Provider) | Get own provider profile |
| PUT | `/api/providers/profile` | Yes (Provider) | Update provider profile |
| POST | `/api/providers/personal-info` | Yes (Provider) | Submit personal info + documents |
| GET | `/api/providers/verification` | Yes (Provider) | Check verification status |

### Document Management

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| POST | `/api/providers/upload-document` | Yes (Provider) | Upload single document |
| GET | `/api/providers/documents` | Yes (Provider) | Get uploaded documents list |

### Availability & Settings

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| PUT | `/api/providers/availability` | Yes (Provider) | Set availability schedule |
| GET | `/api/providers/availability` | Yes (Provider) | Get availability |

### Public Provider Information

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| GET | `/api/providers/:id` | Optional | Get provider public profile |
| GET | `/api/providers` | Optional | List all providers |
| GET | `/api/providers/search` | Optional | Search providers |
| GET | `/api/providers/by-type/:type` | Optional | Filter providers by type |
| POST | `/api/providers/:id/rate` | Yes | Rate a provider |
| GET | `/api/providers/:id/reviews` | Optional | Get provider reviews |

---

## Admin Endpoints (Admin Only)

### Dashboard & Analytics

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| POST | `/api/admin/login` | No | Admin login |
| GET | `/api/admin/dashboard` | Yes (Admin) | Dashboard statistics |
| GET | `/api/admin/analytics` | Yes (Admin) | Detailed analytics |

### Provider Management

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| GET | `/api/admin/providers/pending` | Yes (Admin) | List pending providers |
| GET | `/api/admin/providers/:id` | Yes (Admin) | View provider for review |
| POST | `/api/admin/providers/:id/approve` | Yes (Admin) | Approve provider |
| POST | `/api/admin/providers/:id/reject` | Yes (Admin) | Reject provider |
| GET | `/api/admin/providers` | Yes (Admin) | List all providers |
| PUT | `/api/admin/providers/:id/activate` | Yes (Admin) | Activate provider |
| PUT | `/api/admin/providers/:id/deactivate` | Yes (Admin) | Deactivate provider |

### User Management

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| GET | `/api/admin/users` | Yes (Admin) | List all users |
| PUT | `/api/admin/users/:id/activate` | Yes (Admin) | Activate user |
| PUT | `/api/admin/users/:id/deactivate` | Yes (Admin) | Deactivate user |
| DELETE | `/api/admin/users/:id` | Yes (Admin) | Delete user account |

### Content Management

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| DELETE | `/api/admin/posts/:id` | Yes (Admin) | Delete post |
| DELETE | `/api/admin/comments/:id` | Yes (Admin) | Delete comment |

### Audit & Logs

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| GET | `/api/admin/activity-logs` | Yes (Admin) | View activity logs |
| GET | `/api/admin/audit-trail` | Yes (Admin) | View audit trail |

---

## Post & Social Endpoints

### Post Management

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| POST | `/api/posts` | Yes | Create post |
| GET | `/api/posts` | Optional | List posts |
| GET | `/api/posts/:id` | Optional | Get post details |
| PUT | `/api/posts/:id` | Yes | Edit own post |
| DELETE | `/api/posts/:id` | Yes | Delete own post |

### Post Interaction

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| POST | `/api/posts/:id/like` | Yes | Like post |
| DELETE | `/api/posts/:id/like` | Yes | Unlike post |
| GET | `/api/posts/:id/likes` | Optional | Get likes list |

### Comments

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| POST | `/api/posts/:id/comments` | Yes | Add comment |
| GET | `/api/posts/:id/comments` | Optional | Get comments |
| PUT | `/api/comments/:id` | Yes | Edit own comment |
| DELETE | `/api/comments/:id` | Yes | Delete own comment |

---

## New in v48-v49: Provider Onboarding

### Provider Endpoints

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| POST | `/api/providers/personal-info` | Yes (Provider) | **NEW** Submit personal info + documents |
| GET | `/api/providers/verification` | Yes (Provider) | **ENHANCED** Check verification status |

### Admin Endpoints

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| GET | `/api/admin/providers/pending` | Yes (Admin) | **ENHANCED** View pending with documents |
| GET | `/api/admin/providers/:id` | Yes (Admin) | **ENHANCED** View provider details |

---

## Upload Endpoints

### Image Upload

| Method | Endpoint | Auth Required | Purpose |
|--------|----------|---------------|---------|
| POST | `/api/upload/profile-photo` | Yes | Upload profile photo |
| POST | `/api/upload/post-images` | Yes | Upload post images |
| POST | `/api/upload/document` | Yes | Upload document file |

---

## Data Formats

### Provider Types
- `doctor` - Medical professionals
- `home_service` - Service providers (plumber, electrician, etc.)
- `vendor` - Shop owners and businesses

### Document Types
- `medicalLicense` - Medical/professional license
- `degreeCertificate` - Educational degree
- `professionalCertificate` - Professional certifications
- `businessLicense` - Business registration
- `nationalIdCard` - National ID (required for all)

### Verification Status
- `pending` - Submitted, awaiting admin review
- `approved` - Verified and can offer services
- `rejected` - Rejected with feedback

### User Roles
- `user` - Regular user (default)
- `provider` - Service provider
- `admin` - System administrator

---

## Authentication Methods

### Bearer Token (JWT)
```
Authorization: Bearer <accessToken>
```

### Token Refresh
```
POST /api/auth/refresh
Body: { refreshToken: "..." }
```

### Token Expiration
- Access Token: 15 minutes
- Refresh Token: 7 days
- OTP Code: 10 minutes

---

## Common Request Headers

```
Content-Type: application/json
(or multipart/form-data for file uploads)

Authorization: Bearer <accessToken>
(for authenticated endpoints)
```

---

## Common Response Format

### Success Response (200)
```json
{
  "success": true,
  "data": { ... },
  "message": "Optional message"
}
```

### Error Response (400/401/403/404/500)
```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE",
  "details": { ... }
}
```

---

## Status Codes

| Code | Meaning | Example |
|------|---------|---------|
| 200 | OK | Successful request |
| 201 | Created | Resource created |
| 400 | Bad Request | Validation error |
| 401 | Unauthorized | Missing/invalid token |
| 403 | Forbidden | Not authorized for resource |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Resource already exists |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Server Error | Internal error |

---

## Pagination

List endpoints support pagination:

### Query Parameters
```
?page=1&limit=10
```

### Response Format
```json
{
  "success": true,
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 150,
    "pages": 15
  }
}
```

---

## Search & Filtering

### Provider Search
```
GET /api/providers/search?q=cardiology&type=doctor&city=Cairo&minRating=4.5&maxRate=300
```

### Query Parameters
- `q` - Search term (name, specialty, description)
- `type` - Provider type (doctor, home_service, vendor)
- `city` - Service location
- `minRating` - Minimum rating (0-5)
- `maxRate` - Maximum hourly/service rate

---

## Rate Limiting

| Endpoint | Limit | Window |
|----------|-------|--------|
| Login | 5 attempts | 15 minutes |
| Email Send | 3 emails | 1 hour |
| OTP Verify | 5 attempts | 30 minutes |
| API Call | 100 requests | 1 minute |

---

## File Upload Constraints

| Constraint | Value |
|-----------|-------|
| Max file size | 10 MB |
| Allowed formats | PDF, JPG, PNG, GIF |
| Max files per upload | 5 |
| Max documents per provider | 5 |
| Auto-cleanup age | 90 days |

---

## Error Codes Reference

| Code | HTTP Status | Description |
|------|------------|-------------|
| INVALID_EMAIL | 400 | Email format invalid |
| INVALID_PASSWORD | 400 | Password requirements not met |
| EMAIL_ALREADY_REGISTERED | 409 | Email already exists |
| INVALID_TOKEN | 401 | Token invalid or expired |
| TOKEN_EXPIRED | 401 | Token has expired |
| UNAUTHORIZED | 401 | No authentication provided |
| FORBIDDEN | 403 | Insufficient permissions |
| NOT_FOUND | 404 | Resource not found |
| VALIDATION_ERROR | 400 | Input validation failed |
| DUPLICATE_ENTRY | 409 | Duplicate record |
| FILE_TOO_LARGE | 400 | File exceeds size limit |
| INVALID_FILE_TYPE | 400 | File type not allowed |
| RATE_LIMIT_EXCEEDED | 429 | Too many requests |
| SERVER_ERROR | 500 | Internal server error |

---

## Quick Links

### Documentation
- [Provider Onboarding Guide](./PROVIDER_ONBOARDING_GUIDE.md)
- [API Reference](./PROVIDER_ONBOARDING_API_REFERENCE.md)
- [Frontend Integration Guide](./FRONTEND_INTEGRATION_GUIDE.md)
- [Release Summary v48](./RELEASE_SUMMARY_v48.md)

### API Base URL
- Production: https://metromatrix-api-2e35f5f074df.herokuapp.com

### Health Check
```
GET /api/auth/login (400 = server responding)
```

---

## API Version History

| Version | Date | Major Changes |
|---------|------|----------------|
| v47 | Jan 15 | Password reset OTP, upload fixes |
| v48 | Jan 15 | Provider onboarding, document model |
| v49 | Jan 15 | Comprehensive documentation |

---

## Support

For API issues:
1. Check error code in response
2. Review relevant documentation file
3. Verify request format and headers
4. Check authentication token validity

---

**Last Updated**: January 15, 2024
**API Version**: v49
**Status**: Production Ready ✅
