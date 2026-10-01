const util = require('util');
const pino = require('pino');

/**
 * Structured logger (JSON lines). Replaces console.* in auth, admin and
 * middleware code.
 *
 * - Credentials never reach the log: known secret-bearing fields are redacted
 *   wherever they appear in a logged object. Free-text messages are not
 *   scanned, so never interpolate a token, password, OTP or verification URL
 *   into a message.
 * - Silent under jest unless LOG_LEVEL says otherwise.
 * - Accepts console-style calls — logger.info('Sent to:', email) — so moving
 *   code off console.* doesn't silently drop arguments (plain pino ignores
 *   extra args that have no %s placeholder).
 * - Per-request child loggers carry the request id: use req.log (set by
 *   middleware/requestId.js) inside handlers.
 */

const SECRET_KEYS = [
  'password', 'newPassword', 'currentPassword', 'confirmPassword',
  'token', 'accessToken', 'refreshToken', 'idToken', 'challengeToken',
  'otp', 'code', 'recoveryCode', 'secret', 'totpSecret', 'apiKey',
];

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((k) => `*.${k}`),
  ...SECRET_KEYS.map((k) => `*.*.${k}`),
];

const defaultLevel = () => {
  if (process.env.LOG_LEVEL) return process.env.LOG_LEVEL;
  if (process.env.NODE_ENV === 'test') return 'silent';
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
};

const HAS_PLACEHOLDER = /%[sdifjoO%]/;

const logger = pino({
  level: defaultLevel(),
  base: { service: 'metromatrix-api' },
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  hooks: {
    logMethod(args, method) {
      if (args.length > 1 && typeof args[0] === 'string' && !HAS_PLACEHOLDER.test(args[0])) {
        const err = args.find((a) => a instanceof Error);
        const msg = util.format(...args.map((a) => (a instanceof Error ? a.message : a)));
        return err ? method.call(this, { err }, msg) : method.call(this, msg);
      }
      if (args.length === 1 && args[0] instanceof Error) {
        return method.call(this, { err: args[0] }, args[0].message);
      }
      return method.apply(this, args);
    },
  },
});

module.exports = logger;
