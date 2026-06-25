const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const passport = require('passport');
const path = require('path');
const crypto = require('crypto');

// Import middleware
const { errorHandler, notFound } = require('./middleware/errorMiddleware');

// Import routes
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const providerRoutes = require('./routes/providerRoutes');
const postRoutes = require('./routes/postRoutes');
const adminRoutes = require('./routes/adminRoutes');
const walletRoutes = require('./routes/walletRoutes');

// Import models and utils for verification page
const User = require('./models/User');
const Provider = require('./models/Provider');
const PendingSignup = require('./models/PendingSignup');
const EmailVerification = require('./models/EmailVerification');
const { generateTokens } = require('./utils/generateToken');

const healthcareDoctorRoutes = require('./routes/healthcareDoctorRoutes');

const adminDoctorRoutes = require('./routes/adminDoctorRoutes');

const adminSpecialtyRoutes = require('./routes/adminSpecialtyRoutes');
const adminAnalyticsRoutes = require('./routes/adminAnalyticsRoutes');

// Initialize express
const app = express();

// NOTE: Healthcare/admin routes are mounted AFTER the body parser (see below),
// otherwise their POST/PATCH request bodies would not be parsed.

// Trust proxy
app.set('trust proxy', 1);

// Body parser middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));


// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:19006', // Expo
      'http://localhost:8081',  // React Native
      process.env.CLIENT_URL,
    ];

    // Allow requests with no origin (mobile apps)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));

// Security middleware
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false, // Disable for verification page
  })
);

// Data sanitization against NoSQL query injection
app.use(mongoSanitize());

// Compression middleware
app.use(compression());

// Development logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// Rate limiting
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
});
app.use('/api/', limiter);

// Auth rate limiting (stricter)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  skipSuccessfulRequests: true,
  message: 'Too many authentication attempts, please try again later.',
});
app.use('/api/auth/', authLimiter);

// Initialize passport
app.use(passport.initialize());
require('./config/passport');

const uploadRoutes = require('./routes/uploadRoutes');
app.use('/uploads', uploadRoutes);

// Static files (for uploaded images)
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    uptime: process.uptime(),
  });
});

// ===== EMAIL VERIFICATION JSON API (FOR FRONTEND REQUESTS) =====
// ✅ NEW: Verify email via API and return JSON response with tokens
app.get('/api/verify-email', async (req, res) => {
  const { token, type = 'user' } = req.query;

  if (!token) {
    return res.status(400).json({
      success: false,
      message: 'Verification token is required',
      statusCode: 400,
    });
  }

  try {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // ✅ UPDATED: Check if provider email verification (provider already exists)
    if (type === 'provider') {
      const provider = await Provider.findOne({
        emailVerificationToken: hashedToken,
        emailVerificationExpire: { $gt: Date.now() },
      });

      if (provider) {
        provider.emailVerified = 'active'; // ✅ Set to 'active'
        provider.onboardingStatus = 'pending_documents';
        provider.emailVerificationToken = undefined;
        provider.emailVerificationExpire = undefined;

        // Generate temporary tokens for profile completion
        const tokens = generateTokens(provider._id, {
          userType: 'provider',
          email: provider.email,
          onboardingStatus: 'pending_documents'
        });
        provider.refreshToken = tokens.refreshToken;
        await provider.save();

        console.log(`✅ Provider email verified via API: ${provider.email}`);


        return res.json({
          success: true,
          message: 'Email verified successfully. Please complete your profile.',
          userType: 'provider',
          provider: {
            _id: provider._id,
            email: provider.email,
            phoneNumber: provider.phoneNumber,
            fullName: provider.fullName,
            emailVerified: 'active', // ✅ New flag
            adminVerified: 'pending', // ✅ New flag
            status: 'email_verified',
          },
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        });
      }
    }

    // Check if this is a PendingSignup verification (USER only)
    const pending = await PendingSignup.findOne({
      verificationToken: hashedToken,
      verificationTokenExpire: { $gt: Date.now() },
      userType: type,
    }).select('+password');

    if (pending) {
      // Create user from pending signup
      let user;
      try {
        user = await User.create({
          fullName: pending.fullName,
          phoneNumber: pending.phoneNumber,
          email: pending.email,
          password: pending.password,
          emailVerified: true,
          isVerified: true,
        });

        // Delete pending signup
        await PendingSignup.deleteOne({ _id: pending._id });

        console.log(`✅ ${type} verified via API: ${user.email}`);

        // User flow: Full access immediately
        const tokens = generateTokens(user._id, {
          userType: 'user',
          email: user.email
        });
        user.refreshToken = tokens.refreshToken;
        user.lastLoginDate = Date.now();
        await user.save();

        return res.json({
          success: true,
          message: 'User email verified successfully!',
          isVerified: true,
          emailVerified: true,
          user: {
            id: user._id,
            fullName: user.fullName,
            email: user.email,
            phoneNumber: user.phoneNumber,
            profileComplete: user.profileComplete,
            emailVerified: user.emailVerified,
          },
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        });
      } catch (createError) {
        console.error(`Error creating ${type}:`, createError);
        await PendingSignup.deleteOne({ _id: pending._id });
        return res.status(500).json({
          success: false,
          message: 'Failed to create account. Please try again.',
          statusCode: 500,
        });
      }
    }

    // Token not found or expired
    return res.status(400).json({
      success: false,
      message: 'Invalid or expired verification token',
      statusCode: 400,
    });
  } catch (error) {
    console.error('Verification error:', error);
    return res.status(500).json({
      success: false,
      message: 'Verification failed. Please try again.',
      statusCode: 500,
    });
  }
});

// ===== EMAIL VERIFICATION WEB PAGE (FOR MOBILE APP) =====
// ✅ UPDATED: Handles signup verification - creates User/Provider AFTER email verification
app.get('/verify-email', async (req, res) => {
  const { token, type = 'user' } = req.query;

  if (!token) {
    return res.send(getVerificationHTML('error', 'No verification token provided.', null, null, type));
  }

  try {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // ✅ NEW FLOW: Provider already exists, just verify email
    // Check if this is a Provider's email verification (created during signup)
    if (type === 'provider') {
      const provider = await Provider.findOne({
        emailVerificationToken: hashedToken,
        emailVerificationExpire: { $gt: Date.now() },
      });

      if (provider) {
        // Mark email as verified
        provider.emailVerified = 'active'; // ✅ Set to 'active'
        provider.onboardingStatus = 'pending_documents';
        provider.emailVerificationToken = undefined;
        provider.emailVerificationExpire = undefined;

        // Generate tokens for profile completion
        const tokens = generateTokens(provider._id, {
          userType: 'provider',
          email: provider.email,
          onboardingStatus: 'pending_documents'
        });
        provider.refreshToken = tokens.refreshToken;
        await provider.save();

        console.log(`✅ Provider email verified: ${provider.email}`);

        const successMessage = 'Email verified successfully! Please return to the MetroMatrix app to complete your profile.';

        const deepLinkParams = new URLSearchParams({
          verified: 'true',
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          userType: 'provider',
          userId: provider._id.toString(),
          email: provider.email,
          fullName: provider.fullName,
        });

        const deepLinkUrl = `metromatrix://verify-success?${deepLinkParams}`;

        return res.send(getVerificationHTML('success', successMessage, deepLinkUrl, null, type));
      }
    }

    // Check if this is a PendingSignup (USER signup verification only)
    const pending = await PendingSignup.findOne({
      verificationToken: hashedToken,
      verificationTokenExpire: { $gt: Date.now() },
      userType: type,
    }).select('+password');

    if (pending) {
      // This is a new USER signup verification - create the user
      console.log(`✅ Verifying new ${type} signup: ${pending.email}`);

      let user;
      let successMessage = '';
      let deepLinkParams;

      try {
        // ✅ USER FLOW ONLY: Create and enable full access immediately
        user = await User.create({
          fullName: pending.fullName,
          phoneNumber: pending.phoneNumber,
          email: pending.email,
          password: pending.password,
          emailVerified: true,
          isVerified: true,
        });

        // Generate auth tokens for user (immediate login)
        const tokens = generateTokens(user._id, {
          userType: 'user',
          email: user.email
        });
        user.refreshToken = tokens.refreshToken;
        user.lastLoginDate = Date.now();
        await user.save();

        successMessage = 'Your email has been verified successfully! Welcome to MetroMatrix.';

        deepLinkParams = new URLSearchParams({
          verified: 'true',
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          userType: 'user',
          userId: user._id.toString(),
          email: user.email,
          fullName: user.fullName,
        });

        // Delete pending signup record
        await PendingSignup.deleteOne({ _id: pending._id });

        const deepLinkUrl = `metromatrix://verify-success?${deepLinkParams}`;
        // ✅ IMPROVED: Return HTML with immediate auto-redirect
        return res.send(getVerificationHTML('success', successMessage, deepLinkUrl, null, type));

      } catch (createError) {
        console.error(`Error creating ${type} from pending signup:`, createError);
        // Clean up pending record on failure
        await PendingSignup.deleteOne({ _id: pending._id });
        return res.send(getVerificationHTML('error', 'Failed to complete signup. Please try again.', null, null, type));
      }
    }

    // ✅ NEW: Check EmailVerification table for standalone provider verification (v60)
    if (type === 'provider') {
      const emailVerification = await EmailVerification.findOne({
        token: token, // Use plain token, not hashed (EmailVerification stores plain tokens)
        userType: 'provider',
      });

      if (emailVerification) {
        // Check if expired
        if (emailVerification.expiresAt < new Date()) {
          return res.send(getVerificationHTML('expired', 'Verification link has expired. Please request a new verification email from the app.', null, null, type));
        }

        // Check if already verified
        if (emailVerification.verified) {
          return res.send(getVerificationHTML('success', 'Email already verified! Please return to the app and tap "I Verified My Email" to continue.', null, null, type));
        }

        // Mark as verified
        emailVerification.verified = true;
        await emailVerification.save();

        console.log(`✅ Provider email verified via standalone flow: ${emailVerification.email}`);

        // Return success page WITHOUT tokens (provider hasn't submitted profile yet)
        const successMessage = 'Email verified successfully! Please return to the MetroMatrix app to complete your profile.';
        const deepLinkUrl = `metromatrix://verified?email=${encodeURIComponent(emailVerification.email)}&type=provider`;

        return res.send(getVerificationHTML('success', successMessage, deepLinkUrl, null, type));
      }
    }

    // Otherwise, check if this is an existing user's email verification (legacy flow)
    const Model = type === 'provider' ? Provider : User;
    const user = await Model.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpire: { $gt: Date.now() },
    });

    if (!user) {
      return res.send(getVerificationHTML('expired', 'Invalid or expired verification link. Please request a new verification email from the app.', null, null, type));
    }

    // This is an existing user's email verification
    user.emailVerified = true;
    user.isVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpire = undefined;
    user.emailVerificationAttempts = 0;

    if (type === 'provider') {
      user.canLogin = true;
    }

    const tokens = generateTokens(user._id, {
      userType: type,
      email: user.email,
      tokenType: type === 'provider' ? 'LIMITED' : 'FULL'
    });
    user.refreshToken = tokens.refreshToken;
    user.lastLoginDate = Date.now();
    await user.save();

    const deepLinkParams = new URLSearchParams({
      verified: 'true',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      userType: type,
      userId: user._id.toString(),
      email: user.email,
      fullName: user.fullName,
    });

    const deepLinkUrl = `metromatrix://verify-success?${deepLinkParams}`;
    return res.send(getVerificationHTML('success', 'Your email has been verified successfully!', deepLinkUrl, tokens.accessToken, type));

  } catch (error) {
    console.error('Verification error:', error);
    return res.send(getVerificationHTML('error', 'Something went wrong. Please try again or contact support.', null, null, type));
  }
});

// HTML template helper function for verification page
function getVerificationHTML(status, message, deepLinkUrl = null, accessToken = null, userType = 'user') {
  const isSuccess = status === 'success';
  const isExpired = status === 'expired';

  let iconContent, iconBg, titleColor, title;

  if (isSuccess) {
    iconContent = '✓';
    iconBg = '#d1fae5';
    titleColor = '#059669';
    title = 'Email Verified!';
  } else if (isExpired) {
    iconContent = '⏰';
    iconBg = '#fef3c7';
    titleColor = '#d97706';
    title = 'Link Expired';
  } else {
    iconContent = '✕';
    iconBg = '#fee2e2';
    titleColor = '#dc2626';
    title = 'Verification Failed';
  }

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - MetroMatrix</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 24px;
      padding: 48px 40px;
      text-align: center;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 25px 80px rgba(0,0,0,0.35);
    }
    .logo {
      font-size: 28px;
      font-weight: 700;
      color: #6366f1;
      margin-bottom: 32px;
      letter-spacing: -0.5px;
    }
    .icon {
      width: 88px;
      height: 88px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 28px;
      font-size: 44px;
      background: ${iconBg};
    }
    h1 {
      color: ${titleColor};
      font-size: 26px;
      font-weight: 700;
      margin-bottom: 12px;
    }
    p {
      color: #6b7280;
      font-size: 15px;
      line-height: 1.7;
      margin-bottom: 28px;
    }
    .btn {
      display: inline-block;
      padding: 16px 36px;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.3s ease;
      cursor: pointer;
      border: none;
    }
    .btn:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 25px rgba(99, 102, 241, 0.4);
    }
    .btn-primary {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
    }
    .btn-secondary {
      background: #f3f4f6;
      color: #374151;
      margin-top: 12px;
    }
    .btn-secondary:hover {
      background: #e5e7eb;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    .divider {
      display: flex;
      align-items: center;
      margin: 28px 0;
      color: #9ca3af;
      font-size: 13px;
    }
    .divider::before, .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #e5e7eb;
    }
    .divider span {
      padding: 0 16px;
    }
    .token-section {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 20px;
      margin-top: 8px;
    }
    .token-label {
      font-size: 13px;
      color: #6b7280;
      margin-bottom: 10px;
      text-align: left;
    }
    .token-box {
      background: #1f2937;
      border-radius: 8px;
      padding: 14px;
      word-break: break-all;
      font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
      font-size: 11px;
      color: #10b981;
      max-height: 70px;
      overflow-y: auto;
      text-align: left;
      line-height: 1.5;
    }
    .copy-btn {
      background: #6366f1;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      margin-top: 14px;
      transition: all 0.2s;
      width: 100%;
    }
    .copy-btn:hover { 
      background: #4f46e5; 
    }
    .copy-btn.copied {
      background: #059669;
    }
    .note {
      font-size: 13px;
      color: #9ca3af;
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid #e5e7eb;
    }
    .user-type-badge {
      display: inline-block;
      background: ${userType === 'provider' ? '#dbeafe' : '#fce7f3'};
      color: ${userType === 'provider' ? '#1d4ed8' : '#be185d'};
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 20px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: white;
      animation: spin 1s linear infinite;
      margin-right: 8px;
      vertical-align: middle;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .redirect-notice {
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 20px;
      font-size: 13px;
      color: #1e40af;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">MetroMatrix</div>
    
    <div class="user-type-badge">${userType === 'provider' ? '🏥 Provider Account' : '👤 User Account'}</div>
    
    <div class="icon">
      ${iconContent}
    </div>
    
    <h1>${title}</h1>
    <p>${message}</p>
    
    ${isSuccess && deepLinkUrl ? `
      <div class="redirect-notice" id="redirectNotice">
        <span class="spinner"></span>
        Redirecting to app...
      </div>
      
      <a href="${deepLinkUrl}" class="btn btn-primary" id="openAppBtn">
        Open MetroMatrix App
      </a>
      
      <div class="divider"><span>or copy token manually</span></div>
      
      <div class="token-section">
        <div class="token-label">Your authentication token:</div>
        <div class="token-box" id="tokenBox">${accessToken}</div>
        <button class="copy-btn" id="copyBtn" onclick="copyToken()">
          📋 Copy Token
        </button>
      </div>
      
      <p class="note">
        If the app doesn't open automatically, copy the token above and paste it in the app's verification screen.
      </p>
    ` : isExpired ? `
      <p style="font-size: 14px; color: #6b7280; margin-bottom: 20px;">
        Please open the MetroMatrix app and request a new verification email.
      </p>
      <a href="metromatrix://resend-verification?type=${userType}" class="btn btn-primary">
        Open App
      </a>
    ` : `
      <a href="mailto:sp23-bcs-104@cuilahore.edu.pk?subject=MetroMatrix Verification Issue" class="btn btn-secondary">
        Contact Support
      </a>
    `}
  </div>
  
  ${isSuccess ? `
  <script>
    // Copy token function
    function copyToken() {
      const token = document.getElementById('tokenBox').innerText;
      const copyBtn = document.getElementById('copyBtn');
      
      navigator.clipboard.writeText(token).then(() => {
        copyBtn.innerText = '✓ Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.innerText = '📋 Copy Token';
          copyBtn.classList.remove('copied');
        }, 3000);
      }).catch(() => {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = token;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        copyBtn.innerText = '✓ Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.innerText = '📋 Copy Token';
          copyBtn.classList.remove('copied');
        }, 3000);
      });
    }
    
    // ✅ IMPROVED: Auto-redirect to app IMMEDIATELY (1 second delay for UX)
    if ("${deepLinkUrl}") {
      setTimeout(() => {
        const redirectNotice = document.getElementById('redirectNotice');
        
        // Attempt to open app via deep link
        window.location.href = "${deepLinkUrl}";
        
        // If app is not installed, show fallback message after 3 seconds
        setTimeout(() => {
          if (redirectNotice && document.hasFocus()) {
            redirectNotice.innerHTML = '✓ Email verified! You can now close this window and login in the app.';
            redirectNotice.style.background = '#d1fae5';
            redirectNotice.style.borderColor = '#6ee7b7';
            redirectNotice.style.color = '#059669';
          }
        }, 3000);
      }, 1000);
    }
  </script>
  ` : ''}
</body>
</html>
  `;
}

// ===== PRIVACY POLICY ENDPOINT (FOR FACEBOOK OAUTH) =====
app.get('/privacy-policy', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Privacy Policy - MetroMatrix</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            max-width: 900px;
            margin: 0 auto;
            padding: 20px;
            color: #333;
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 40px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 { 
            color: #6366f1; 
            border-bottom: 3px solid #6366f1;
            padding-bottom: 10px;
        }
        h2 { 
            color: #4f46e5; 
            margin-top: 30px;
            margin-bottom: 15px;
        }
        h3 {
            color: #5b21b6;
            margin-top: 20px;
        }
        .last-updated { 
            color: #666; 
            font-style: italic;
            margin-bottom: 30px;
        }
        ul {
            margin: 15px 0;
            padding-left: 25px;
        }
        li {
            margin: 8px 0;
        }
        .contact-info {
            background: #f0f0f0;
            padding: 20px;
            border-radius: 5px;
            margin-top: 30px;
        }
        .footer {
            text-align: center;
            color: #666;
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
        }
        strong {
            color: #1f2937;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Privacy Policy for MetroMatrix</h1>
        <p class="last-updated">Last Updated: November 17, 2024</p>
        
        <h2>1. Introduction</h2>
        <p>Welcome to MetroMatrix ("we," "our," or "us"). We are committed to protecting your privacy and ensuring the security of your personal information. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our mobile application and services.</p>
        
        <h2>2. Information We Collect</h2>
        <p>We collect several types of information to provide and improve our services:</p>
        
        <h3>2.1 Information You Provide Directly</h3>
        <ul>
            <li><strong>Account Information:</strong> Name, email address, phone number, password</li>
            <li><strong>Profile Information:</strong> Profile photo, date of birth, gender, address, city</li>
            <li><strong>Provider Information:</strong> Professional credentials, licenses, certificates, business information</li>
            <li><strong>Content:</strong> Posts, comments, reviews, ratings, messages</li>
            <li><strong>Booking Information:</strong> Service requests, appointment details</li>
        </ul>
        
        <h3>2.2 Information from Social Media</h3>
        <p>When you sign in using Google or Facebook, we collect:</p>
        <ul>
            <li>Your name and profile picture</li>
            <li>Your email address</li>
            <li>Your social media user ID (for authentication purposes only)</li>
        </ul>
        <p><strong>We do not:</strong> Post to your social media accounts, access your friends list, or collect any other information beyond what's necessary for authentication.</p>
        
        <h3>2.3 Automatically Collected Information</h3>
        <ul>
            <li><strong>Usage Data:</strong> App features used, pages viewed, time spent, interaction patterns</li>
            <li><strong>Device Information:</strong> Device type, operating system, app version</li>
            <li><strong>Location Data:</strong> City and general location (only if you grant permission)</li>
        </ul>
        
        <h2>3. How We Use Your Information</h2>
        <p>We use the collected information for the following purposes:</p>
        <ul>
            <li><strong>Account Management:</strong> Creating and managing your account, authentication, and security</li>
            <li><strong>Service Delivery:</strong> Connecting users with service providers, facilitating bookings</li>
            <li><strong>Communication:</strong> Sending notifications, updates, service confirmations, and support messages</li>
            <li><strong>Personalization:</strong> Customizing content and recommendations based on your preferences</li>
            <li><strong>Improvement:</strong> Analyzing usage patterns to improve our app and services</li>
            <li><strong>Safety:</strong> Preventing fraud, ensuring platform security, and enforcing our terms</li>
            <li><strong>Legal Compliance:</strong> Complying with legal obligations and protecting legal rights</li>
        </ul>
        
        <h2>4. Social Login (Google & Facebook OAuth)</h2>
        <p>When you use social login features:</p>
        <ul>
            <li>We only request and access basic profile information (name, email, profile picture)</li>
            <li>We do not access your social media posts, messages, or friends list</li>
            <li>We do not post anything to your social media accounts</li>
            <li>You can revoke MetroMatrix's access anytime through your Google or Facebook account settings</li>
            <li>Your social login credentials are never stored on our servers</li>
            <li>We use OAuth 2.0 industry-standard protocol for secure authentication</li>
        </ul>
        
        <h2>5. Data Storage and Security</h2>
        <p>We implement industry-standard security measures to protect your data:</p>
        <ul>
            <li><strong>Encryption:</strong> All data transmission uses HTTPS/SSL encryption</li>
            <li><strong>Password Security:</strong> Passwords are hashed using bcrypt algorithm</li>
            <li><strong>Secure Database:</strong> Data stored on encrypted MongoDB Atlas servers</li>
            <li><strong>Cloud Storage:</strong> Images and documents securely stored on Cloudinary</li>
            <li><strong>Access Control:</strong> Strict access controls and authentication mechanisms</li>
            <li><strong>Regular Updates:</strong> Security patches and updates applied regularly</li>
        </ul>
        
        <h2>6. Information Sharing and Disclosure</h2>
        <p>We do not sell or rent your personal information. We may share your information only in these circumstances:</p>
        <ul>
            <li><strong>With Service Providers:</strong> Information visible to providers you choose to contact or book</li>
            <li><strong>Service Partners:</strong> Third-party services that help us operate (e.g., Cloudinary, MongoDB)</li>
            <li><strong>Legal Requirements:</strong> When required by law, court order, or legal process</li>
            <li><strong>Business Transfers:</strong> In case of merger, acquisition, or sale of assets</li>
            <li><strong>With Your Consent:</strong> Any other sharing with your explicit permission</li>
        </ul>
        
        <h2>7. Your Rights and Choices</h2>
        <p>You have the following rights regarding your personal data:</p>
        <ul>
            <li><strong>Access:</strong> Request a copy of your personal data</li>
            <li><strong>Update:</strong> Correct or update your information through your profile settings</li>
            <li><strong>Delete:</strong> Request deletion of your account and associated data</li>
            <li><strong>Export:</strong> Download your data in a portable format</li>
            <li><strong>Opt-out:</strong> Unsubscribe from marketing communications</li>
            <li><strong>Restrict:</strong> Limit how we use your data</li>
            <li><strong>Object:</strong> Object to certain data processing activities</li>
        </ul>
        
        <h2>8. Data Retention</h2>
        <p>We retain your information for as long as necessary to provide our services and maintain your account. When you delete your account, we will delete or anonymize your personal information within 30 days, except where we are required to retain it by law.</p>
        
        <h2>9. Cookies and Tracking Technologies</h2>
        <p>We use minimal cookies and similar technologies for:</p>
        <ul>
            <li>Maintaining your login session</li>
            <li>Remembering your preferences and settings</li>
            <li>Analyzing app usage and performance</li>
            <li>Preventing fraud and ensuring security</li>
        </ul>
        
        <h2>10. Children's Privacy</h2>
        <p>MetroMatrix is not intended for users under 18 years of age. We do not knowingly collect personal information from children under 18. If we learn that we have collected information from a child under 18, we will delete it promptly.</p>
        
        <h2>11. International Data Transfers</h2>
        <p>Your information may be transferred to and processed in countries other than your country of residence. We ensure appropriate safeguards are in place to protect your data in accordance with this Privacy Policy.</p>
        
        <h2>12. Third-Party Links</h2>
        <p>Our app may contain links to third-party websites or services. We are not responsible for the privacy practices of these third parties. We encourage you to read their privacy policies.</p>
        
        <h2>13. Changes to This Privacy Policy</h2>
        <p>We may update this Privacy Policy from time to time. We will notify you of any material changes by updating the "Last Updated" date and sending you an email notification if you have an account.</p>
        
        <h2>14. Contact Us</h2>
        <div class="contact-info">
            <p>If you have any questions, concerns, or requests regarding this Privacy Policy, please contact us:</p>
            <ul>
                <li><strong>Email:</strong> sp23-bcs-104@cuilahore.edu.pk</li>
                <li><strong>Application:</strong> MetroMatrix</li>
                <li><strong>Website:</strong> https://metromatrix-api.herokuapp.com</li>
            </ul>
            <p>We will respond to your inquiry within 30 days.</p>
        </div>
        
        <h2>15. Your Consent</h2>
        <p>By using MetroMatrix, you consent to the collection, use, and sharing of your information as described in this Privacy Policy. If you do not agree with this policy, please do not use our services.</p>
        
        <div class="footer">
            <p><strong>© 2024 MetroMatrix. All rights reserved.</strong></p>
            <p>This privacy policy is effective as of November 17, 2024</p>
        </div>
    </div>
</body>
</html>
  `);
});

// Terms of Service endpoint
app.get('/terms-of-service', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Terms of Service - MetroMatrix</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            max-width: 900px;
            margin: 0 auto;
            padding: 20px;
            color: #333;
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 40px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 { 
            color: #6366f1; 
            border-bottom: 3px solid #6366f1;
            padding-bottom: 10px;
        }
        h2 { 
            color: #4f46e5; 
            margin-top: 30px;
            margin-bottom: 15px;
        }
        .last-updated { 
            color: #666; 
            font-style: italic;
            margin-bottom: 30px;
        }
        ul {
            margin: 15px 0;
            padding-left: 25px;
        }
        li {
            margin: 8px 0;
        }
        .footer {
            text-align: center;
            color: #666;
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Terms of Service for MetroMatrix</h1>
        <p class="last-updated">Last Updated: November 17, 2024</p>
        
        <h2>1. Acceptance of Terms</h2>
        <p>By accessing and using MetroMatrix, you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use our services.</p>
        
        <h2>2. Description of Service</h2>
        <p>MetroMatrix is a platform that connects users with service providers including doctors, home service professionals, and vendors.</p>
        
        <h2>3. User Accounts</h2>
        <ul>
            <li>You must provide accurate and complete information when creating an account</li>
            <li>You are responsible for maintaining the security of your account credentials</li>
            <li>You must be at least 18 years old to use MetroMatrix</li>
            <li>One person may not maintain multiple accounts</li>
        </ul>
        
        <h2>4. User Conduct</h2>
        <p>You agree not to:</p>
        <ul>
            <li>Violate any laws or regulations</li>
            <li>Impersonate any person or entity</li>
            <li>Post false, misleading, or fraudulent content</li>
            <li>Harass, abuse, or harm other users</li>
            <li>Upload malicious code or attempt to compromise the platform</li>
            <li>Use the service for any unauthorized commercial purpose</li>
        </ul>
        
        <h2>5. Provider Services</h2>
        <ul>
            <li>Service providers are independent contractors, not employees of MetroMatrix</li>
            <li>MetroMatrix does not guarantee the quality of services provided</li>
            <li>Users should verify provider credentials and reviews before booking</li>
            <li>Disputes between users and providers should be resolved directly</li>
        </ul>
        
        <h2>6. Content and Intellectual Property</h2>
        <ul>
            <li>You retain ownership of content you post on MetroMatrix</li>
            <li>By posting content, you grant MetroMatrix a license to use, display, and distribute it</li>
            <li>You must have rights to any content you upload</li>
            <li>MetroMatrix reserves the right to remove any content that violates these terms</li>
        </ul>
        
        <h2>7. Privacy</h2>
        <p>Your use of MetroMatrix is subject to our Privacy Policy. Please review it to understand how we collect and use your information.</p>
        
        <h2>8. Termination</h2>
        <p>We reserve the right to suspend or terminate your account at any time for violations of these terms or for any other reason at our discretion.</p>
        
        <h2>9. Disclaimer of Warranties</h2>
        <p>MetroMatrix is provided "as is" without warranties of any kind, either express or implied. We do not guarantee uninterrupted or error-free service.</p>
        
        <h2>10. Limitation of Liability</h2>
        <p>MetroMatrix and its affiliates shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of the service.</p>
        
        <h2>11. Changes to Terms</h2>
        <p>We may modify these terms at any time. Continued use of MetroMatrix after changes constitutes acceptance of the modified terms.</p>
        
        <h2>12. Contact</h2>
        <p>For questions about these terms, contact us at: sp23-bcs-104@cuilahore.edu.pk</p>
        
        <div class="footer">
            <p><strong>© 2024 MetroMatrix. All rights reserved.</strong></p>
        </div>
    </div>
</body>
</html>
  `);
});

// ===== PASSWORD RESET JSON API (FOR FRONTEND REQUESTS) =====
// ✅ NEW: Reset password via API and return JSON response
app.get('/api/reset-password', async (req, res) => {
  const { token, type = 'user' } = req.query;

  if (!token) {
    return res.status(400).json({
      success: false,
      message: 'Password reset token is required',
      statusCode: 400,
    });
  }

  try {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Check if token is valid for either user or provider
    const Model = type === 'provider' ? Provider : User;
    const user = await Model.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset token',
        statusCode: 400,
      });
    }

    // Return token validation response
    return res.json({
      success: true,
      message: 'Password reset token is valid',
      tokenValid: true,
      userType: type,
      email: user.email,
      fullName: user.fullName,
    });
  } catch (error) {
    console.error('Password reset token validation error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error validating reset token',
      statusCode: 500,
    });
  }
});

// ===== PASSWORD RESET WEB PAGE (FOR MOBILE APP) =====
// ✅ NEW: Password reset page with auto-redirect
app.get('/reset-password', async (req, res) => {
  const { token, type = 'user' } = req.query;

  if (!token) {
    return res.send(getPasswordResetHTML('error', 'No reset token provided.', null, type));
  }

  try {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Verify token
    const Model = type === 'provider' ? Provider : User;
    const user = await Model.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() },
    });

    if (!user) {
      return res.send(getPasswordResetHTML('expired', 'This reset link has expired. Please request a new password reset email.', null, type));
    }

    console.log(`✅ Password reset link valid for ${type}: ${user.email}`);

    const deepLinkParams = new URLSearchParams({
      resetToken: token,
      userType: type,
      email: user.email,
    });

    const deepLinkUrl = `metromatrix://reset-password?${deepLinkParams}`;

    return res.send(getPasswordResetHTML('valid', `You can now reset your password. Redirecting to MetroMatrix app...`, deepLinkUrl, type, token));

  } catch (error) {
    console.error('Password reset page error:', error);
    return res.send(getPasswordResetHTML('error', 'Something went wrong. Please try again or contact support.', null, type));
  }
});

// HTML template helper function for password reset page
function getPasswordResetHTML(status, message, deepLinkUrl = null, userType = 'user', resetToken = null) {
  const isValid = status === 'valid';
  const isExpired = status === 'expired';

  let iconContent, iconBg, titleColor, title;

  if (isValid) {
    iconContent = '🔐';
    iconBg = '#e0e7ff';
    titleColor = '#4f46e5';
    title = 'Reset Your Password';
  } else if (isExpired) {
    iconContent = '⏰';
    iconBg = '#fef3c7';
    titleColor = '#d97706';
    title = 'Link Expired';
  } else {
    iconContent = '✕';
    iconBg = '#fee2e2';
    titleColor = '#dc2626';
    title = 'Reset Failed';
  }

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - MetroMatrix</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #a855f7 100%);
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 24px;
      padding: 48px 40px;
      text-align: center;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 25px 80px rgba(0,0,0,0.35);
    }
    .logo {
      font-size: 28px;
      font-weight: 700;
      color: #6366f1;
      margin-bottom: 32px;
      letter-spacing: -0.5px;
    }
    .icon {
      width: 88px;
      height: 88px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 28px;
      font-size: 44px;
      background: ${iconBg};
    }
    h1 {
      color: ${titleColor};
      font-size: 26px;
      font-weight: 700;
      margin-bottom: 12px;
    }
    p {
      color: #6b7280;
      font-size: 15px;
      line-height: 1.7;
      margin-bottom: 28px;
    }
    .btn {
      display: inline-block;
      padding: 16px 36px;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.3s ease;
      cursor: pointer;
      border: none;
    }
    .btn:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 25px rgba(99, 102, 241, 0.4);
    }
    .btn-primary {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
    }
    .btn-secondary {
      background: #f3f4f6;
      color: #374151;
      margin-top: 12px;
    }
    .btn-secondary:hover {
      background: #e5e7eb;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    .token-section {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 20px;
      margin-top: 8px;
    }
    .token-label {
      font-size: 13px;
      color: #6b7280;
      margin-bottom: 10px;
      text-align: left;
    }
    .token-box {
      background: #1f2937;
      border-radius: 8px;
      padding: 14px;
      word-break: break-all;
      font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
      font-size: 11px;
      color: #10b981;
      max-height: 70px;
      overflow-y: auto;
      text-align: left;
      line-height: 1.5;
    }
    .copy-btn {
      background: #6366f1;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      margin-top: 14px;
      transition: all 0.2s;
      width: 100%;
    }
    .copy-btn:hover { 
      background: #4f46e5; 
    }
    .copy-btn.copied {
      background: #059669;
    }
    .note {
      font-size: 13px;
      color: #9ca3af;
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid #e5e7eb;
    }
    .user-type-badge {
      display: inline-block;
      background: ${userType === 'provider' ? '#dbeafe' : '#fce7f3'};
      color: ${userType === 'provider' ? '#1d4ed8' : '#be185d'};
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 20px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: white;
      animation: spin 1s linear infinite;
      margin-right: 8px;
      vertical-align: middle;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .redirect-notice {
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 20px;
      font-size: 13px;
      color: #1e40af;
    }
    .divider {
      display: flex;
      align-items: center;
      margin: 28px 0;
      color: #9ca3af;
      font-size: 13px;
    }
    .divider::before, .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #e5e7eb;
    }
    .divider span {
      padding: 0 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">MetroMatrix</div>
    
    <div class="user-type-badge">${userType === 'provider' ? '🏥 Provider Account' : '👤 User Account'}</div>
    
    <div class="icon">
      ${iconContent}
    </div>
    
    <h1>${title}</h1>
    <p>${message}</p>
    
    ${isValid && deepLinkUrl ? `
      <div class="redirect-notice" id="redirectNotice">
        <span class="spinner"></span>
        Redirecting to app...
      </div>
      
      <a href="${deepLinkUrl}" class="btn btn-primary" id="openAppBtn">
        Open MetroMatrix App
      </a>
      
      <div class="divider"><span>or copy token manually</span></div>
      
      <div class="token-section">
        <div class="token-label">Your password reset token:</div>
        <div class="token-box" id="tokenBox">${resetToken}</div>
        <button class="copy-btn" id="copyBtn" onclick="copyToken()">
          📋 Copy Token
        </button>
      </div>
      
      <p class="note">
        If the app doesn't open automatically, copy the token above and paste it in the app's password reset screen.
      </p>
    ` : isExpired ? `
      <p style="font-size: 14px; color: #6b7280; margin-bottom: 20px;">
        Please open the MetroMatrix app and request a new password reset email.
      </p>
      <a href="metromatrix://forgot-password" class="btn btn-primary">
        Open App
      </a>
    ` : `
      <a href="mailto:sp23-bcs-104@cuilahore.edu.pk?subject=MetroMatrix Password Reset Issue" class="btn btn-secondary">
        Contact Support
      </a>
    `}
  </div>
  
  ${isValid ? `
  <script>
    // Copy token function
    function copyToken() {
      const token = document.getElementById('tokenBox').innerText;
      const copyBtn = document.getElementById('copyBtn');
      
      navigator.clipboard.writeText(token).then(() => {
        copyBtn.innerText = '✓ Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.innerText = '📋 Copy Token';
          copyBtn.classList.remove('copied');
        }, 3000);
      }).catch(() => {
        const textArea = document.createElement('textarea');
        textArea.value = token;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        copyBtn.innerText = '✓ Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.innerText = '📋 Copy Token';
          copyBtn.classList.remove('copied');
        }, 3000);
      });
    }
    
    // ✅ Auto-redirect to app IMMEDIATELY (1 second delay for UX)
    if ("${deepLinkUrl}") {
      setTimeout(() => {
        const redirectNotice = document.getElementById('redirectNotice');
        
        // Attempt to open app via deep link
        window.location.href = "${deepLinkUrl}";
        
        // If app is not installed, show fallback message after 3 seconds
        setTimeout(() => {
          if (redirectNotice && document.hasFocus()) {
            redirectNotice.innerHTML = '✓ Token validated! You can now close this window and paste the token in the app.';
            redirectNotice.style.background = '#d1fae5';
            redirectNotice.style.borderColor = '#6ee7b7';
            redirectNotice.style.color = '#059669';
          }
        }, 3000);
      }, 1000);
    }
  </script>
  ` : ''}
</body>
</html>
  `;
}

// API Routes
app.use('/api/auth', authRoutes);
// Healthcare: provider-based doctor self-service routes first (claim /doctors/me,
// /doctors/register, /doctors/signin), then the shared healthcare module router.
app.use('/api/v1/healthcare', healthcareDoctorRoutes);
app.use('/api/v1/healthcare', require('./modules/healthcare/routes/index'));
// Healthcare admin routes (doctor approval, specialty CRUD, analytics).
app.use('/api/v1/admin', adminDoctorRoutes);
app.use('/api/v1/admin', adminSpecialtyRoutes);
app.use('/api/v1/admin', adminAnalyticsRoutes);
app.use('/api/users', userRoutes);
app.use('/api/providers', providerRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/wallet', walletRoutes);

// ✅ UPDATED: Provider profile endpoints with proper authentication
const { uploadMultipleDocuments } = require('./middleware/uploadMiddleware');
const { updateProviderProfileComplete, checkApprovalStatus } = require('./controllers/providerController');
const { protect } = require('./middleware/authMiddleware');
app.put('/api/provider/profile', protect, uploadMultipleDocuments, updateProviderProfileComplete);
app.get('/api/provider/approval-status', checkApprovalStatus);

// Welcome route
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to MetroMatrix API',
    version: '1.0.0',
    documentation: '/api-docs',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      auth: '/api/auth',
      users: '/api/users',
      providers: '/api/providers',
      posts: '/api/posts',
      admin: '/api/admin',
      wallet: '/api/wallet',
      verifyEmail: '/verify-email?token=xxx&type=user',
    },
  });
});

// 404 handler
app.use((req, res, next) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
});

// Error handler middleware (should be last)
app.use(errorHandler);

module.exports = app;