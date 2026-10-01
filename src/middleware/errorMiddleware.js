const logger = require('../utils/logger');
const { isAdminRequest, pathOf } = require('../utils/adminScope');
const { ERROR_CODES } = require('../utils/errorCodes');

// Code for an error that only set an HTTP status (res.status(403); throw …).
const CODE_FOR_STATUS = {
  400: ERROR_CODES.VALIDATION_FAILED,
  401: ERROR_CODES.UNAUTHENTICATED,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.CONFLICT,
  429: ERROR_CODES.TOO_MANY_ATTEMPTS,
  503: ERROR_CODES.MAINTENANCE,
};

// Normalise any thrown error into { status, code, message, details }.
function classify(err, res) {
  if (err.name === 'AppError') {
    return { status: err.statusCode, code: err.code, message: err.message, details: err.details };
  }
  if (err.name === 'CastError') {
    return { status: 404, code: ERROR_CODES.NOT_FOUND, message: 'Resource not found' };
  }
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'value';
    return { status: 400, code: ERROR_CODES.CONFLICT, message: `${field} already exists` };
  }
  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors || {})
      .map((val) => val.message)
      .join(', ');
    return { status: 400, code: ERROR_CODES.VALIDATION_FAILED, message };
  }
  if (err.name === 'JsonWebTokenError') {
    return { status: 401, code: ERROR_CODES.TOKEN_INVALID, message: 'Invalid token' };
  }
  if (err.name === 'TokenExpiredError') {
    return { status: 401, code: ERROR_CODES.TOKEN_INVALID, message: 'Token expired' };
  }
  if (err.name === 'MulterError') {
    const messages = {
      LIMIT_FILE_SIZE: 'File size too large',
      LIMIT_FILE_COUNT: 'Too many files',
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field',
    };
    return { status: 400, code: ERROR_CODES.VALIDATION_FAILED, message: messages[err.code] || 'File upload error' };
  }

  const resStatus = res.statusCode && res.statusCode !== 200 ? res.statusCode : null;
  const status = err.statusCode || resStatus || 500;
  return {
    status,
    code: CODE_FOR_STATUS[status] || (status >= 500 ? ERROR_CODES.INTERNAL_ERROR : ERROR_CODES.VALIDATION_FAILED),
    message: err.message,
  };
}

// Error handler middleware
const errorHandler = (err, req, res, next) => {
  const { status, code, message, details } = classify(err, res);

  // Server faults are errors; client faults are routine and only worth a
  // debug line. Either way the request id ties the log to the response.
  const log = req.log || logger;
  const context = { err, status, code, method: req.method, path: pathOf(req) };
  if (status >= 500) log.error(context, 'request failed');
  else log.debug(context, 'request rejected');

  if (err.headers) res.set(err.headers);

  if (isAdminRequest(req)) {
    const body = {
      success: false,
      error: {
        code,
        // Internal failure details stay in the log; the request id finds them.
        message: status >= 500 ? 'Something went wrong on our side. Please try again.' : message || code,
      },
      requestId: req.id,
    };
    if (details !== undefined && status < 500) body.error.details = details;
    return res.status(status).json(body);
  }

  // Legacy shape for the user/provider apps, unchanged.
  res.status(status).json({
    success: false,
    error: message || 'Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

// Not found middleware
const notFound = (req, res, next) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
};

// Async handler to wrap async functions
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
  errorHandler,
  notFound,
  asyncHandler,
  classify,
};
