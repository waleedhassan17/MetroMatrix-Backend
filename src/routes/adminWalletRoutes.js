/**
 * Admin wallet oversight (Part F) — mounted at /api/admin/wallets in
 * src/app.js, BEFORE the legacy adminRoutes catch-all mount, so these
 * specific paths win.
 *
 * Everything here is money, so everything — reads included — needs
 * canManageFinance. Deciding an adjustment above the approval threshold is
 * super-admin only, and the decider must not be the requester (controller).
 */
const express = require('express');
const router = express.Router();

const { protect, adminOnly, requirePermission, requireSuperAdmin } = require('../middleware/authMiddleware');
const {
  listWallets,
  getWalletTransactions,
  adjustWallet,
  listAdjustments,
  approveAdjustment,
  rejectAdjustment,
  reconciliation,
} = require('../controllers/adminWalletController');

const finance = [protect, adminOnly, requirePermission('canManageFinance')];
const financeSuper = [...finance, requireSuperAdmin];

router.get('/reconciliation', finance, reconciliation);
router.get('/adjustments', finance, listAdjustments);
router.post('/adjustments/:adjustmentId/approve', financeSuper, approveAdjustment);
router.post('/adjustments/:adjustmentId/reject', financeSuper, rejectAdjustment);
router.get('/:id/transactions', finance, getWalletTransactions);
router.post('/:id/adjust', finance, adjustWallet);
router.get('/', finance, listWallets);

module.exports = router;
