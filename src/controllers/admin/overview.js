const asyncHandler = require('express-async-handler');
const { ok } = require('../../utils/apiResponse');
const { overview } = require('../../services/admin/overviewService');
const { queuePage } = require('../../services/admin/queueService');

// @route GET /api/admin/overview — the home screen in one call (see overviewService).
const getOverview = asyncHandler(async (req, res) => {
  // Short private cache: pull-to-refresh within 30 s is served from the
  // device, and the figures are never shared between admins.
  res.set('Cache-Control', 'private, max-age=30');
  ok(res, await overview(req.user));
});

// @route GET /api/admin/queue?type=&cursor=&limit= — the work queue, oldest first.
const getQueue = asyncHandler(async (req, res) => {
  const { type, cursor, limit } = req.query;
  const page = await queuePage(req.user, { type, cursor, limit });
  ok(res, page.items, { limit: page.items.length, nextCursor: page.nextCursor, types: page.types });
});

module.exports = { getOverview, getQueue };
