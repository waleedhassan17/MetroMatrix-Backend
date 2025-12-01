# 🔐 Admin API Endpoints - Complete Frontend Integration Guide

**Base URL:** `https://metromatrix-api-2e35f5f074df.herokuapp.com/api/admin`

---

## 📋 Table of Contents
1. [Authentication](#authentication)
2. [Public Endpoints (No Auth)](#public-endpoints-no-auth)
3. [Dashboard & Stats](#dashboard--stats)
4. [Provider Management](#provider-management)
5. [Provider Submissions (New Flow)](#provider-submissions-new-flow)
6. [User Management](#user-management)
7. [Post Management](#post-management)
8. [Complete Axios Setup](#complete-axios-setup-example)
9. [React Component Example](#usage-example-in-react-component)

---

## 🔐 Authentication

### 1. Admin Login
```
POST /api/admin/login
```

**Request:**
```json
{
  "email": "admin@metromatrix.com",
  "password": "your_password"
}
```

**Response:**
```json
{
  "success": true,
  "admin": {
    "id": "...",
    "fullName": "Admin Name",
    "email": "admin@metromatrix.com",
    "role": "admin",
    "permissions": [],
    "isSuperAdmin": true
  },
  "accessToken": "eyJhbGc...",
  "refreshToken": "eyJhbGc...",
  "expiresIn": 2592000000
}
```

**Frontend Integration:**
```javascript
const loginAdmin = async (email, password) => {
  const response = await axios.post('/api/admin/login', {
    email,
    password
  });
  
  // Store tokens
  localStorage.setItem('adminToken', response.data.accessToken);
  localStorage.setItem('adminRefreshToken', response.data.refreshToken);
  localStorage.setItem('adminData', JSON.stringify(response.data.admin));
  
  return response.data;
};
```

---

## 🌐 Public Endpoints (No Auth)

### 2. Submit Provider Application
```
POST /api/admin/provider-submissions
Content-Type: multipart/form-data
```

**Request (FormData):**
```javascript
const formData = new FormData();

// Personal Info
formData.append('providerType', 'doctor'); // doctor | home_service | vendor
formData.append('providerSubType', 'general_physician');
formData.append('fullName', 'Dr. John Doe');
formData.append('email', 'john@example.com');
formData.append('phoneNumber', '1234567890');

// Professional Info
formData.append('specialty', 'General Medicine');
formData.append('experience', '5 years');
formData.append('qualification', 'MBBS, MD');
formData.append('bio', 'Experienced physician...');

// Location
formData.append('city', 'New York');
formData.append('address', '123 Main St');
formData.append('idNumber', 'ID123456');

// Pricing
formData.append('consultationFee', '100');
formData.append('serviceFee', '50');

// Services (array as JSON string)
formData.append('services', JSON.stringify(['Consultation', 'Checkup']));

// Documents (files)
formData.append('medicalLicense', medicalLicenseFile);
formData.append('degreeCertificate', degreeFile);
formData.append('nationalIdCard', idCardFile);
formData.append('profilePhoto', photoFile);
// Multiple additional certificates
formData.append('additionalCertificates', cert1File);
formData.append('additionalCertificates', cert2File);
```

**Response:**
```json
{
  "success": true,
  "message": "Your application has been submitted successfully!",
  "submissionId": "submission_id_here",
  "status": "pending_review"
}
```

**Frontend Integration:**
```javascript
const submitProviderApplication = async (formData) => {
  const response = await axios.post(
    '/api/admin/provider-submissions',
    formData,
    {
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    }
  );
  return response.data;
};
```

---

### 3. Check Submission Status
```
GET /api/admin/provider-submissions/check-status?email=provider@example.com
```

**Response (Pending):**
```json
{
  "success": true,
  "status": "pending_review",
  "submissionId": "...",
  "submittedAt": "2025-12-01T10:00:00.000Z"
}
```

**Response (Approved):**
```json
{
  "success": true,
  "status": "approved",
  "submissionId": "...",
  "tokens": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresIn": 2592000000
  },
  "provider": {
    "id": "...",
    "fullName": "Dr. John Doe",
    "email": "john@example.com",
    "providerType": "doctor"
  }
}
```

**Response (Rejected):**
```json
{
  "success": true,
  "status": "rejected",
  "submissionId": "...",
  "rejectionReason": "Incomplete documentation",
  "reviewedAt": "2025-12-01T12:00:00.000Z"
}
```

**Frontend Integration:**
```javascript
const checkSubmissionStatus = async (email) => {
  const response = await axios.get(
    `/api/admin/provider-submissions/check-status?email=${email}`
  );
  return response.data;
};

// Poll for status every 30 seconds
const pollStatus = (email, onStatusChange) => {
  const intervalId = setInterval(async () => {
    try {
      const status = await checkSubmissionStatus(email);
      onStatusChange(status);
      
      if (status.status === 'approved' || status.status === 'rejected') {
        clearInterval(intervalId);
      }
    } catch (error) {
      console.error('Error checking status:', error);
    }
  }, 30000);
  
  return intervalId; // Return to clear later
};
```

---

## 📊 Dashboard & Stats

### 4. Get Dashboard Statistics
```
GET /api/admin/dashboard
Headers: { Authorization: "Bearer <admin_token>" }
```

**Response:**
```json
{
  "success": true,
  "stats": {
    "users": {
      "total": 150,
      "active": 140,
      "recent": 25
    },
    "providers": {
      "total": 50,
      "pending": 10,
      "approved": 35,
      "rejected": 5,
      "active": 30,
      "recent": 8,
      "byType": [
        { "_id": "doctor", "count": 20 },
        { "_id": "home_service", "count": 15 },
        { "_id": "vendor", "count": 15 }
      ]
    },
    "posts": {
      "total": 500
    }
  }
}
```

**Frontend Integration:**
```javascript
const getDashboardStats = async () => {
  const token = localStorage.getItem('adminToken');
  const response = await axios.get('/api/admin/dashboard', {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  return response.data.stats;
};
```

---

## 👥 Provider Management

### 5. Get All Providers
```
GET /api/admin/providers
Headers: { Authorization: "Bearer <admin_token>" }
```

**Response:**
```json
{
  "success": true,
  "count": 50,
  "providers": [
    {
      "_id": "...",
      "fullName": "Dr. John Doe",
      "email": "john@example.com",
      "phoneNumber": "1234567890",
      "providerType": "doctor",
      "city": "New York",
      "verificationStatus": "approved",
      "isActive": true,
      "ratings": {
        "average": 4.5,
        "count": 20
      },
      "createdAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### 6. Get Pending Providers (OLD FLOW)
```
GET /api/admin/providers/pending
Headers: { Authorization: "Bearer <admin_token>" }
```

**Response:**
```json
{
  "success": true,
  "count": 10,
  "providers": [
    {
      "_id": "...",
      "fullName": "Dr. Jane Smith",
      "email": "jane@example.com",
      "providerType": "doctor",
      "verificationStatus": "pending",
      "submittedAt": "2025-12-01T00:00:00.000Z"
    }
  ]
}
```

---

### 7. Get Provider Details
```
GET /api/admin/providers/:id
Headers: { Authorization: "Bearer <admin_token>" }
```

**Response:**
```json
{
  "success": true,
  "provider": {
    "_id": "...",
    "fullName": "Dr. John Doe",
    "email": "john@example.com",
    "phoneNumber": "1234567890",
    "providerType": "doctor",
    "specialty": "General Medicine",
    "experience": "5 years",
    "qualification": "MBBS, MD",
    "city": "New York",
    "address": "123 Main St",
    "bio": "Experienced physician...",
    "verificationStatus": "pending",
    "documents": []
  }
}
```

---

### 8. Approve Provider (OLD FLOW)
```
POST /api/admin/providers/:id/approve
Headers: { Authorization: "Bearer <admin_token>" }
```

**Response:**
```json
{
  "success": true,
  "message": "Provider approved successfully",
  "provider": {},
  "tokens": {
    "accessToken": "...",
    "refreshToken": "..."
  }
}
```

---

### 9. Reject Provider (OLD FLOW)
```
POST /api/admin/providers/:id/reject
Headers: { Authorization: "Bearer <admin_token>" }
Body: { "reason": "Incomplete documentation" }
```

**Response:**
```json
{
  "success": true,
  "message": "Provider rejected successfully"
}
```

---

### 10. Deactivate Provider
```
PUT /api/admin/providers/:id/deactivate
Headers: { Authorization: "Bearer <admin_token>" }
```

**Response:**
```json
{
  "success": true,
  "message": "Provider deactivated successfully"
}
```

---

### 11. Activate Provider
```
PUT /api/admin/providers/:id/activate
Headers: { Authorization: "Bearer <admin_token>" }
```

**Response:**
```json
{
  "success": true,
  "message": "Provider activated successfully"
}
```

---

## 📝 Provider Submissions (New Flow)

### 12. Get All Submissions
```
GET /api/admin/provider-submissions?status=pending_review
Headers: { Authorization: "Bearer <admin_token>" }
```

**Query Params:**
- `status` (optional): `pending_review` | `approved` | `rejected`

**Response:**
```json
{
  "success": true,
  "count": 15,
  "submissions": [
    {
      "_id": "...",
      "fullName": "Dr. John Doe",
      "email": "john@example.com",
      "phoneNumber": "1234567890",
      "providerType": "doctor",
      "city": "New York",
      "status": "pending_review",
      "submittedAt": "2025-12-01T10:00:00.000Z",
      "documents": {
        "medicalLicense": { "url": "cloudinary_url" },
        "degreeCertificate": { "url": "cloudinary_url" },
        "nationalIdCard": { "url": "cloudinary_url" },
        "profilePhoto": { "url": "cloudinary_url" }
      }
    }
  ]
}
```

**Frontend Integration:**
```javascript
const getProviderSubmissions = async (status = null) => {
  const token = localStorage.getItem('adminToken');
  const url = status 
    ? `/api/admin/provider-submissions?status=${status}`
    : '/api/admin/provider-submissions';
    
  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  return response.data;
};
```

---

### 13. Get Submission Details
```
GET /api/admin/provider-submissions/:id
Headers: { Authorization: "Bearer <admin_token>" }
```

**Response:**
```json
{
  "success": true,
  "submission": {
    "_id": "...",
    "providerType": "doctor",
    "providerSubType": "general_physician",
    "fullName": "Dr. John Doe",
    "email": "john@example.com",
    "phoneNumber": "1234567890",
    "specialty": "General Medicine",
    "experience": "5 years",
    "qualification": "MBBS, MD",
    "city": "New York",
    "address": "123 Main St",
    "idNumber": "ID123456",
    "bio": "Experienced physician...",
    "services": ["Consultation", "Checkup"],
    "consultationFee": 100,
    "serviceFee": 50,
    "documents": {
      "medicalLicense": {
        "url": "https://res.cloudinary.com/...",
        "publicId": "..."
      },
      "degreeCertificate": {
        "url": "https://res.cloudinary.com/...",
        "publicId": "..."
      },
      "nationalIdCard": {
        "url": "https://res.cloudinary.com/...",
        "publicId": "..."
      },
      "profilePhoto": {
        "url": "https://res.cloudinary.com/...",
        "publicId": "..."
      },
      "additionalCertificates": [
        {
          "url": "https://res.cloudinary.com/...",
          "publicId": "...",
          "name": "certificate1.pdf"
        }
      ]
    },
    "status": "pending_review",
    "submittedAt": "2025-12-01T10:00:00.000Z"
  }
}
```

---

### 14. Approve Submission
```
POST /api/admin/provider-submissions/:id/approve
Headers: { Authorization: "Bearer <admin_token>" }
```

**Response:**
```json
{
  "success": true,
  "message": "Provider application approved successfully",
  "provider": {
    "id": "...",
    "fullName": "Dr. John Doe",
    "email": "john@example.com",
    "providerType": "doctor",
    "onboardingStatus": "approved"
  },
  "tokens": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresIn": 2592000000
  }
}
```

**Frontend Integration:**
```javascript
const approveSubmission = async (submissionId) => {
  const token = localStorage.getItem('adminToken');
  const response = await axios.post(
    `/api/admin/provider-submissions/${submissionId}/approve`,
    {},
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );
  return response.data;
};
```

---

### 15. Reject Submission
```
POST /api/admin/provider-submissions/:id/reject
Headers: { Authorization: "Bearer <admin_token>" }
Body: {
  "rejectionReason": "Incomplete documentation",
  "adminNotes": "Please upload valid medical license"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Provider application rejected"
}
```

**Frontend Integration:**
```javascript
const rejectSubmission = async (submissionId, reason, notes) => {
  const token = localStorage.getItem('adminToken');
  const response = await axios.post(
    `/api/admin/provider-submissions/${submissionId}/reject`,
    {
      rejectionReason: reason,
      adminNotes: notes
    },
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );
  return response.data;
};
```

---

## 👤 User Management

### 16. Get All Users
```
GET /api/admin/users
Headers: { Authorization: "Bearer <admin_token>" }
```

**Response:**
```json
{
  "success": true,
  "count": 150,
  "users": [
    {
      "_id": "...",
      "fullName": "John Smith",
      "email": "john@example.com",
      "phoneNumber": "1234567890",
      "isActive": true,
      "emailVerified": true,
      "createdAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### 17. Deactivate User
```
PUT /api/admin/users/:id/deactivate
Headers: { Authorization: "Bearer <admin_token>" }
```

**Response:**
```json
{
  "success": true,
  "message": "User deactivated successfully"
}
```

---

### 18. Activate User
```
PUT /api/admin/users/:id/activate
Headers: { Authorization: "Bearer <admin_token>" }
```

**Response:**
```json
{
  "success": true,
  "message": "User activated successfully"
}
```

---

## 📱 Post Management

### 19. Delete Post
```
DELETE /api/admin/posts/:id
Headers: { Authorization: "Bearer <admin_token>" }
```

**Response:**
```json
{
  "success": true,
  "message": "Post deleted successfully"
}
```

---

## 🛠️ Complete Axios Setup Example

```javascript
// api/admin.js
import axios from 'axios';

const BASE_URL = 'https://metromatrix-api-2e35f5f074df.herokuapp.com/api/admin';

// Create axios instance
const adminAPI = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Add token to requests
adminAPI.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('adminToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Handle token expiration
adminAPI.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      // Token expired - logout
      localStorage.removeItem('adminToken');
      localStorage.removeItem('adminRefreshToken');
      localStorage.removeItem('adminData');
      window.location.href = '/admin/login';
    }
    return Promise.reject(error);
  }
);

// Export API methods
export const adminService = {
  // Auth
  login: (email, password) => 
    adminAPI.post('/login', { email, password }),
  
  // Dashboard
  getDashboard: () => 
    adminAPI.get('/dashboard'),
  
  // Provider Submissions
  getSubmissions: (status) => 
    adminAPI.get('/provider-submissions', { params: { status } }),
  
  getSubmissionById: (id) => 
    adminAPI.get(`/provider-submissions/${id}`),
  
  approveSubmission: (id) => 
    adminAPI.post(`/provider-submissions/${id}/approve`),
  
  rejectSubmission: (id, data) => 
    adminAPI.post(`/provider-submissions/${id}/reject`, data),
  
  // Providers
  getAllProviders: () => 
    adminAPI.get('/providers'),
  
  getProviderById: (id) => 
    adminAPI.get(`/providers/${id}`),
  
  deactivateProvider: (id) => 
    adminAPI.put(`/providers/${id}/deactivate`),
  
  activateProvider: (id) => 
    adminAPI.put(`/providers/${id}/activate`),
  
  // Users
  getAllUsers: () => 
    adminAPI.get('/users'),
  
  deactivateUser: (id) => 
    adminAPI.put(`/users/${id}/deactivate`),
  
  activateUser: (id) => 
    adminAPI.put(`/users/${id}/activate`),
  
  // Posts
  deletePost: (id) => 
    adminAPI.delete(`/posts/${id}`)
};
```

---

## 🔄 Usage Example in React Component

```javascript
import { useState, useEffect } from 'react';
import { adminService } from './api/admin';

function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [dashboardData, submissionsData] = await Promise.all([
        adminService.getDashboard(),
        adminService.getSubmissions('pending_review')
      ]);
      
      setStats(dashboardData.data.stats);
      setSubmissions(submissionsData.data.submissions);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (submissionId) => {
    try {
      await adminService.approveSubmission(submissionId);
      alert('Provider approved successfully!');
      loadData(); // Reload data
    } catch (error) {
      alert('Error approving provider: ' + error.message);
    }
  };

  const handleReject = async (submissionId) => {
    const reason = prompt('Enter rejection reason:');
    if (!reason) return;
    
    try {
      await adminService.rejectSubmission(submissionId, {
        rejectionReason: reason
      });
      alert('Provider rejected');
      loadData();
    } catch (error) {
      alert('Error rejecting provider: ' + error.message);
    }
  };

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <h1>Admin Dashboard</h1>
      
      {/* Stats */}
      <div>
        <h2>Statistics</h2>
        <p>Total Users: {stats.users.total}</p>
        <p>Total Providers: {stats.providers.total}</p>
        <p>Pending Submissions: {stats.providers.pending}</p>
      </div>

      {/* Submissions */}
      <div>
        <h2>Pending Submissions</h2>
        {submissions.map(sub => (
          <div key={sub._id}>
            <h3>{sub.fullName}</h3>
            <p>Email: {sub.email}</p>
            <p>Type: {sub.providerType}</p>
            <button onClick={() => handleApprove(sub._id)}>
              Approve
            </button>
            <button onClick={() => handleReject(sub._id)}>
              Reject
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## 📌 Important Notes

1. **Authentication**: All endpoints except login and provider submissions require the `Authorization: Bearer <token>` header
2. **File Uploads**: Use `multipart/form-data` for provider submission with documents
3. **Token Storage**: Store admin tokens in localStorage or secure storage
4. **Error Handling**: Always implement proper error handling for API calls
5. **Token Expiration**: Handle 401 errors by redirecting to login page

---

**Production API Base URL:** `https://metromatrix-api-2e35f5f074df.herokuapp.com`

**Version:** v58 (Current)

**Last Updated:** December 2, 2025
