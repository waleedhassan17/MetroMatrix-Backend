/**
 * Admin home-services oversight (HS5 Part B) — mounted at /api/admin in
 * src/app.js BEFORE the legacy adminRoutes so these specific paths win.
 * Every mutation is written to the unified AdminAuditLog.
 */
const express = require('express');
const router = express.Router();

const { protect, adminOnly, requirePermission } = require('../../../middleware/authMiddleware');
const adminC = require('../controllers/adminController');

// Guards are attached per route (NOT router.use) so unrelated legacy
// /api/admin/* requests fall through this router untouched — some of those
// (provider-submissions) are intentionally unauthenticated.
//
// Every route names its permission. Home-services oversight needs
// canManageHomeServices; anything that pays money out or back (refunds,
// payout decisions) also needs canManageFinance. Dispute decisions check
// canManageFinance in the controller when they include a refund or penalty.
const hs = [protect, adminOnly, requirePermission('canManageHomeServices')];
const hsMoney = [protect, adminOnly, requirePermission('canManageHomeServices', 'canManageFinance')];
const finance = [protect, adminOnly, requirePermission('canManageFinance')];

// Booking oversight
router.get('/bookings', hs, adminC.listBookings);
router.get('/bookings/:id', hs, adminC.getBookingDetail);
router.patch('/bookings/:id/status', hs, adminC.forceBookingStatus);
router.post('/bookings/:id/refund', hsMoney, adminC.refundBooking);

// Disputes
router.get('/disputes', hs, adminC.listDisputes);
router.patch('/disputes/:id', hs, adminC.resolveDispute);

// Payouts
router.get('/payout-requests', finance, adminC.listPayoutRequests);
router.patch('/payout-requests/:id', finance, adminC.decidePayoutRequest);

// Service categories
router.get('/service-categories', hs, adminC.listCategories);
router.post('/service-categories', hs, adminC.createCategory);
router.patch('/service-categories/:id', hs, adminC.updateCategory);
router.delete('/service-categories/:id', hs, adminC.deleteCategory);

// Dashboard + analytics + settings
router.get('/homeservice/dashboard', hs, adminC.dashboard);
router.get('/homeservice/analytics', hs, adminC.analytics);
router.get('/homeservice/settings', hs, adminC.getSettings);
router.patch('/homeservice/settings', hs, adminC.patchSettings);

module.exports = router;
