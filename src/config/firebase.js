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
// Distinct from firebaseApp === null so callers/health checks can tell
// "never configured" apart from "configured but init blew up" (the classic
// Vercel failure: FIREBASE_PRIVATE_KEY loses its \n escaping in transit).
let firebaseInitError = null;

const initializeFirebase = () => {
  if (firebaseApp) {
    return firebaseApp;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    firebaseInitError = 'missing_credentials';
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

    firebaseInitError = null;
    console.log('✅ Firebase Admin SDK initialized successfully');
    return firebaseApp;
  } catch (error) {
    // Most common cause on Vercel: FIREBASE_PRIVATE_KEY's \n escaping got
    // mangled by the env var storage, so admin.credential.cert() rejects a
    // key that looks fine in the dashboard. Log the specific message so
    // GET /api/auth/health + these logs point straight at the cause instead
    // of a downstream "token invalid" red herring.
    firebaseInitError = error.message;
    console.error('❌ Failed to initialize Firebase Admin SDK:', error.message);
    return null;
  }
};

const isFirebaseInitialized = () => {
  if (!firebaseApp) {
    initializeFirebase();
  }
  return !!firebaseApp;
};

/**
 * Verify Firebase ID Token (from Google Sign-In)
 * @param {string} idToken - The Firebase ID token from client
 * @returns {Promise<Object>} - Decoded token with user info
 * @throws {Error} with `.code === 'FIREBASE_NOT_CONFIGURED'` (map to 503 —
 *   not the caller's fault, ops needs to fix env vars) or
 *   `.code === 'INVALID_TOKEN'` (map to 401 — the token itself is bad/expired)
 */
const verifyGoogleIdToken = async (idToken) => {
  if (!firebaseApp) {
    initializeFirebase();
  }

  if (!firebaseApp) {
    const error = new Error(
      firebaseInitError === 'missing_credentials'
        ? 'Firebase Admin SDK is not configured. Please set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY environment variables.'
        : `Firebase Admin SDK failed to initialize: ${firebaseInitError}`
    );
    error.code = 'FIREBASE_NOT_CONFIGURED';
    throw error;
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
    const invalidTokenError = new Error('Invalid or expired Google token');
    invalidTokenError.code = 'INVALID_TOKEN';
    throw invalidTokenError;
  }
};

// Initialize Firebase on module load
initializeFirebase();

module.exports = {
  admin,
  initializeFirebase,
  isFirebaseInitialized,
  verifyGoogleIdToken,
};
