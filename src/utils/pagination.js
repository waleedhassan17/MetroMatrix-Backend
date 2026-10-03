/**
 * Paging for admin lists.
 *
 * Every admin list used to read `parseInt(req.query.limit) || 10` with no
 * ceiling — `?limit=100000` dumped a whole collection (and could time out the
 * 30 s serverless function); `?limit=0` meant "no limit" to MongoDB. Here:
 *  - limit is clamped to [1, MAX_PAGE_SIZE] (also served as meta.limits);
 *  - sort fields come from a per-list whitelist (never straight from the
 *    query string), ties broken by _id so pages are stable;
 *  - `?cursor=` (opaque, from meta.nextCursor) pages large collections
 *    without skip; `?page=` keeps working for small ones.
 *
 * Response meta: { page, limit, total, pages, nextCursor }.
 */
const AppError = require('./AppError');
const { ERROR_CODES } = require('./errorCodes');

const MAX_PAGE_SIZE = 100;

const clampInt = (value, fallback, min, max) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

function encodeCursor(doc, field) {
  const v = doc[field];
  const payload = { id: String(doc._id), v: v instanceof Date ? { $d: v.toISOString() } : v ?? null };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const { id, v } = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new Error('bad id');
    return { id, v: v && typeof v === 'object' && v.$d ? new Date(v.$d) : v };
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Invalid cursor', { details: { fields: [{ field: 'cursor', message: 'Invalid cursor' }] } });
  }
}

/**
 * @param {object} query  req.query
 * @param {object} opts   { sortable: string[], defaultSort: '-createdAt', defaultLimit: 20 }
 * @returns {{ page, limit, skip, sort, sortField, sortDir, cursorFilter }}
 */
function parseListQuery(query = {}, { sortable = ['createdAt'], defaultSort = '-createdAt', defaultLimit = 20 } = {}) {
  const page = clampInt(query.page, 1, 1, 1_000_000);
  const limit = clampInt(query.limit, defaultLimit, 1, MAX_PAGE_SIZE);

  // `sort=-field` | `sort=field`; legacy `sortBy` + `sortOrder` still read.
  let requested = typeof query.sort === 'string' ? query.sort : null;
  if (!requested && typeof query.sortBy === 'string') requested = `${query.sortOrder === 'asc' ? '' : '-'}${query.sortBy}`;
  const candidate = requested && sortable.includes(requested.replace(/^-/, '')) ? requested : defaultSort;
  const sortDir = candidate.startsWith('-') ? -1 : 1;
  const sortField = candidate.replace(/^-/, '');
  const sort = { [sortField]: sortDir, _id: sortDir };

  let cursorFilter = null;
  if (query.cursor) {
    const { id, v } = decodeCursor(query.cursor);
    const op = sortDir === -1 ? '$lt' : '$gt';
    const mongoose = require('mongoose');
    const oid = new mongoose.Types.ObjectId(id);
    cursorFilter = sortField === '_id' ? { _id: { [op]: oid } } : { $or: [{ [sortField]: { [op]: v } }, { [sortField]: v, _id: { [op]: oid } }] };
  }

  return { page, limit, skip: cursorFilter ? 0 : (page - 1) * limit, sort, sortField, sortDir, cursorFilter };
}

/**
 * Run a paged find + count. `filter` excludes the cursor; the count is of the
 * whole filtered set.
 * @returns {Promise<{ items: any[], meta: object }>}
 */
async function findPage(Model, filter, list, { select, populate, lean = false } = {}) {
  const pageFilter = list.cursorFilter ? { $and: [filter, list.cursorFilter] } : filter;
  let q = Model.find(pageFilter).sort(list.sort).skip(list.skip).limit(list.limit);
  if (select) q = q.select(select);
  if (populate) q = q.populate(populate);
  if (lean) q = q.lean();
  const [items, total] = await Promise.all([q, Model.countDocuments(filter)]);
  return { items, meta: pageMeta(list, total, items) };
}

function pageMeta(list, total, items = []) {
  const meta = { page: list.cursorFilter ? null : list.page, limit: list.limit, total, pages: Math.max(1, Math.ceil(total / list.limit)) };
  meta.nextCursor = items.length === list.limit ? encodeCursor(items[items.length - 1], list.sortField) : null;
  return meta;
}

// Escape user search text for a case-insensitive regex (every metacharacter
// is escaped, so the input can only ever match literally).
const searchRegex = (text) =>
  // eslint-disable-next-line security/detect-non-literal-regexp
  new RegExp(String(text).trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

module.exports = { MAX_PAGE_SIZE, parseListQuery, findPage, pageMeta, encodeCursor, decodeCursor, searchRegex, clampInt };
