const axios = require('axios');

/**
 * Facebook access-token validation (Graph API debug_token endpoint).
 *
 * Required Environment Variables:
 * - FACEBOOK_APP_ID
 * - FACEBOOK_APP_SECRET
 *
 * Why debug_token and not just GET /me: calling /me with the client-supplied
 * access token alone proves the token is valid for *some* Facebook app and
 * returns whatever profile fields that app was granted — it does NOT prove
 * the token was issued for THIS app. A token minted through a different
 * Facebook app (that the same user, or an attacker, controls) could
 * otherwise be replayed here to authenticate as that user. debug_token,
 * called with our own app access token (`FACEBOOK_APP_ID|FACEBOOK_APP_SECRET`),
 * returns the token's real `app_id` and `is_valid` so we can confirm both
 * before trusting anything else about it.
 */

const isFacebookConfigured = () =>
  !!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);

/**
 * @param {string} accessToken - The Facebook user access token from the client
 * @returns {Promise<Object>} - The debug_token `data` payload (app_id, user_id, is_valid, expires_at, scopes)
 * @throws {Error} with `.code === 'FACEBOOK_NOT_CONFIGURED'` (map to 503) or
 *   `.code === 'INVALID_TOKEN'` (map to 401)
 */
const validateFacebookAccessToken = async (accessToken) => {
  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;

  if (!appId || !appSecret) {
    const error = new Error(
      'Facebook login is not configured. Please set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET environment variables.'
    );
    error.code = 'FACEBOOK_NOT_CONFIGURED';
    throw error;
  }

  let debugResponse;
  try {
    debugResponse = await axios.get('https://graph.facebook.com/debug_token', {
      params: {
        input_token: accessToken,
        access_token: `${appId}|${appSecret}`,
      },
    });
  } catch (error) {
    console.error('❌ Facebook debug_token call failed:', error.response?.data || error.message);
    const wrapped = new Error('Invalid or expired Facebook token');
    wrapped.code = 'INVALID_TOKEN';
    throw wrapped;
  }

  const data = debugResponse.data?.data;

  if (!data || !data.is_valid) {
    const error = new Error('Invalid or expired Facebook token');
    error.code = 'INVALID_TOKEN';
    throw error;
  }

  // The coupling this guards against: a token that's perfectly valid, just
  // not for us — e.g. issued to a different Facebook app under the same
  // developer account.
  if (String(data.app_id) !== String(appId)) {
    console.error(`❌ Facebook token app_id mismatch: token belongs to app ${data.app_id}, expected ${appId}`);
    const error = new Error('Facebook token was not issued for this app');
    error.code = 'INVALID_TOKEN';
    throw error;
  }

  return data;
};

module.exports = {
  isFacebookConfigured,
  validateFacebookAccessToken,
};
