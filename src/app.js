const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const passport = require('passport');
const path = require('path');

// Import middleware
const { errorHandler, notFound } = require('./middleware/errorMiddleware');

// Import routes
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const providerRoutes = require('./routes/providerRoutes');
const postRoutes = require('./routes/postRoutes');
const adminRoutes = require('./routes/adminRoutes');

// Initialize express
const app = express();

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
  max: 5, // limit each IP to 5 requests per windowMs
  skipSuccessfulRequests: true,
  message: 'Too many authentication attempts, please try again later.',
});
app.use('/api/auth/', authLimiter);

// Initialize passport
app.use(passport.initialize());
require('./config/passport');

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

// Terms of Service endpoint (optional but recommended)
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

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/providers', providerRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/admin', adminRoutes);

// Welcome route
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to MetroMatrix API',
    version: '1.0.0',
    documentation: '/api-docs',
    timestamp: new Date().toISOString(),
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