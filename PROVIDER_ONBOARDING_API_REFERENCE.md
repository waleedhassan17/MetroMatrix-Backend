# Provider Onboarding API Quick Reference - v48

## Base URL
```
https://metromatrix-api-2e35f5f074df.herokuapp.com
```

## Authentication
All provider/admin endpoints require JWT token in Authorization header:
```
Authorization: Bearer <accessToken>
```

---

## Provider Endpoints

### 1. Submit Personal Info + Documents
```
POST /api/providers/personal-info
Content-Type: multipart/form-data
Authorization: Bearer <token>

Fields:
- providerType (required): "doctor" | "home_service" | "vendor"
- fullName (required): string
- email (required): valid email
- phoneNumber (required): string
- city (required): string
- idNumber (required): string
- experience (required): string/number
- specialty (if doctor): string
- profession (if home_service): string
- category (if vendor): string
- businessName (if vendor): string
- rate (optional): number
- briefDescription (optional): string
- nationalIdCard (required): file
- medicalLicense (if doctor): file
- degreeCertificate (optional): file
- professionalCertificate (optional): file
- businessLicense (if vendor): file

Response: 200 OK
{
  "success": true,
  "message": "Profile submitted for review...",
  "provider": {
    "id": "...",
    "fullName": "...",
    "email": "...",
    "providerType": "doctor",
    "verificationStatus": "pending",
    "onboardingStep": 1
  },
  "documents": [...]
}
```

### 2. Get Verification Status
```
GET /api/providers/verification
Authorization: Bearer <token>

Response: 200 OK
{
  "success": true,
  "verificationStatus": "pending" | "approved" | "rejected",
  "isVerified": boolean,
  "rejectionReason": null | "string",
  "onboardingStep": 1,
  "documentsCount": 2,
  "documentsVerified": 0,
  "documents": {
    "medicalLicense": {
      "uploaded": true,
      "verified": false,
      "verifiedAt": null,
      "rejectionReason": null
    },
    ...
  }
}
```

### 3. Get Provider Profile
```
GET /api/providers/profile
Authorization: Bearer <token>

Response: 200 OK
{
  "success": true,
  "provider": { ... }
}
```

### 4. Update Provider Profile
```
PUT /api/providers/profile
Authorization: Bearer <token>
Content-Type: application/json

Body: {
  "rate": 250,
  "briefDescription": "...",
  ...
}

Response: 200 OK
{
  "success": true,
  "message": "Profile updated",
  "provider": { ... }
}
```

---

## Admin Endpoints

### 1. Get Pending Providers
```
GET /api/admin/providers/pending?page=1&limit=10
Authorization: Bearer <adminToken>

Response: 200 OK
{
  "success": true,
  "providers": [
    {
      "id": "...",
      "fullName": "...",
      "email": "...",
      "providerType": "doctor",
      "verificationStatus": "pending",
      "documents": [
        {
          "id": "...",
          "documentType": "medicalLicense",
          "fileName": "license.pdf",
          "fileUrl": "https://...",
          "uploadedAt": "2024-01-15T10:30:00Z",
          "verified": false
        },
        ...
      ]
    },
    ...
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 15,
    "pages": 2
  }
}
```

### 2. Get Provider Details
```
GET /api/admin/providers/:providerId
Authorization: Bearer <adminToken>

Response: 200 OK
{
  "success": true,
  "provider": {
    "id": "...",
    "fullName": "Dr. Ahmed Hassan",
    "email": "ahmed@example.com",
    "phoneNumber": "+201234567890",
    "providerType": "doctor",
    "specialty": "Cardiology",
    "experience": "10",
    "city": "Cairo",
    "rate": 200,
    "idNumber": "12345678",
    "verificationStatus": "pending",
    "documents": [
      {
        "id": "...",
        "documentType": "medicalLicense",
        "fileName": "license.pdf",
        "fileUrl": "https://res.cloudinary.com/...",
        "fileSize": 245000,
        "mimeType": "application/pdf",
        "uploadedAt": "2024-01-15T10:30:00Z",
        "verified": false,
        "verifiedAt": null,
        "verifiedBy": null,
        "rejectionReason": null
      },
      ...
    ]
  }
}
```

### 3. Approve Provider
```
POST /api/admin/providers/:providerId/approve
Authorization: Bearer <adminToken>
Content-Type: application/json

Body: {} (empty or omit)

Response: 200 OK
{
  "success": true,
  "message": "Provider approved successfully",
  "provider": {
    "id": "...",
    "fullName": "Dr. Ahmed Hassan",
    "verificationStatus": "approved"
  }
}

Side Effects:
- Provider receives approval email
- Provider can now appear in public listings
- Provider can offer services immediately
```

### 4. Reject Provider
```
POST /api/admin/providers/:providerId/reject
Authorization: Bearer <adminToken>
Content-Type: application/json

Body: {
  "reason": "Medical license appears expired. Please submit current license."
}

Response: 200 OK
{
  "success": true,
  "message": "Provider rejected successfully",
  "provider": {
    "id": "...",
    "fullName": "Dr. Ahmed Hassan",
    "verificationStatus": "rejected",
    "rejectionReason": "Medical license appears expired..."
  }
}

Side Effects:
- Provider receives rejection email with reason
- Provider can reapply with updated information
```

### 5. Get All Providers
```
GET /api/admin/providers?page=1&limit=10
Authorization: Bearer <adminToken>

Query Parameters:
- page: number (default: 1)
- limit: number (default: 10)

Response: 200 OK
{
  "success": true,
  "providers": [ ... ],
  "pagination": { ... }
}
```

---

## Document Types Reference

| Provider Type | Required Documents |
|---|---|
| **doctor** | Medical License, National ID (Degree & Professional Certificates optional) |
| **home_service** | National ID (Degree & Professional Certificates optional) |
| **vendor** | Business License, National ID |
| **all** | National ID (always required) |

---

## Common Error Responses

### 400 Bad Request
```json
{
  "success": false,
  "error": "Missing required fields: providerType, fullName, ...",
  "code": "VALIDATION_ERROR"
}
```

### 400 Missing National ID
```json
{
  "success": false,
  "error": "National ID Card is required",
  "code": "MISSING_NATIONAL_ID"
}
```

### 404 Not Found
```json
{
  "success": false,
  "error": "Provider not found",
  "code": "NOT_FOUND"
}
```

### 401 Unauthorized
```json
{
  "success": false,
  "error": "Invalid or missing authentication token",
  "code": "UNAUTHORIZED"
}
```

### 403 Forbidden
```json
{
  "success": false,
  "error": "Access denied. Admin/Provider only.",
  "code": "FORBIDDEN"
}
```

### 500 Server Error
```json
{
  "success": false,
  "error": "Internal server error",
  "code": "SERVER_ERROR"
}
```

---

## Provider Type Field Requirements

### Doctor (providerType = "doctor")
```
Required:
- specialty: string (e.g., "Cardiology", "General Practice")
- medicalLicense: file (PDF)

Optional:
- degreeCertificate: file (PDF)
- professionalCertificate: file (PDF)
- rate: number (consultation fee)
```

### Home Service (providerType = "home_service")
```
Required:
- profession: string (e.g., "Plumber", "Electrician")

Optional:
- providerSubType: string
- degreeCertificate: file (PDF)
- professionalCertificate: file (PDF)
- rate: number (hourly rate)
```

### Vendor (providerType = "vendor")
```
Required:
- category: string (e.g., "Electronics", "Clothing")
- businessName: string (shop name)
- businessLicense: file (PDF)

Optional:
- rate: number (delivery fee or similar)
```

---

## Example Requests

### cURL - Submit Personal Info
```bash
curl -X POST https://metromatrix-api-2e35f5f074df.herokuapp.com/api/providers/personal-info \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "providerType=doctor" \
  -F "fullName=Dr. Ahmed Hassan" \
  -F "email=ahmed@example.com" \
  -F "phoneNumber=+201234567890" \
  -F "city=Cairo" \
  -F "idNumber=12345678" \
  -F "experience=10" \
  -F "specialty=Cardiology" \
  -F "rate=200" \
  -F "briefDescription=Expert cardiologist" \
  -F "medicalLicense=@/path/to/license.pdf" \
  -F "nationalIdCard=@/path/to/id.jpg"
```

### JavaScript/Fetch
```javascript
const formData = new FormData();
formData.append('providerType', 'doctor');
formData.append('fullName', 'Dr. Ahmed Hassan');
formData.append('email', 'ahmed@example.com');
formData.append('phoneNumber', '+201234567890');
formData.append('city', 'Cairo');
formData.append('idNumber', '12345678');
formData.append('experience', '10');
formData.append('specialty', 'Cardiology');
formData.append('rate', '200');
formData.append('medicalLicense', fileInput.files[0]);
formData.append('nationalIdCard', idInput.files[0]);

const response = await fetch(
  'https://metromatrix-api-2e35f5f074df.herokuapp.com/api/providers/personal-info',
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  }
);

const data = await response.json();
console.log(data);
```

### Approval Request
```bash
curl -X POST https://metromatrix-api-2e35f5f074df.herokuapp.com/api/admin/providers/PROVIDER_ID/approve \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Rejection Request
```bash
curl -X POST https://metromatrix-api-2e35f5f074df.herokuapp.com/api/admin/providers/PROVIDER_ID/reject \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Medical license appears to be expired. Please submit a current, valid license."
  }'
```

---

## Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad Request (validation error) |
| 401 | Unauthorized (missing/invalid token) |
| 403 | Forbidden (not provider/admin) |
| 404 | Not Found |
| 500 | Server Error |

---

## File Upload Constraints

- **Max File Size**: 10MB per file
- **Supported Formats**: PDF, JPG, PNG
- **Max Documents**: 5 per provider (one of each type)
- **Auto-Cleanup**: 90 days (if not verified)

---

## Verification Status Flow

```
User Signs Up
    ↓
Email Verified
    ↓
Provider Type Selected
    ↓
Personal Info + Docs Submitted (status = "pending")
    ↓
Admin Reviews Documents
    ↓
┌─────────────────────────────────┬──────────────────────────────────┐
│                                 │                                  │
Approval → (status = "approved")  Rejection → (status = "rejected")
   ↓                                   ↓
Can Offer Services             Can Resubmit Application
```

---

## Webhook Integration (Future)
Planned webhooks for:
- `provider.verified` - When provider is approved
- `provider.rejected` - When provider is rejected
- `documents.uploaded` - When documents are uploaded
- `documents.verified` - When admin verifies document

---

## Rate Limiting
- Document upload: 5 requests/minute per provider
- Status check: 10 requests/minute per provider
- Admin approval: 30 requests/minute per admin

---

**Last Updated**: January 15, 2024
**API Version**: v48
**Status**: ✅ Production Ready
