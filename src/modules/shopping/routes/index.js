const express = require('express');
const router = express.Router();

// Shopping module — mounted at /api/shopping in src/app.js
router.use('/', require('./catalogRoutes'));

module.exports = router;
