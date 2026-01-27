const admin = require('firebase-admin');

/**
 * Firebase Admin SDK Configuration
 * 
 * Required Environment Variables:
 * - FIREBASE_PROJECT_ID: Your Firebase project ID
 * - FIREBASE_CLIENT_EMAIL: Service account client email
 * - FIREBASE_PRIVATE_KEY: Service account private key (with escaped newlines)
 * 
 * To get these credentials:
 * 1. Go to Firebase Console > Project Settings > Service Accounts
 * 2. Click "Generate new private key"
 * 3. Copy the values from the downloaded JSON file
 * 
 * Note: For FIREBASE_PRIVATE_KEY, replace actual newlines with \n in .env file
 */

let firebaseApp = null;

const initializeFirebase = () => {
  if (firebaseApp) {
    return firebaseApp;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    console.warn('⚠️ Firebase Admin SDK credentials not configured. Social login with Google ID tokens will not work.');
    console.warn('   Required env vars: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
    return null;
  }

  try {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });

    console.log('✅ Firebase Admin SDK initialized successfully');
    return firebaseApp;
  } catch (error) {
    console.error('❌ Failed to initialize Firebase Admin SDK:', error.message);
    return null;
  }
};

/**
 * Verify Firebase ID Token (from Google Sign-In)
 * @param {string} idToken - The Firebase ID token from client
 * @returns {Promise<Object>} - Decoded token with user info
 */
const verifyGoogleIdToken = async (idToken) => {
  if (!firebaseApp) {
    initializeFirebase();
  }

  if (!firebaseApp) {
    throw new Error('Firebase Admin SDK is not configured. Please set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY environment variables.');
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified,
      name: decodedToken.name,
      picture: decodedToken.picture,
      provider: decodedToken.firebase?.sign_in_provider || 'google.com',
    };
  } catch (error) {
    console.error('❌ Google ID token verification failed:', error.message);
    throw new Error('Invalid or expired Google token');
  }
};

// Initialize Firebase on module load
initializeFirebase();

module.exports = {
  admin,
  initializeFirebase,
  verifyGoogleIdToken,
};
