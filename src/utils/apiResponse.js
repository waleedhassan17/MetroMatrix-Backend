/**
 * The one response envelope for admin endpoints:
 *
 *   success: { success: true, data, meta? }
 *   failure: { success: false, error: { code, message, details? }, requestId }
 *
 * `meta` carries pagination ({ page, limit, total, pages, nextCursor? }).
 * Failures are normally thrown as AppError and rendered by the error
 * handler; `fail` exists for the few places that answer directly.
 */
const ok = (res, data, meta, status = 200) => {
  const body = { success: true, data: data === undefined ? null : data };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
};

const created = (res, data, meta) => ok(res, data, meta, 201);

const fail = (res, status, code, message, details) => {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return res.status(status).json({ success: false, error, requestId: res.req?.id });
};

module.exports = { ok, created, fail };
