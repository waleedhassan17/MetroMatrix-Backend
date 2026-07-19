const express = require('express');
const router = express.Router();

// Shopping module — mounted at /api/shopping in src/app.js
router.use('/', require('./catalogRoutes'));
router.use('/', require('./cartRoutes'));
router.use('/', require('./orderRoutes'));

module.exports = router;
