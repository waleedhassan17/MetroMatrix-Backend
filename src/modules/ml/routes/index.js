/**
 * ML / personalisation routes — mounted at /api (gateway/registry.js).
 */
const express = require('express');
const router = express.Router();

const { optionalAuth, protect, adminOnly, userOnly } = require('../../../middleware/authMiddleware');
const { requireInternalKey } = require('../../../gateway/internalAuth');
const eventC = require('../controllers/eventController');
const adminC = require('../controllers/adminMlController');
const recsC = require('../controllers/recsController');
const searchC = require('../controllers/serviceSearchController');

// Interaction log (feeds recommendations and ranking).
router.post('/events', optionalAuth, eventC.postEvents);

// Recommendations — every item re-checked against today's visibility rules.
router.get('/recommendations/shopping', optionalAuth, recsC.shopping);
router.get('/recommendations/shopping/trending', recsC.trending);
router.get('/recommendations/shopping/similar/:productId', recsC.similar);
router.get('/recommendations/homeservice', protect, userOnly, recsC.homeservice);
router.get('/recommendations/healthcare', protect, userOnly, recsC.healthcare);

// "My AC isn't cooling" → the right trade (rules first, Gemini as a second opinion).
router.get('/search/services', require('../../../gateway/rateLimit').limiter('nlq'), searchC.searchServices);

// Model registry, for admins.
router.get('/admin/ml/models', protect, adminOnly, adminC.listModels);
router.post('/admin/ml/models/:id/activate', protect, adminOnly, adminC.activateModel);
router.post('/admin/ml/models/:id/archive', protect, adminOnly, adminC.archiveModel);
router.get('/admin/ml/runs', protect, adminOnly, adminC.listRuns);

// The nightly ML job, when it finishes.
router.post('/internal/ml/refresh', requireInternalKey, adminC.refresh);

module.exports = router;
