const AppError = require('../../utils/AppError');
const { ERROR_CODES } = require('../../utils/errorCodes');

const MIN_LENGTH = 10;
const MAX_LENGTH = 128;

// A short deny-list of the passwords that actually get tried first. Not a
// substitute for length, which is the main requirement.
const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'qwerty123', 'qwertyuiop',
  '1234567890', '123456789', '12345678910', 'iloveyou', 'admin12345', 'administrator',
  'welcome123', 'letmein123', 'metromatrix', 'metromatrix1', 'metromatrix123',
]);

/**
 * Reasons a new admin password is unacceptable (empty list = acceptable).
 */
function passwordProblems(password, { email } = {}) {
  const problems = [];
  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    problems.push(`Use at least ${MIN_LENGTH} characters`);
    return problems;
  }
  if (password.length > MAX_LENGTH) problems.push(`Use at most ${MAX_LENGTH} characters`);
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) problems.push('This password is too common');
  if (/^(.)\1+$/.test(password)) problems.push('Do not repeat a single character');
  const local = (email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) problems.push('Do not include your email name');
  return problems;
}

function assertStrongPassword(password, context) {
  const problems = passwordProblems(password, context);
  if (problems.length) {
    throw new AppError(ERROR_CODES.WEAK_PASSWORD, problems.join('. '), { details: { problems, minLength: MIN_LENGTH } });
  }
}

module.exports = { passwordProblems, assertStrongPassword, MIN_LENGTH };
