# 🔐 OTP-Based Password Reset Flow - Frontend Integration

## 📱 Complete Password Reset User Flow

### Step 1: User Requests Password Reset

**Frontend**: User enters email on "Forgot Password" screen

```javascript
// POST /api/auth/forgot-password
const forgotPassword = async (email) => {
  const response = await fetch('https://metromatrix-api-2e35f5f074df.herokuapp.com/api/auth/forgot-password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: email,
      userType: 'user' // or 'provider'
    })
  });

  const data = await response.json();
  
  if (data.success) {
    console.log('✅ OTP sent to email');
    console.log('⏱️ OTP expires in:', data.expiresIn, 'seconds (10 minutes)');
    // Navigate to OTP verification screen
    return true;
  } else {
    console.error('❌ Error:', data.message);
    // Show error: "No account found with this email"
    return false;
  }
};
```

**Response (Success 200)**:
```json
{
  "success": true,
  "message": "Password reset code sent to your email",
  "email": "user@example.com",
  "expiresIn": 600
}
```

**Response (Error 404)**:
```json
{
  "success": false,
  "message": "No account found with this email"
}
```

---

### Step 2: User Enters OTP Code

**Frontend**: User receives 6-digit code via email and enters it on verification screen

```javascript
// POST /api/auth/verify-reset-otp
const verifyOTP = async (email, otp) => {
  const response = await fetch('https://metromatrix-api-2e35f5f074df.herokuapp.com/api/auth/verify-reset-otp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: email,
      otp: otp,
      userType: 'user' // or 'provider'
    })
  });

  const data = await response.json();
  
  if (data.success) {
    console.log('✅ OTP verified successfully');
    console.log('Reset token:', data.resetToken);
    console.log('⏱️ Token expires in:', data.expiresIn, 'seconds (5 minutes)');
    
    // Store resetToken in memory (or state management)
    window.resetToken = data.resetToken;
    
    // Navigate to password reset screen
    return { success: true, resetToken: data.resetToken };
  } else {
    console.error('❌ Error:', data.message);
    // Show error: "Invalid OTP" or "Too many failed attempts"
    return { success: false, message: data.message };
  }
};
```

**Response (Success 200)**:
```json
{
  "success": true,
  "message": "OTP verified successfully",
  "resetToken": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6...",
  "email": "user@example.com",
  "expiresIn": 300
}
```

**Response (Error - Invalid OTP 400)**:
```json
{
  "success": false,
  "message": "Invalid OTP. You have 3 attempts remaining."
}
```

**Response (Error - Too Many Attempts 429)**:
```json
{
  "success": false,
  "message": "Too many failed attempts. Account locked for 30 minutes."
}
```

**Response (Error - Expired 400)**:
```json
{
  "success": false,
  "message": "OTP has expired. Please request a new code."
}
```

---

### Step 3: User Sets New Password

**Frontend**: User enters and confirms new password

```javascript
// POST /api/auth/reset-password
const resetPassword = async (resetToken, newPassword) => {
  const response = await fetch('https://metromatrix-api-2e35f5f074df.herokuapp.com/api/auth/reset-password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      resetToken: resetToken,
      password: newPassword
    })
  });

  const data = await response.json();
  
  if (data.success) {
    console.log('✅ Password reset successfully');
    console.log('User:', data.user);
    
    // Clear resetToken from memory
    window.resetToken = null;
    
    // Show success message
    // Navigate to login screen
    return true;
  } else {
    console.error('❌ Error:', data.message);
    // Show error: "Invalid or expired reset token"
    return false;
  }
};
```

**Response (Success 200)**:
```json
{
  "success": true,
  "message": "Password reset successfully. You can now login with your new password.",
  "userType": "user",
  "email": "user@example.com",
  "user": {
    "id": "user123",
    "email": "user@example.com",
    "fullName": "John Doe"
  }
}
```

**Response (Error - Invalid Token 400)**:
```json
{
  "success": false,
  "message": "Invalid or expired reset token"
}
```

---

### Step 4: User Resend OTP (If Needed)

**Frontend**: If user didn't receive OTP or it expired, request new code

```javascript
// POST /api/auth/resend-reset-otp
const resendOTP = async (email) => {
  const response = await fetch('https://metromatrix-api-2e35f5f074df.herokuapp.com/api/auth/resend-reset-otp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: email,
      userType: 'user' // or 'provider'
    })
  });

  const data = await response.json();
  
  if (data.success) {
    console.log('✅ New OTP sent to email');
    return true;
  } else {
    console.error('❌ Error:', data.message);
    // Show error: "Please wait X seconds before requesting a new code"
    return false;
  }
};
```

**Response (Success 200)**:
```json
{
  "success": true,
  "message": "New password reset code sent to your email",
  "email": "user@example.com",
  "expiresIn": 600
}
```

**Response (Error - Rate Limited 429)**:
```json
{
  "success": false,
  "message": "Please wait 45 seconds before requesting a new code",
  "retryAfter": 45
}
```

---

## 🎯 Frontend Implementation Steps

### Screen 1: Forgot Password (Email Entry)
1. User enters email
2. Click "Send Code"
3. Show confirmation: "Code sent to your email"
4. Show timer: "Code expires in 10:00"
5. Show "Resend Code" button

### Screen 2: OTP Verification
1. Show 6 input fields (or single input) for OTP code
2. Auto-focus next field when digit entered
3. Show remaining attempts
4. Show "Resend Code" button with countdown
5. On error: Show remaining attempts or lock message

### Screen 3: Password Reset
1. Password field (with validation)
2. Confirm password field
3. Password strength indicator
4. Submit button
5. On success: Show success screen with redirect to login

---

## 📋 Complete Code Example

```javascript
import React, { useState } from 'react';

export const PasswordResetFlow = () => {
  const [step, setStep] = useState('email'); // email, otp, password
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [resetToken, setResetToken] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [expiresIn, setExpiresIn] = useState(null);

  const API_BASE = 'https://metromatrix-api-2e35f5f074df.herokuapp.com/api/auth';

  // Step 1: Send OTP
  const handleForgotPassword = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE}/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const data = await response.json();

      if (data.success) {
        setStep('otp');
        setExpiresIn(data.expiresIn);
      } else {
        setError(data.message);
      }
    } catch (err) {
      setError('Failed to send OTP. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Step 2: Verify OTP
  const handleVerifyOTP = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE}/verify-reset-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp }),
      });

      const data = await response.json();

      if (data.success) {
        setResetToken(data.resetToken);
        setStep('password');
        setExpiresIn(data.expiresIn);
      } else {
        setError(data.message);
      }
    } catch (err) {
      setError('Failed to verify OTP. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Step 3: Reset Password
  const handleResetPassword = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resetToken, password }),
      });

      const data = await response.json();

      if (data.success) {
        // Show success and redirect to login
        alert('Password reset successfully! You can now login.');
        window.location.href = '/login';
      } else {
        setError(data.message);
      }
    } catch (err) {
      setError('Failed to reset password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Resend OTP
  const handleResendOTP = async () => {
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE}/resend-reset-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const data = await response.json();

      if (data.success) {
        alert('New code sent to your email');
        setExpiresIn(data.expiresIn);
      } else {
        setError(data.message);
      }
    } catch (err) {
      setError('Failed to resend OTP. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="password-reset-container">
      {error && <div className="error-message">{error}</div>}

      {step === 'email' && (
        <form onSubmit={handleForgotPassword}>
          <h2>Forgot Password</h2>
          <input
            type="email"
            placeholder="Enter your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Sending...' : 'Send Code'}
          </button>
        </form>
      )}

      {step === 'otp' && (
        <form onSubmit={handleVerifyOTP}>
          <h2>Verify Code</h2>
          <p>Enter the 6-digit code sent to {email}</p>
          <input
            type="text"
            placeholder="000000"
            maxLength="6"
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            required
          />
          <p className="expires-in">Code expires in {expiresIn}s</p>
          <button type="submit" disabled={loading}>
            {loading ? 'Verifying...' : 'Verify Code'}
          </button>
          <button type="button" onClick={handleResendOTP} disabled={loading}>
            Resend Code
          </button>
        </form>
      )}

      {step === 'password' && (
        <form onSubmit={handleResetPassword}>
          <h2>Set New Password</h2>
          <input
            type="password"
            placeholder="New password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength="6"
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Resetting...' : 'Reset Password'}
          </button>
        </form>
      )}
    </div>
  );
};
```

---

## 🔒 Security Features

✅ **OTP Hashing**: OTP is hashed before storage (SHA256)
✅ **Rate Limiting**: Max 5 failed attempts, then 30-minute lockout
✅ **Short Expiration**: OTP valid for 10 minutes, Reset token for 5 minutes
✅ **One-Time Use**: OTP invalidated after successful verification
✅ **Account Protection**: Locked after repeated failures
✅ **Secure Token**: Reset token is JWT-like, not stored plain

---

## 📊 API Endpoints Summary

| Endpoint | Method | Purpose | Body |
|----------|--------|---------|------|
| `/api/auth/forgot-password` | POST | Send OTP | `email` |
| `/api/auth/verify-reset-otp` | POST | Verify OTP | `email`, `otp` |
| `/api/auth/resend-reset-otp` | POST | Resend OTP | `email` |
| `/api/auth/reset-password` | POST | Reset password | `resetToken`, `password` |

---

## 🎬 Testing the Flow

### Test Case 1: Happy Path
1. Request OTP → Receive email with 6-digit code
2. Enter OTP → Get reset token
3. Enter new password → Success

### Test Case 2: Invalid OTP
1. Request OTP
2. Enter wrong code 5 times → Account locked
3. Try again after 30 minutes → Succeeds

### Test Case 3: Expired OTP
1. Request OTP
2. Wait 10+ minutes → OTP expires
3. Request new OTP → Success

### Test Case 4: Rate Limiting
1. Request OTP
2. Request new OTP within 2 minutes → Rate limited error
3. Wait 2 minutes, request again → Success

---

Generated: November 30, 2025
Status: ✅ Production Ready
