# Provider Signup & Verification Flow - Complete Integration Guide

**Version:** v62  
**Updated:** December 3, 2025  
**Backend Status:** ✅ Fully Implemented

---

## 📋 Table of Contents

1. [Flow Overview](#flow-overview)
2. [Complete Flow Diagram](#complete-flow-diagram)
3. [API Endpoints Reference](#api-endpoints-reference)
4. [Frontend Integration Steps](#frontend-integration-steps)
5. [Request/Response Schemas](#requestresponse-schemas)
6. [Error Handling](#error-handling)
7. [Testing Checklist](#testing-checklist)

---

## 🔄 Flow Overview

### New Provider Signup Flow (Mirrors User Flow)

**Provider signup now follows the exact same pattern as user signup:**

```
1. Provider Signup (Email Verification)
   ↓
2. Email Verification Link → Account Created (isVerified=false)
   ↓
3. Provider Submits Documents
   ↓
4. Admin Reviews & Approves → isVerified=true
   ↓
5. Provider Can Login
```

### Key Changes (v62)

✅ **Email Verification First**: Provider data stored in `PendingSignup` table (just like users)  
✅ **Account Created After Verification**: Provider account created with `isVerified=false`  
✅ **Document Submission**: Provider submits documents with `providerId`  
✅ **Admin Approval Required**: Provider can only login after admin sets `isVerified=true`  
✅ **Login Gate**: Login endpoint checks `isVerified` flag before allowing access

---

## 📊 Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          PROVIDER SIGNUP FLOW                           │
└─────────────────────────────────────────────────────────────────────────┘

╔═══════════════════════════════════════════════════════════════════════╗
║  STEP 1: PROVIDER SIGNUP (Email Verification)                        ║
╚═══════════════════════════════════════════════════════════════════════╝

Frontend                           Backend
   │                                  │
   │  POST /api/auth/provider/signup │
   │  {fullName, email, password}    │
   ├─────────────────────────────────>│
   │                                  │ 1. Store in PendingSignup
   │                                  │ 2. Generate verification token
   │                                  │ 3. Send email with link
   │                                  │
   │  Success Response                │
   │<─────────────────────────────────┤
   │  {requiresEmailVerification:true}│
   │                                  │
   
   Show: "Check your email to verify"


╔═══════════════════════════════════════════════════════════════════════╗
║  STEP 2: EMAIL VERIFICATION (Account Creation)                       ║
╚═══════════════════════════════════════════════════════════════════════╝

Provider Clicks Link in Email
   │
   │  GET /verify-email?token=xxx&type=provider
   │  
   │  Backend:
   │  1. Verify token in PendingSignup
   │  2. Create Provider with:
   │     - emailVerified: true
   │     - isVerified: false  ← CANNOT LOGIN YET
   │     - canLogin: false
   │     - onboardingStatus: 'pending_documents'
   │  3. Delete PendingSignup record
   │  4. Return deep link with providerId
   │
   │  Deep Link: metromatrix://verify-success?
   │             verified=true&providerId=xxx&
   │             onboardingStatus=pending_documents&
   │             requiresDocuments=true
   │
   App Receives: Provider account created, needs documents


╔═══════════════════════════════════════════════════════════════════════╗
║  STEP 3: DOCUMENT SUBMISSION                                          ║
╚═══════════════════════════════════════════════════════════════════════╝

Frontend                           Backend
   │                                  │
   │  POST /api/admin/provider-       │
   │       submissions                │
   │  FormData:                       │
   │  - providerId (from step 2)      │
   │  - providerType, city, etc       │
   │  - medicalLicense (file)         │
   │  - degreeCertificate (file)      │
   │  - nationalIdCard (file)         │
   ├─────────────────────────────────>│
   │                                  │ 1. Verify provider exists
   │                                  │ 2. Upload docs to Cloudinary
   │                                  │ 3. Create ProviderSubmission
   │                                  │ 4. Update provider:
   │                                  │    - onboardingStatus: 'pending_approval'
   │                                  │    - isVerified: false (still)
   │                                  │ 5. Notify admin via email
   │                                  │
   │  Success Response                │
   │<─────────────────────────────────┤
   │  {status: 'pending_review'}      │
   │                                  │
   
   Show: "Documents submitted! Wait for approval"


╔═══════════════════════════════════════════════════════════════════════╗
║  STEP 4: ADMIN APPROVAL                                               ║
╚═══════════════════════════════════════════════════════════════════════╝

Admin Dashboard                    Backend
   │                                  │
   │  GET /api/admin/provider-        │
   │      submissions                 │
   ├─────────────────────────────────>│
   │  Returns: List of pending        │
   │<─────────────────────────────────┤
   │                                  │
   │  Admin Reviews Documents         │
   │                                  │
   │  POST /api/admin/provider-       │
   │       submissions/:id/approve    │
   ├─────────────────────────────────>│
   │                                  │ 1. Find Provider by email
   │                                  │ 2. Update Provider:
   │                                  │    - isVerified: true  ← CAN LOGIN NOW
   │                                  │    - canLogin: true
   │                                  │    - onboardingStatus: 'approved'
   │                                  │ 3. Update submission status
   │                                  │ 4. Send approval email to provider
   │                                  │
   │  Success Response                │
   │<─────────────────────────────────┤
   │                                  │
   
   Provider receives email: "You can now login!"


╔═══════════════════════════════════════════════════════════════════════╗
║  STEP 5: PROVIDER LOGIN                                               ║
╚═══════════════════════════════════════════════════════════════════════╝

Frontend                           Backend
   │                                  │
   │  POST /api/auth/provider/login   │
   │  {email, password}               │
   ├─────────────────────────────────>│
   │                                  │ 1. Verify credentials
   │                                  │ 2. Check emailVerified
   │                                  │ 3. Check isVerified ← CRITICAL
   │                                  │    - If false: Reject login
   │                                  │    - If true: Allow login
   │                                  │ 4. Generate tokens
   │                                  │
   │  Success Response                │
   │<─────────────────────────────────┤
   │  {accessToken, provider}         │
   │                                  │
   
   Navigate to: Provider Dashboard
```

---

## 🎯 API Endpoints Reference

### 1. Provider Signup

**Endpoint:** `POST /api/auth/provider/signup`  
**Access:** Public  
**Description:** Start provider registration (stores in PendingSignup)

**Request Body:**
```json
{
  "fullName": "Dr. John Smith",
  "email": "john.smith@example.com",
  "phoneNumber": "1234567890",
  "password": "SecurePass123!"
}
```

**Success Response (201):**
```json
{
  "success": true,
  "message": "Provider signup successful! Please verify your email to complete registration.",
  "email": "john.smith@example.com",
  "requiresEmailVerification": true,
  "expiresIn": "24 hours",
  "instructions": "Check your email and click the verification link to complete your provider signup."
}
```

**Error Responses:**
- `400`: Provider already exists / Signup already pending / Missing required fields
- `500`: Server error

**Frontend Action:**
```javascript
// Show success message and redirect to email verification screen
navigation.navigate('EmailVerificationPending', {
  email: response.email,
  userType: 'provider'
});
```

---

### 2. Email Verification (Web Page)

**Endpoint:** `GET /verify-email?token={token}&type=provider`  
**Access:** Public  
**Description:** Verify email and create Provider account

**Query Parameters:**
- `token` (required): Verification token from email
- `type` (required): Must be `"provider"`

**Success Flow:**
1. Backend verifies token in PendingSignup
2. Creates Provider account with `isVerified=false`
3. Returns HTML page with deep link

**Deep Link Format:**
```
metromatrix://verify-success?verified=true&providerId={id}&email={email}&fullName={name}&onboardingStatus=pending_documents&requiresDocuments=true
```

**Frontend Action:**
```javascript
// Handle deep link in app
Linking.addEventListener('url', (event) => {
  const url = event.url;
  const params = parseDeepLink(url);
  
  if (params.verified === 'true' && params.requiresDocuments === 'true') {
    // Store providerId for document submission
    await AsyncStorage.setItem('providerId', params.providerId);
    await AsyncStorage.setItem('providerEmail', params.email);
    
    // Navigate to document upload screen
    navigation.navigate('ProviderDocumentUpload', {
      providerId: params.providerId,
      email: params.email
    });
  }
});
```

---

### 3. Email Verification (API - Alternative)

**Endpoint:** `GET /api/verify-email?token={token}&type=provider`  
**Access:** Public  
**Description:** Verify email via API (returns JSON instead of HTML)

**Success Response (200):**
```json
{
  "success": true,
  "message": "Provider email verified successfully! Please submit your documents for admin review.",
  "emailVerified": true,
  "requiresDocuments": true,
  "onboardingStatus": "pending_documents",
  "provider": {
    "id": "675e1234abcd5678ef901234",
    "fullName": "Dr. John Smith",
    "email": "john.smith@example.com",
    "phoneNumber": "1234567890",
    "canLogin": false,
    "isVerified": false
  }
}
```

**Error Responses:**
- `400`: Invalid/expired token / Missing token
- `500`: Server error

---

### 4. Submit Provider Documents

**Endpoint:** `POST /api/admin/provider-submissions`  
**Access:** Public (requires providerId from email verification)  
**Content-Type:** `multipart/form-data`  
**Description:** Submit professional documents for admin review

**Request Body (FormData):**
```javascript
const formData = new FormData();

// Required Fields
formData.append('providerId', '675e1234abcd5678ef901234'); // From email verification
formData.append('email', 'john.smith@example.com');
formData.append('providerType', 'doctor'); // doctor | home_service | vendor
formData.append('city', 'Karachi');
formData.append('idNumber', 'ID-12345678');

// Optional Fields
formData.append('providerSubType', 'electrician'); // For home_service only
formData.append('specialty', 'Cardiology'); // For doctors
formData.append('experience', '5 years');
formData.append('qualification', 'MBBS, MD');
formData.append('bio', 'Experienced cardiologist...');
formData.append('address', JSON.stringify({
  street: '123 Main St',
  city: 'Karachi',
  postalCode: '75500',
  country: 'Pakistan'
}));
formData.append('services', JSON.stringify(['Consultation', 'Surgery']));
formData.append('consultationFee', '2000');

// Required Document Files
formData.append('medicalLicense', {
  uri: 'file://path/to/medical-license.pdf',
  type: 'application/pdf',
  name: 'medical-license.pdf'
});
formData.append('degreeCertificate', {
  uri: 'file://path/to/degree.pdf',
  type: 'application/pdf',
  name: 'degree-certificate.pdf'
});
formData.append('nationalIdCard', {
  uri: 'file://path/to/id-card.jpg',
  type: 'image/jpeg',
  name: 'national-id.jpg'
});

// Optional Files
formData.append('profilePhoto', profilePhotoFile);
formData.append('additionalCertificates', cert1);
formData.append('additionalCertificates', cert2);
```

**Success Response (201):**
```json
{
  "success": true,
  "message": "Your documents have been submitted successfully! Please wait for admin approval.",
  "submissionId": "675e5678abcd1234ef905678",
  "providerId": "675e1234abcd5678ef901234",
  "status": "pending_review",
  "onboardingStatus": "pending_approval"
}
```

**Error Responses:**
- `404`: Provider not found (verify email first)
- `400`: Email not verified / Pending submission exists / Missing required fields
- `500`: Upload error

**Frontend Action:**
```javascript
// Show success message
Alert.alert(
  'Documents Submitted',
  'Your documents have been submitted for review. We will notify you once approved!',
  [{ text: 'OK', onPress: () => navigation.navigate('ProviderStatus') }]
);

// Navigate to status screen
navigation.navigate('ProviderPendingApproval', {
  submissionId: response.submissionId
});
```

---

### 5. Check Submission Status

**Endpoint:** `GET /api/admin/provider-submissions/check-status?email={email}`  
**Access:** Public  
**Description:** Check provider submission status

**Query Parameters:**
- `email` (required): Provider email

**Success Response (200):**
```json
{
  "success": true,
  "status": "pending_review",
  "submissionId": "675e5678abcd1234ef905678",
  "submittedAt": "2025-12-03T10:30:00.000Z"
}
```

**Status Values:**
- `pending_review`: Awaiting admin review
- `approved`: Admin approved (can login)
- `rejected`: Admin rejected (can resubmit)

**Frontend Use Case:**
```javascript
// Poll for status updates
useEffect(() => {
  const checkStatus = async () => {
    const response = await fetch(
      `${API_URL}/api/admin/provider-submissions/check-status?email=${email}`
    );
    const data = await response.json();
    
    if (data.status === 'approved') {
      // Show success and navigate to login
      navigation.navigate('ProviderLogin');
    }
  };
  
  const interval = setInterval(checkStatus, 30000); // Check every 30s
  return () => clearInterval(interval);
}, []);
```

---

### 6. Provider Login

**Endpoint:** `POST /api/auth/provider/login`  
**Access:** Public  
**Description:** Login provider (only if admin approved)

**Request Body:**
```json
{
  "email": "john.smith@example.com",
  "password": "SecurePass123!"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "message": "Login successful!",
  "provider": {
    "id": "675e1234abcd5678ef901234",
    "fullName": "Dr. John Smith",
    "email": "john.smith@example.com",
    "phoneNumber": "1234567890",
    "providerType": "doctor",
    "providerSubType": null,
    "onboardingStatus": "approved",
    "profileComplete": false,
    "verificationStatus": "approved",
    "isVerified": true,
    "city": "Karachi",
    "ratings": {
      "average": 0,
      "count": 0
    }
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Error Responses:**
- `401`: Invalid email or password
- `403`: Email not verified / Admin approval pending / Application rejected

**Error Response Examples:**

**Email Not Verified:**
```json
{
  "success": false,
  "message": "Please verify your email before logging in"
}
```

**Documents Not Submitted:**
```json
{
  "success": false,
  "message": "Please submit your professional documents for admin review."
}
```

**Awaiting Admin Approval:**
```json
{
  "success": false,
  "message": "Your documents have been submitted and are under admin review. Please wait for approval."
}
```

**Application Rejected:**
```json
{
  "success": false,
  "message": "Your application was rejected. Reason: Insufficient documentation. You can resubmit your documents."
}
```

**Frontend Action:**
```javascript
try {
  const response = await loginProvider(email, password);
  
  // Store tokens
  await AsyncStorage.setItem('accessToken', response.accessToken);
  await AsyncStorage.setItem('refreshToken', response.refreshToken);
  await AsyncStorage.setItem('userType', 'provider');
  
  // Navigate to dashboard
  navigation.navigate('ProviderDashboard');
  
} catch (error) {
  if (error.status === 403) {
    // Show specific error message
    if (error.message.includes('documents')) {
      navigation.navigate('ProviderDocumentUpload');
    } else if (error.message.includes('review')) {
      navigation.navigate('ProviderPendingApproval');
    } else if (error.message.includes('rejected')) {
      Alert.alert('Application Rejected', error.message);
    }
  }
}
```

---

### 7. Admin: Get Pending Submissions

**Endpoint:** `GET /api/admin/provider-submissions?status=pending_review`  
**Access:** Private (Admin only)  
**Headers:** `Authorization: Bearer {adminToken}`  
**Description:** Get list of provider submissions awaiting review

**Success Response (200):**
```json
{
  "success": true,
  "count": 5,
  "submissions": [
    {
      "_id": "675e5678abcd1234ef905678",
      "providerId": "675e1234abcd5678ef901234",
      "fullName": "Dr. John Smith",
      "email": "john.smith@example.com",
      "phoneNumber": "1234567890",
      "providerType": "doctor",
      "specialty": "Cardiology",
      "city": "Karachi",
      "status": "pending_review",
      "submittedAt": "2025-12-03T10:30:00.000Z",
      "documents": {
        "medicalLicense": {
          "url": "https://res.cloudinary.com/.../medical-license.pdf",
          "publicId": "metromatrix/documents/abc123"
        },
        "degreeCertificate": {
          "url": "https://res.cloudinary.com/.../degree.pdf",
          "publicId": "metromatrix/documents/def456"
        },
        "nationalIdCard": {
          "url": "https://res.cloudinary.com/.../id-card.jpg",
          "publicId": "metromatrix/documents/ghi789"
        }
      }
    }
  ]
}
```

---

### 8. Admin: Approve Provider Submission

**Endpoint:** `POST /api/admin/provider-submissions/:id/approve`  
**Access:** Private (Admin only)  
**Headers:** `Authorization: Bearer {adminToken}`  
**Description:** Approve provider submission and enable login

**Request:**
```
POST /api/admin/provider-submissions/675e5678abcd1234ef905678/approve
```

**Success Response (200):**
```json
{
  "success": true,
  "message": "Provider application approved successfully. Provider can now login.",
  "provider": {
    "id": "675e1234abcd5678ef901234",
    "fullName": "Dr. John Smith",
    "email": "john.smith@example.com",
    "providerType": "doctor",
    "onboardingStatus": "approved",
    "isVerified": true,
    "canLogin": true
  }
}
```

**Backend Actions:**
1. Updates Provider: `isVerified=true`, `canLogin=true`, `onboardingStatus='approved'`
2. Updates ProviderSubmission: `status='approved'`
3. Sends approval email to provider
4. Logs admin activity

**Email Sent to Provider:**
```
Subject: ✅ Your Provider Account Has Been Approved! - MetroMatrix

Congratulations!

Your provider application has been approved! You can now login and start 
offering your services on MetroMatrix.

Next Steps:
1. Login to your account using your email and password
2. Complete your profile information
3. Set your availability schedule
4. Start receiving service requests
```

---

### 9. Admin: Reject Provider Submission

**Endpoint:** `POST /api/admin/provider-submissions/:id/reject`  
**Access:** Private (Admin only)  
**Headers:** `Authorization: Bearer {adminToken}`  
**Description:** Reject provider submission with reason

**Request Body:**
```json
{
  "rejectionReason": "Medical license document is not clear. Please resubmit a clearer copy.",
  "adminNotes": "Document quality issue"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "message": "Provider application rejected"
}
```

**Backend Actions:**
1. Updates Provider: `onboardingStatus='rejected'`, `isVerified=false`, stores rejection reason
2. Updates ProviderSubmission: `status='rejected'`
3. Sends rejection email to provider
4. Provider can resubmit documents

---

## 🛠️ Frontend Integration Steps

### Step 1: Provider Signup Screen

```javascript
import React, { useState } from 'react';
import { View, TextInput, Button, Alert } from 'react-native';

const ProviderSignupScreen = ({ navigation }) => {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSignup = async () => {
    if (!fullName || !email || !phoneNumber || !password) {
      Alert.alert('Error', 'Please fill all fields');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/api/auth/provider/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, email, phoneNumber, password }),
      });

      const data = await response.json();

      if (data.success) {
        // Store email for later reference
        await AsyncStorage.setItem('pendingProviderEmail', email);
        
        navigation.navigate('EmailVerificationPending', {
          email: data.email,
          userType: 'provider',
        });
      } else {
        Alert.alert('Signup Failed', data.message);
      }
    } catch (error) {
      Alert.alert('Error', 'Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <TextInput
        placeholder="Full Name"
        value={fullName}
        onChangeText={setFullName}
      />
      <TextInput
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      <TextInput
        placeholder="Phone Number"
        value={phoneNumber}
        onChangeText={setPhoneNumber}
        keyboardType="phone-pad"
      />
      <TextInput
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />
      <Button
        title={loading ? 'Signing Up...' : 'Sign Up as Provider'}
        onPress={handleSignup}
        disabled={loading}
      />
    </View>
  );
};
```

---

### Step 2: Handle Email Verification Deep Link

```javascript
// App.js or DeepLinkHandler.js
import { useEffect } from 'react';
import { Linking } from 'react-native';

const useDeepLinks = (navigation) => {
  useEffect(() => {
    // Handle initial URL (app opened from link)
    Linking.getInitialURL().then(url => {
      if (url) handleDeepLink(url);
    });

    // Handle subsequent URLs (app already open)
    const subscription = Linking.addEventListener('url', (event) => {
      handleDeepLink(event.url);
    });

    return () => subscription.remove();
  }, []);

  const handleDeepLink = async (url) => {
    if (!url) return;

    // Parse deep link: metromatrix://verify-success?params
    const params = parseQueryParams(url);

    if (params.verified === 'true' && params.requiresDocuments === 'true') {
      // Store provider info
      await AsyncStorage.setItem('providerId', params.providerId);
      await AsyncStorage.setItem('providerEmail', params.email);
      await AsyncStorage.setItem('providerName', params.fullName);

      // Navigate to document upload
      navigation.navigate('ProviderDocumentUpload', {
        providerId: params.providerId,
        email: params.email,
        fullName: params.fullName,
      });
    }
  };

  const parseQueryParams = (url) => {
    const queryString = url.split('?')[1];
    if (!queryString) return {};
    
    return queryString.split('&').reduce((acc, param) => {
      const [key, value] = param.split('=');
      acc[decodeURIComponent(key)] = decodeURIComponent(value);
      return acc;
    }, {});
  };
};

export default useDeepLinks;
```

---

### Step 3: Document Upload Screen

```javascript
import React, { useState } from 'react';
import { View, Button, Alert, Text } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

const ProviderDocumentUpload = ({ route, navigation }) => {
  const { providerId, email } = route.params;
  const [documents, setDocuments] = useState({
    medicalLicense: null,
    degreeCertificate: null,
    nationalIdCard: null,
    profilePhoto: null,
  });
  const [providerType, setProviderType] = useState('doctor');
  const [city, setCity] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [experience, setExperience] = useState('');
  const [loading, setLoading] = useState(false);

  const pickDocument = async (documentType) => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*'],
        copyToCacheDirectory: true,
      });

      if (result.type === 'success') {
        setDocuments(prev => ({
          ...prev,
          [documentType]: result,
        }));
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to pick document');
    }
  };

  const pickProfilePhoto = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });

    if (!result.cancelled) {
      setDocuments(prev => ({
        ...prev,
        profilePhoto: result,
      }));
    }
  };

  const submitDocuments = async () => {
    // Validate required fields
    if (!providerType || !city || !idNumber) {
      Alert.alert('Error', 'Please fill all required fields');
      return;
    }

    if (!documents.medicalLicense || !documents.degreeCertificate || !documents.nationalIdCard) {
      Alert.alert('Error', 'Please upload all required documents');
      return;
    }

    setLoading(true);

    try {
      const formData = new FormData();
      
      // Add text fields
      formData.append('providerId', providerId);
      formData.append('email', email);
      formData.append('providerType', providerType);
      formData.append('city', city);
      formData.append('idNumber', idNumber);
      formData.append('specialty', specialty);
      formData.append('experience', experience);

      // Add document files
      Object.keys(documents).forEach(key => {
        const doc = documents[key];
        if (doc) {
          formData.append(key, {
            uri: doc.uri,
            type: doc.mimeType || 'application/pdf',
            name: doc.name || `${key}.pdf`,
          });
        }
      });

      const response = await fetch(`${API_URL}/api/admin/provider-submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        body: formData,
      });

      const data = await response.json();

      if (data.success) {
        Alert.alert(
          'Documents Submitted!',
          'Your documents have been submitted for admin review. We will notify you once approved.',
          [
            {
              text: 'OK',
              onPress: () => navigation.navigate('ProviderPendingApproval', {
                submissionId: data.submissionId,
                email,
              }),
            },
          ]
        );
      } else {
        Alert.alert('Submission Failed', data.message);
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to submit documents. Please try again.');
      console.error('Upload error:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Upload Professional Documents</Text>
      
      {/* Provider Type Picker */}
      <Picker
        selectedValue={providerType}
        onValueChange={setProviderType}
      >
        <Picker.Item label="Doctor" value="doctor" />
        <Picker.Item label="Home Service" value="home_service" />
        <Picker.Item label="Vendor" value="vendor" />
      </Picker>

      {/* City Input */}
      <TextInput
        placeholder="City"
        value={city}
        onChangeText={setCity}
      />

      {/* ID Number Input */}
      <TextInput
        placeholder="National ID Number"
        value={idNumber}
        onChangeText={setIdNumber}
      />

      {/* Specialty (for doctors) */}
      {providerType === 'doctor' && (
        <TextInput
          placeholder="Specialty (e.g., Cardiology)"
          value={specialty}
          onChangeText={setSpecialty}
        />
      )}

      {/* Experience */}
      <TextInput
        placeholder="Years of Experience"
        value={experience}
        onChangeText={setExperience}
      />

      {/* Document Upload Buttons */}
      <Button
        title={documents.medicalLicense ? '✓ Medical License' : 'Upload Medical License'}
        onPress={() => pickDocument('medicalLicense')}
      />
      <Button
        title={documents.degreeCertificate ? '✓ Degree Certificate' : 'Upload Degree Certificate'}
        onPress={() => pickDocument('degreeCertificate')}
      />
      <Button
        title={documents.nationalIdCard ? '✓ National ID Card' : 'Upload National ID Card'}
        onPress={() => pickDocument('nationalIdCard')}
      />
      <Button
        title={documents.profilePhoto ? '✓ Profile Photo' : 'Upload Profile Photo (Optional)'}
        onPress={pickProfilePhoto}
      />

      {/* Submit Button */}
      <Button
        title={loading ? 'Submitting...' : 'Submit Documents'}
        onPress={submitDocuments}
        disabled={loading}
      />
    </View>
  );
};
```

---

### Step 4: Pending Approval Screen

```javascript
import React, { useEffect, useState } from 'react';
import { View, Text, Button, ActivityIndicator } from 'react-native';

const ProviderPendingApproval = ({ route, navigation }) => {
  const { email } = route.params;
  const [status, setStatus] = useState('pending_review');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkStatus();
    
    // Poll for status updates every 30 seconds
    const interval = setInterval(checkStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  const checkStatus = async () => {
    try {
      const response = await fetch(
        `${API_URL}/api/admin/provider-submissions/check-status?email=${email}`
      );
      const data = await response.json();

      if (data.success) {
        setStatus(data.status);
        setLoading(false);

        if (data.status === 'approved') {
          // Approved! Navigate to login
          Alert.alert(
            'Application Approved!',
            'Your provider account has been approved. You can now login.',
            [
              {
                text: 'Login',
                onPress: () => navigation.navigate('ProviderLogin'),
              },
            ]
          );
        }
      }
    } catch (error) {
      console.error('Status check error:', error);
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text>Checking status...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Application Status</Text>
      
      {status === 'pending_review' && (
        <>
          <Text style={styles.status}>⏳ Pending Review</Text>
          <Text style={styles.description}>
            Your documents have been submitted and are under admin review.
            We'll notify you once your application is approved.
          </Text>
        </>
      )}

      {status === 'rejected' && (
        <>
          <Text style={styles.statusRejected}>❌ Rejected</Text>
          <Text style={styles.description}>
            Your application was rejected. Please resubmit your documents.
          </Text>
          <Button
            title="Resubmit Documents"
            onPress={() => navigation.navigate('ProviderDocumentUpload')}
          />
        </>
      )}

      <Button
        title="Refresh Status"
        onPress={checkStatus}
      />
    </View>
  );
};
```

---

### Step 5: Provider Login Screen

```javascript
import React, { useState } from 'react';
import { View, TextInput, Button, Alert } from 'react-native';

const ProviderLoginScreen = ({ navigation }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email || !password) {
      Alert.alert('Error', 'Please enter email and password');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/api/auth/provider/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (data.success) {
        // Store tokens
        await AsyncStorage.setItem('accessToken', data.accessToken);
        await AsyncStorage.setItem('refreshToken', data.refreshToken);
        await AsyncStorage.setItem('userType', 'provider');
        await AsyncStorage.setItem('providerId', data.provider.id);

        // Navigate to dashboard
        navigation.navigate('ProviderDashboard');
      } else {
        // Handle specific error cases
        if (response.status === 403) {
          if (data.message.includes('documents')) {
            Alert.alert(
              'Documents Required',
              data.message,
              [
                {
                  text: 'Upload Documents',
                  onPress: () => navigation.navigate('ProviderDocumentUpload', { email }),
                },
              ]
            );
          } else if (data.message.includes('review')) {
            Alert.alert(
              'Pending Approval',
              data.message,
              [
                {
                  text: 'Check Status',
                  onPress: () => navigation.navigate('ProviderPendingApproval', { email }),
                },
              ]
            );
          } else if (data.message.includes('rejected')) {
            Alert.alert('Application Rejected', data.message);
          } else {
            Alert.alert('Login Failed', data.message);
          }
        } else {
          Alert.alert('Login Failed', data.message);
        }
      }
    } catch (error) {
      Alert.alert('Error', 'Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <TextInput
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      <TextInput
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />
      <Button
        title={loading ? 'Logging in...' : 'Login'}
        onPress={handleLogin}
        disabled={loading}
      />
      <Button
        title="Don't have an account? Sign Up"
        onPress={() => navigation.navigate('ProviderSignup')}
      />
    </View>
  );
};
```

---

## 📦 Request/Response Schemas

### Provider Model Schema

```typescript
interface Provider {
  // Basic Info
  _id: string;
  email: string;
  fullName: string;
  phoneNumber: string;
  profilePhoto?: string;
  
  // Provider Type
  providerType: 'doctor' | 'home_service' | 'vendor' | 'pending';
  providerSubType?: 'electrician' | 'plumber' | 'ac_repairer';
  
  // Professional Info
  specialty?: string;        // For doctors
  profession?: string;       // For home service
  category?: string;         // For vendors
  experience?: string;
  briefDescription?: string;
  
  // Location
  city: string;
  address?: {
    street: string;
    city: string;
    postalCode: string;
    country: string;
  };
  
  // Identification
  idNumber: string;
  
  // Status Fields (CRITICAL)
  emailVerified: boolean;
  isVerified: boolean;       // ✅ Can only login when true
  canLogin: boolean;
  onboardingStatus: 'pending_email' | 'pending_documents' | 'pending_approval' | 'approved' | 'rejected';
  verificationStatus: 'pending' | 'approved' | 'rejected';
  rejectionReason?: string;
  
  // Admin Info
  verifiedBy?: string;       // Admin ID
  approvedAt?: Date;
  
  // Ratings
  ratings: {
    average: number;
    count: number;
  };
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}
```

### ProviderSubmission Model Schema

```typescript
interface ProviderSubmission {
  _id: string;
  providerId: string;        // ✅ Link to Provider account
  
  // Personal Info
  fullName: string;
  email: string;
  phoneNumber: string;
  
  // Provider Info
  providerType: 'doctor' | 'home_service' | 'vendor';
  providerSubType?: string;
  specialty?: string;
  experience?: string;
  qualification?: string;
  city: string;
  address?: object;
  idNumber: string;
  bio?: string;
  services?: string[];
  consultationFee?: string;
  serviceFee?: string;
  
  // Documents
  documents: {
    medicalLicense?: {
      url: string;
      publicId: string;
    };
    degreeCertificate?: {
      url: string;
      publicId: string;
    };
    nationalIdCard?: {
      url: string;
      publicId: string;
    };
    profilePhoto?: {
      url: string;
      publicId: string;
    };
    additionalCertificates?: Array<{
      url: string;
      publicId: string;
      name: string;
    }>;
  };
  
  // Status
  status: 'pending_review' | 'approved' | 'rejected';
  rejectionReason?: string;
  adminNotes?: string;
  
  // Review Info
  reviewedBy?: string;       // Admin ID
  reviewedAt?: Date;
  submittedAt: Date;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}
```

---

## ⚠️ Error Handling

### Common Error Scenarios

#### 1. Provider Tries to Login Before Email Verification

**Request:**
```bash
POST /api/auth/provider/login
{
  "email": "john@example.com",
  "password": "password123"
}
```

**Response (403):**
```json
{
  "success": false,
  "message": "Please verify your email before logging in"
}
```

**Frontend Action:**
- Show alert with verification instructions
- Provide "Resend Verification Email" button

---

#### 2. Provider Tries to Login Before Submitting Documents

**Response (403):**
```json
{
  "success": false,
  "message": "Please submit your professional documents for admin review."
}
```

**Frontend Action:**
- Navigate to `ProviderDocumentUpload` screen
- Pre-fill providerId and email if available

---

#### 3. Provider Tries to Login While Awaiting Approval

**Response (403):**
```json
{
  "success": false,
  "message": "Your documents have been submitted and are under admin review. Please wait for approval."
}
```

**Frontend Action:**
- Navigate to `ProviderPendingApproval` screen
- Show estimated review time (24-48 hours)

---

#### 4. Provider Login After Rejection

**Response (403):**
```json
{
  "success": false,
  "message": "Your application was rejected. Reason: Medical license document is unclear. You can resubmit your documents."
}
```

**Frontend Action:**
- Show rejection reason
- Provide "Resubmit Documents" button
- Navigate to `ProviderDocumentUpload` screen

---

#### 5. Document Upload Without Email Verification

**Response (404):**
```json
{
  "success": false,
  "message": "Provider not found. Please verify your email first."
}
```

**Frontend Action:**
- Redirect to email verification check
- Provide "Resend Verification Email" option

---

#### 6. Duplicate Submission Attempt

**Response (400):**
```json
{
  "success": false,
  "message": "You already have a pending submission. Please wait for admin review."
}
```

**Frontend Action:**
- Navigate to `ProviderPendingApproval` screen
- Show current submission status

---

### Error Handling Example

```javascript
const handleProviderLogin = async (email, password) => {
  try {
    const response = await fetch(`${API_URL}/api/auth/provider/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await response.json();

    if (!data.success) {
      // Handle specific error cases
      switch (response.status) {
        case 403:
          if (data.message.includes('verify your email')) {
            // Email not verified
            Alert.alert(
              'Email Verification Required',
              'Please verify your email before logging in.',
              [
                { text: 'Resend Email', onPress: resendVerificationEmail },
                { text: 'OK' },
              ]
            );
          } else if (data.message.includes('submit your professional documents')) {
            // Documents not submitted
            Alert.alert(
              'Documents Required',
              data.message,
              [
                {
                  text: 'Upload Documents',
                  onPress: () => navigation.navigate('ProviderDocumentUpload', { email }),
                },
              ]
            );
          } else if (data.message.includes('under admin review')) {
            // Awaiting approval
            Alert.alert(
              'Approval Pending',
              data.message,
              [
                {
                  text: 'Check Status',
                  onPress: () => navigation.navigate('ProviderPendingApproval', { email }),
                },
              ]
            );
          } else if (data.message.includes('rejected')) {
            // Application rejected
            const reason = extractRejectionReason(data.message);
            Alert.alert(
              'Application Rejected',
              `Reason: ${reason}\n\nYou can resubmit your documents with corrections.`,
              [
                {
                  text: 'Resubmit',
                  onPress: () => navigation.navigate('ProviderDocumentUpload', { email }),
                },
                { text: 'Cancel', style: 'cancel' },
              ]
            );
          }
          break;

        case 401:
          Alert.alert('Login Failed', 'Invalid email or password');
          break;

        default:
          Alert.alert('Error', data.message || 'An error occurred');
      }
      return null;
    }

    // Success - store tokens and navigate
    await AsyncStorage.setItem('accessToken', data.accessToken);
    await AsyncStorage.setItem('refreshToken', data.refreshToken);
    await AsyncStorage.setItem('userType', 'provider');
    
    return data;

  } catch (error) {
    Alert.alert('Network Error', 'Please check your connection and try again.');
    return null;
  }
};
```

---

## ✅ Testing Checklist

### Backend Testing

- [ ] **Provider Signup**
  - [ ] Valid signup creates PendingSignup record
  - [ ] Verification email sent successfully
  - [ ] Duplicate email rejected
  - [ ] Token expires after 24 hours

- [ ] **Email Verification**
  - [ ] Valid token creates Provider with `isVerified=false`
  - [ ] Invalid token rejected
  - [ ] Expired token rejected
  - [ ] PendingSignup deleted after success
  - [ ] Deep link includes providerId

- [ ] **Document Submission**
  - [ ] Requires valid providerId
  - [ ] Accepts 3 required documents
  - [ ] Uploads to Cloudinary successfully
  - [ ] Creates ProviderSubmission record
  - [ ] Updates Provider `onboardingStatus='pending_approval'`
  - [ ] Sends admin notification email
  - [ ] Rejects duplicate submissions

- [ ] **Provider Login (Before Approval)**
  - [ ] Rejects login with `isVerified=false`
  - [ ] Returns correct error message based on status
  - [ ] Works correctly after admin approval

- [ ] **Admin Approval**
  - [ ] Sets Provider `isVerified=true`
  - [ ] Sets `canLogin=true`
  - [ ] Updates `onboardingStatus='approved'`
  - [ ] Updates submission status
  - [ ] Sends approval email to provider

- [ ] **Admin Rejection**
  - [ ] Updates Provider `onboardingStatus='rejected'`
  - [ ] Stores rejection reason
  - [ ] Provider can resubmit
  - [ ] Sends rejection email

- [ ] **Provider Login (After Approval)**
  - [ ] Login successful with valid credentials
  - [ ] Returns access and refresh tokens
  - [ ] Returns complete provider object

### Frontend Testing

- [ ] **Signup Flow**
  - [ ] Form validation works
  - [ ] Success navigates to email verification screen
  - [ ] Error messages displayed

- [ ] **Deep Link Handling**
  - [ ] App opens from email link
  - [ ] providerId extracted correctly
  - [ ] Navigates to document upload

- [ ] **Document Upload**
  - [ ] File picker works for PDFs
  - [ ] File picker works for images
  - [ ] FormData constructed correctly
  - [ ] Upload progress shown
  - [ ] Success navigates to pending screen

- [ ] **Status Polling**
  - [ ] Status checked every 30 seconds
  - [ ] Approval detected and user notified
  - [ ] Rejection detected and user notified

- [ ] **Login Flow**
  - [ ] Error handling for all statuses
  - [ ] Correct navigation based on error
  - [ ] Success stores tokens and navigates

### End-to-End Testing

- [ ] Complete flow: Signup → Verify → Upload → Admin Approve → Login
- [ ] Rejection flow: Upload → Admin Reject → Resubmit
- [ ] Email delivery working
- [ ] Deep links working on iOS and Android
- [ ] Cloudinary uploads successful
- [ ] Token refresh working

---

## 📝 Summary

### Key Points

1. **Provider signup mirrors user signup**: Email verification first, then account creation
2. **isVerified flag is critical**: Provider cannot login until admin sets this to `true`
3. **Provider account exists before document upload**: Created during email verification with `isVerified=false`
4. **Document submission updates existing provider**: Links to providerId from email verification
5. **Admin approval enables login**: Sets `isVerified=true` and `canLogin=true`
6. **Three onboarding statuses**: `pending_documents` → `pending_approval` → `approved`

### Database Flow

```
PendingSignup (temporary)
   ↓ (email verified)
Provider (isVerified=false, onboardingStatus='pending_documents')
   ↓ (documents submitted)
Provider (isVerified=false, onboardingStatus='pending_approval')
   ↓ (admin approves)
Provider (isVerified=true, onboardingStatus='approved', canLogin=true)
   ↓ (can now login)
✅ Full access to provider dashboard
```

---

## 🚀 Next Steps

1. **Update frontend navigation** to handle new flow
2. **Test email delivery** in production
3. **Configure deep link handlers** for iOS and Android
4. **Add push notifications** for approval status changes
5. **Implement status polling** or WebSocket for real-time updates
6. **Add resubmission flow** for rejected applications

---

**For questions or support, contact the backend team.**

**Last Updated:** December 3, 2025  
**Backend Version:** v62  
**Production URL:** https://metromatrix-api-2e35f5f074df.herokuapp.com
