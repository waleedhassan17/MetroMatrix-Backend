/**
 * Response envelopes for the shopping module.
 * These match the frontend contract in types/shopping.ts exactly
 * (PaginatedResponse<T> / SingleResponse<T>) and intentionally differ
 * from envelopes used elsewhere in this repo.
 */

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const paginated = (res, { data, page, limit, total }) =>
  res.json({
    success: true,
    data,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.max(1, Math.ceil(total / Number(limit))),
    },
  });

const fail = (res, status, error, errors) => {
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
