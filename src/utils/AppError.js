const { DEFAULT_STATUS } = require('./errorCodes');

/**
 * An error the client is meant to see: a stable `code` (utils/errorCodes.js),
 * an HTTP status, a human message and optional structured `details`.
 * The error handler turns it into
 *   { success: false, error: { code, message, details? }, requestId }.
 */
class AppError extends Error {
  constructor(code, message, { status, details, headers } = {}) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = status || DEFAULT_STATUS[code] || 500;
    if (details !== undefined) this.details = details;
    if (headers) this.headers = headers;
  }
}

module.exports = AppError;
