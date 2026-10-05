/**
 * Response envelopes for the shopping module.
 *
 * Customer and vendor routes keep the shapes the app's types/shopping.ts
 * expects (PaginatedResponse<T> / SingleResponse<T>). Admin routes
 * (/api/shopping/admin/*) answer in the admin console's standard envelope
 * instead — utils/apiResponse.js — so every admin endpoint looks the same:
 *   { success, data, meta? }  /  { success:false, error:{ code, message }, requestId }
 */
const { isAdminRequest } = require('../../../utils/adminScope');
const { ERROR_CODES } = require('../../../utils/errorCodes');

const CODE_FOR_STATUS = {
  400: ERROR_CODES.VALIDATION_FAILED,
  401: ERROR_CODES.UNAUTHENTICATED,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.CONFLICT,
};

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// `extra`: additional top-level fields for customer routes (e.g. the
// natural-language search's `interpretedAs`).
const paginated = (res, { data, page, limit, total, extra }) => {
  const meta = {
    page: Number(page),
    limit: Number(limit),
    total,
    pages: Math.max(1, Math.ceil(total / Number(limit))),
  };
  if (isAdminRequest(res.req)) return res.json({ success: true, data, meta });
  return res.json({ success: true, ...(extra || {}), data, pagination: meta });
};

const fail = (res, status, error, errors) => {
  if (isAdminRequest(res.req)) {
    const body = {
      success: false,
      error: { code: CODE_FOR_STATUS[status] || (status >= 500 ? ERROR_CODES.INTERNAL_ERROR : ERROR_CODES.VALIDATION_FAILED), message: error },
      requestId: res.req.id,
    };
    if (errors) body.error.details = { fields: errors };
    return res.status(status).json(body);
  }
  const body = { success: false, error };
  if (errors) body.errors = errors;
  return res.status(status).json(body);
};

const parsePagination = (query, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};

module.exports = { ok, paginated, fail, parsePagination };
