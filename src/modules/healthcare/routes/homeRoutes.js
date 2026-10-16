const express = require('express');
const router = express.Router();
const { optionalAuth } = require('../../../middleware/authMiddleware');
const { getHome } = require('../controllers/homeController');

// Public: the home works signed out; a patient's token adds their next visit.
router.get('/', optionalAuth, getHome);

module.exports = router;
