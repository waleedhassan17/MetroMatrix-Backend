const jwt = require('jsonwebtoken');

// Generate access token (short-lived)
// payload can include: { id, userType, email, tokenType, onboardingStatus, etc. }
const generateAccessToken = (id, payload = {}) => {
  const tokenPayload = { id, ...payload };
  return jwt.sign(tokenPayload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '30d',
  });
};

// Generate refresh token (long-lived)
// payload can include: { id, userType, email, tokenType, onboardingStatus, etc. }
const generateRefreshToken = (id, payload = {}) => {
  const tokenPayload = { id, ...payload };
  return jwt.sign(tokenPayload, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: process.env.REFRESH_TOKEN_EXPIRE || '90d',
  });
};

// Generate both tokens
// options can include: { userType, email, tokenType, onboardingStatus, etc. }
const generateTokens = (id, options = {}) => {
  const accessToken = generateAccessToken(id, options);
  const refreshToken = generateRefreshToken(id, options);
  
  return {
    accessToken,
    refreshToken,
    expiresIn: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
  };
};

// Verify token
const verifyToken = (token, secret) => {
  try {
    return jwt.verify(token, secret);
  } catch (error) {
    return null;
  }
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateTokens,
  verifyToken,
};