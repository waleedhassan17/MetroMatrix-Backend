const jwt = require('jsonwebtoken');

// Generate access token (short-lived)
const generateAccessToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '30d',
  });
};

// Generate refresh token (long-lived)
const generateRefreshToken = (id) => {
  return jwt.sign({ id }, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: process.env.REFRESH_TOKEN_EXPIRE || '90d',
  });
};

// Generate both tokens
const generateTokens = (id) => {
  const accessToken = generateAccessToken(id);
  const refreshToken = generateRefreshToken(id);
  
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