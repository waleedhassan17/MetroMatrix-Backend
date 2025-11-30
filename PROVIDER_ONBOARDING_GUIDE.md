# Provider Onboarding System - Complete Guide

## Overview
The provider onboarding system is a complete workflow that guides providers through account creation, personal information submission, document verification, and final approval. This guide documents all endpoints involved in this process.

## Architecture

### Models Involved
- **Provider**: Main provider account with verification status and onboarding tracking
- **ProviderDocument**: Separate collection for storing and tracking individual documents
- **User** (Auth): Links to email-verified user account

### Workflow Stages
1. **Email Verification** - User verifies email during signup
2. **Provider Type Selection & Onboarding** - Provider chooses type and submits personal info + documents
3. **Admin Review** - Admin reviews all documents and provider information
4. **Approval/Rejection** - Admin approves or rejects with feedback
5. **Access Grant** - Provider can start offering services

---

## Provider Endpoints

### 1. Submit Personal Information with Documents
**POST** `/api/providers/personal-info`

Unified endpoint for submitting all provider personal information and document uploads in a single request.

#### Authentication
- Required: Yes (Provider only)
- Header: `Authorization: Bearer <accessToken>`

#### Request Format
- Content-Type: `multipart/form-data`
- Body Parameters:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| providerType | string | Yes | One of: `doctor`, `home_service`, `vendor` |
| fullName | string | Yes | Provider's full name |
| email | string | Yes | Valid email address |
| phoneNumber | string | Yes | Contact phone number |
| city | string | Yes | Service location/city |
| idNumber | string | Yes | National ID or business registration number |
| experience | string | Yes | Years of experience or start year |
| rate | number | No | Service rate/hourly rate |
| briefDescription | string | No | Short bio/service description |
| specialty | string | Conditional | Required if `providerType='doctor'`. E.g., "Cardiology", "General Practice" |
| profession | string | Conditional | Required if `providerType='home_service'`. E.g., "Plumber", "Electrician" |
| category | string | Conditional | Required if `providerType='vendor'`. E.g., "Electronics", "Clothing" |
| businessName | string | Conditional | Required if `providerType='vendor'`. Business/shop name |
| providerSubType | string | Conditional | Optional subtype for home_service |
| medicalLicense | file | Conditional | PDF/Image, required if `providerType='doctor'` |
| degreeCertificate | file | No | PDF of degree certificate |
| professionalCertificate | file | No | PDF of professional/trade certificate |
| businessLicense | file | Conditional | Required if `providerType='vendor'` |
| nationalIdCard | file | Yes | Clear photo of national ID (required for all) |

#### Example Request (cURL)
```bash
curl -X POST http://localhost:5000/api/providers/personal-info \
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
  -F "briefDescription=Expert cardiologist with 10 years experience" \
  -F "medicalLicense=@license.pdf" \
  -F "nationalIdCard=@id.jpg"
```

#### Success Response (200 OK)
```json
{
  "success": true,
  "message": "Profile submitted for review. Admin will review your documents and contact you within 24 hours.",
  "provider": {
    "id": "507f1f77bcf86cd799439011",
    "fullName": "Dr. Ahmed Hassan",
    "email": "ahmed@example.com",
    "providerType": "doctor",
    "verificationStatus": "pending",
    "onboardingStep": 1
  },
  "documents": [
    {
      "id": "507f1f77bcf86cd799439012",
      "documentType": "medicalLicense",
      "fileName": "license.pdf",
      "uploadedAt": "2024-01-15T10:30:00Z",
      "verified": false
    },
    {
      "id": "507f1f77bcf86cd799439013",
      "documentType": "nationalIdCard",
      "fileName": "id.jpg",
      "uploadedAt": "2024-01-15T10:30:00Z",
      "verified": false
    }
  ]
}
```

#### Error Responses

**400 Bad Request** - Missing required fields
```json
{
  "success": false,
  "error": "Missing required fields: providerType, fullName, email, phoneNumber, city, idNumber",
  "code": "VALIDATION_ERROR"
}
```

**400 Bad Request** - National ID missing
```json
{
  "success": false,
  "error": "National ID Card is required",
  "code": "MISSING_NATIONAL_ID"
}
```

**404 Not Found** - Provider not found
```json
{
  "success": false,
  "error": "Provider not found",
  "code": "NOT_FOUND"
}
```

---

### 2. Get Provider Profile
**GET** `/api/providers/profile`

Retrieve authenticated provider's complete profile information.

#### Authentication
- Required: Yes (Provider only)

#### Success Response (200 OK)
```json
{
  "success": true,
  "provider": {
    "id": "507f1f77bcf86cd799439011",
    "fullName": "Dr. Ahmed Hassan",
    "email": "ahmed@example.com",
    "phoneNumber": "+201234567890",
    "providerType": "doctor",
    "specialty": "Cardiology",
    "experience": "10",
    "city": "Cairo",
    "rate": 200,
    "briefDescription": "Expert cardiologist",
    "verificationStatus": "pending",
    "isVerified": false,
    "onboardingStep": 1,
    "createdAt": "2024-01-15T10:00:00Z"
  }
}
```

---

### 3. Check Verification Status
**GET** `/api/providers/verification`

Check the current verification status and document upload progress.

#### Authentication
- Required: Yes (Provider only)

#### Success Response (200 OK)
```json
{
  "success": true,
  "verificationStatus": "pending",
  "isVerified": false,
  "rejectionReason": null,
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
    "nationalIdCard": {
      "uploaded": true,
      "verified": false,
      "verifiedAt": null,
      "rejectionReason": null
    }
  }
}
```

#### Possible Verification Statuses
- `pending` - Submitted but not yet reviewed by admin
- `approved` - Verified and can offer services
- `rejected` - Rejected with reason provided, can reapply

---

## Admin Endpoints

### 1. Get Pending Providers List
**GET** `/api/admin/providers/pending?page=1&limit=10`

Get all providers with pending verification status, including their documents.

#### Authentication
- Required: Yes (Admin only)

#### Query Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| page | number | 1 | Page number for pagination |
| limit | number | 10 | Results per page |

#### Success Response (200 OK)
```json
{
  "success": true,
  "providers": [
    {
      "id": "507f1f77bcf86cd799439011",
      "fullName": "Dr. Ahmed Hassan",
      "email": "ahmed@example.com",
      "phoneNumber": "+201234567890",
      "providerType": "doctor",
      "specialty": "Cardiology",
      "experience": "10",
      "city": "Cairo",
      "rate": 200,
      "briefDescription": "Expert cardiologist",
      "verificationStatus": "pending",
      "createdAt": "2024-01-15T10:00:00Z",
      "documents": [
        {
          "id": "507f1f77bcf86cd799439012",
          "documentType": "medicalLicense",
          "fileName": "license.pdf",
          "fileUrl": "https://res.cloudinary.com/...",
          "fileSize": 245000,
          "uploadedAt": "2024-01-15T10:30:00Z",
          "verified": false
        },
        {
          "id": "507f1f77bcf86cd799439013",
          "documentType": "nationalIdCard",
          "fileName": "id.jpg",
          "fileUrl": "https://res.cloudinary.com/...",
          "fileSize": 156000,
          "uploadedAt": "2024-01-15T10:30:00Z",
          "verified": false
        }
      ]
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 15,
    "pages": 2
  }
}
```

---

### 2. Get Provider Details for Review
**GET** `/api/admin/providers/:id`

Get detailed information about a specific provider including all documents.

#### Authentication
- Required: Yes (Admin only)

#### URL Parameters
- `id` (string) - Provider MongoDB ID

#### Success Response (200 OK)
```json
{
  "success": true,
  "provider": {
    "id": "507f1f77bcf86cd799439011",
    "fullName": "Dr. Ahmed Hassan",
    "email": "ahmed@example.com",
    "phoneNumber": "+201234567890",
    "providerType": "doctor",
    "specialty": "Cardiology",
    "profession": null,
    "category": null,
    "experience": "10",
    "city": "Cairo",
    "rate": 200,
    "briefDescription": "Expert cardiologist with 10 years experience",
    "idNumber": "12345678",
    "verificationStatus": "pending",
    "isVerified": false,
    "onboardingStep": 1,
    "createdAt": "2024-01-15T10:00:00Z",
    "documents": [
      {
        "id": "507f1f77bcf86cd799439012",
        "documentType": "medicalLicense",
        "fileName": "license.pdf",
        "fileUrl": "https://res.cloudinary.com/metromatrix/image/upload/v1234567890/license_abc123.pdf",
        "fileSize": 245000,
        "mimeType": "application/pdf",
        "uploadedAt": "2024-01-15T10:30:00Z",
        "verified": false,
        "verifiedAt": null,
        "verifiedBy": null,
        "rejectionReason": null
      },
      {
        "id": "507f1f77bcf86cd799439013",
        "documentType": "nationalIdCard",
        "fileName": "id.jpg",
        "fileUrl": "https://res.cloudinary.com/metromatrix/image/upload/v1234567890/national_id_def456.jpg",
        "fileSize": 156000,
        "mimeType": "image/jpeg",
        "uploadedAt": "2024-01-15T10:30:00Z",
        "verified": false,
        "verifiedAt": null,
        "verifiedBy": null,
        "rejectionReason": null
      }
    ]
  }
}
```

---

### 3. Approve Provider
**POST** `/api/admin/providers/:id/approve`

Approve a provider's application, allowing them to start offering services.

#### Authentication
- Required: Yes (Admin only)

#### URL Parameters
- `id` (string) - Provider MongoDB ID

#### Request Body
No body required (optional empty object `{}`)

#### Success Response (200 OK)
```json
{
  "success": true,
  "message": "Provider approved successfully",
  "provider": {
    "id": "507f1f77bcf86cd799439011",
    "fullName": "Dr. Ahmed Hassan",
    "verificationStatus": "approved"
  }
}
```

#### Side Effects
- Provider's `verificationStatus` set to `approved`
- Provider receives approval email notification
- Provider can now appear in public provider listings
- Admin activity logged in Admin model
- Admin's `totalProvidersApproved` stat incremented

---

### 4. Reject Provider
**POST** `/api/admin/providers/:id/reject`

Reject a provider's application with explanation.

#### Authentication
- Required: Yes (Admin only)

#### URL Parameters
- `id` (string) - Provider MongoDB ID

#### Request Body
```json
{
  "reason": "Medical license appears to be expired. Please submit a current license."
}
```

#### Body Parameters
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| reason | string | Yes | Reason for rejection (shown to provider) |

#### Success Response (200 OK)
```json
{
  "success": true,
  "message": "Provider rejected successfully",
  "provider": {
    "id": "507f1f77bcf86cd799439011",
    "fullName": "Dr. Ahmed Hassan",
    "verificationStatus": "rejected",
    "rejectionReason": "Medical license appears to be expired. Please submit a current license."
  }
}
```

#### Example cURL Request
```bash
curl -X POST http://localhost:5000/api/admin/providers/507f1f77bcf86cd799439011/reject \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Medical license appears to be expired. Please submit a current license."
  }'
```

#### Side Effects
- Provider's `verificationStatus` set to `rejected`
- `rejectionReason` stored for provider reference
- Provider receives rejection notification email with reason
- Admin activity logged
- Admin's `totalProvidersRejected` stat incremented

---

### 5. Get All Providers
**GET** `/api/admin/providers?page=1&limit=10`

Get all providers (pending, approved, or rejected) with filtering options.

#### Authentication
- Required: Yes (Admin only)

#### Query Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| page | number | 1 | Page number |
| limit | number | 10 | Results per page |
| status | string | all | Filter by status: `pending`, `approved`, `rejected`, `all` |

#### Success Response (200 OK)
```json
{
  "success": true,
  "providers": [
    {
      "id": "507f1f77bcf86cd799439011",
      "fullName": "Dr. Ahmed Hassan",
      "email": "ahmed@example.com",
      "providerType": "doctor",
      "verificationStatus": "approved",
      "createdAt": "2024-01-15T10:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 45,
    "pages": 5
  }
}
```

---

## Email Notifications

### Provider Approval Email
**When:** Admin approves provider
**Recipient:** Provider email address
**Subject:** "Your Provider Account Has Been Approved - MetroMatrix"

Template:
```
Dear [Provider Name],

Congratulations! Your provider account has been approved. 
You can now start offering your services on MetroMatrix.

Login to your account to get started.

Best regards,
MetroMatrix Team
```

---

### Provider Rejection Email
**When:** Admin rejects provider application
**Recipient:** Provider email address
**Subject:** "Provider Application Update - MetroMatrix"

Template:
```
Dear [Provider Name],

Unfortunately, your provider application could not be approved at this time.

Reason: [Rejection Reason]

Please address the issues mentioned and you can reapply by updating your information.

Best regards,
MetroMatrix Team
```

---

## Document Types Reference

### For Doctors
- **Medical License**: Government/Board-issued medical license (PDF)
- **Degree Certificate**: Medical degree from accredited institution (PDF)
- **Professional Certificate**: Specialty or additional certifications (PDF)
- **National ID Card**: Clear photo of national identification (JPG/PNG)

### For Home Service Providers
- **Degree Certificate**: Trade school or vocational certification (PDF)
- **Professional Certificate**: Industry-specific certifications (PDF)
- **National ID Card**: Clear photo of national identification (JPG/PNG)

### For Vendors
- **Business License**: Government business registration (PDF)
- **National ID Card**: Clear photo of business owner's ID (JPG/PNG)

### All Providers
- **National ID Card**: Required for all provider types (JPG/PNG, max 10MB)

---

## Validation Rules

### File Validation
- **Accepted Formats**: PDF (documents), JPG/PNG (images)
- **Maximum Size**: 10MB per file
- **Maximum Total Size**: 50MB per provider
- **Required Files**: At minimum - National ID Card

### Text Field Validation
- **Full Name**: Non-empty, max 255 characters
- **Email**: Valid email format, max 255 characters
- **Phone Number**: Non-empty, max 20 characters
- **City**: Non-empty, max 100 characters
- **ID Number**: Non-empty, max 50 characters
- **Experience**: Numeric or text, max 50 characters
- **Rate**: Positive number if provided
- **Description**: Max 1000 characters

### Provider Type Rules
- **Doctor**: Requires specialty, medical license
- **Home Service**: Requires profession/category
- **Vendor**: Requires category, business name, business license

---

## Error Codes

| Code | Status | Description |
|------|--------|-------------|
| VALIDATION_ERROR | 400 | Input validation failed |
| MISSING_NATIONAL_ID | 400 | National ID document required |
| MISSING_REQUIRED_FIELD | 400 | Required field missing |
| FILE_SIZE_EXCEEDED | 400 | File too large |
| UNEXPECTED_FILE | 400 | Unexpected file field |
| UPLOAD_ERROR | 400 | File upload failed |
| NOT_FOUND | 404 | Provider not found |
| ALREADY_APPROVED | 400 | Provider already approved |
| UNAUTHORIZED | 401 | Invalid or missing auth token |
| FORBIDDEN | 403 | Access denied (not admin/provider) |
| SERVER_ERROR | 500 | Internal server error |

---

## Complete Frontend Integration Example

### React Component Flow

```javascript
// Step 1: Collect Provider Type
const [providerType, setProviderType] = useState('doctor');

// Step 2: Collect Personal Information & Documents
const submitOnboarding = async (formData) => {
  const data = new FormData();
  
  // Personal info
  data.append('providerType', formData.providerType);
  data.append('fullName', formData.fullName);
  data.append('email', formData.email);
  data.append('phoneNumber', formData.phoneNumber);
  data.append('city', formData.city);
  data.append('idNumber', formData.idNumber);
  data.append('experience', formData.experience);
  
  // Type-specific fields
  if (formData.providerType === 'doctor') {
    data.append('specialty', formData.specialty);
  }
  
  // Documents
  data.append('nationalIdCard', formData.nationalIdCard);
  if (formData.medicalLicense) {
    data.append('medicalLicense', formData.medicalLicense);
  }
  
  const response = await fetch('/api/providers/personal-info', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: data
  });
  
  return response.json();
};

// Step 3: Check Status
const checkStatus = async () => {
  const response = await fetch('/api/providers/verification', {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  
  const data = await response.json();
  if (data.verificationStatus === 'approved') {
    // Redirect to provider dashboard
  }
};
```

---

## Deployment Notes

- All endpoints use JWT authentication (Bearer tokens)
- Documents stored on Cloudinary with automated cleanup (TTL)
- Email notifications via Nodemailer with branded templates
- Rate limiting: 5 requests per minute for approval/rejection
- Timezone: UTC for all timestamps
- Database: MongoDB/Mongoose with automatic indexing

---

## Updated: v48
Last Modified: January 15, 2024
