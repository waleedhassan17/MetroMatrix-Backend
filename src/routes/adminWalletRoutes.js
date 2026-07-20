/**
 * Admin wallet oversight (Part F) — mounted at /api/admin/wallets in
 * src/app.js, BEFORE the legacy adminRoutes catch-all mount, so these
 * specific paths win.
 */
const express = require('express');
const router = express.Router();

const { protect, adminOnly } = require('../middleware/authMiddleware');
const {
  listWallets,
  getWalletTransactions,
  adjustWallet,
  reconciliation,
} = require('../controllers/adminWalletController');

const guard = [protect, adminOnly];

router.get('/reconciliation', guard, reconciliation);
router.get('/:id/transactions', guard, getWalletTransactions);
router.post('/:id/adjust', guard, adjustWallet);
router.get('/', guard, listWallets);

module.exports = router;
