// Runs before every test file, before the file's own `require('dotenv')`.
// dotenv never overrides a variable that is already set, so whatever we put
// in process.env here wins over the real .env.
const crypto = require('crypto');

const base = process.env.TEST_MONGODB_BASE_URI;
if (!base) {
  throw new Error('TEST_MONGODB_BASE_URI missing — run tests through jest (globalSetup starts the in-memory DB).');
}

// One database per test file, so suites can't see each other's documents.
const dbName = `test_${crypto.randomBytes(6).toString('hex')}`;
const url = new URL(base);
url.pathname = `/${dbName}`;
process.env.MONGODB_URI = url.toString();

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const assertLocal = (uri) => {
  let host;
  try {
    host = new URL(uri).hostname;
  } catch {
    throw new Error('Refusing to run tests: MONGODB_URI is not a parseable URI.');
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error('Refusing to run tests against a non-local MongoDB host.');
  }
};
assertLocal(process.env.MONGODB_URI);

// Every supertest request comes from the same address; the per-IP API limiter
// would turn long suites into 429s. Brute-force protection that matters (admin
// sign-in lockout) is MongoDB-backed and stays on.
process.env.DISABLE_RATE_LIMIT = 'true';

// Deterministic, test-only secrets — never the real ones from .env.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-access-secret-0123456789abcdef';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret-0123456789abcdef';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.TOTP_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
