/**
 * Admin home-services oversight (HS5 Part B) — mounted at /api/admin in
 * src/app.js BEFORE the legacy adminRoutes so these specific paths win.
 * Every mutation writes an HSAuditLog record.
 */
const express = require('express');
const router = express.Router();

const { protect, adminOnly } = require('../../../middleware/authMiddleware');
const adminC = require('../controllers/adminController');

// Guards are attached per route (NOT router.use) so unrelated legacy
// /api/admin/* requests fall through this router untouched — some of those
// (provider-submissions) are intentionally unauthenticated.
const guard = [protect, adminOnly];

// Booking oversight
router.get('/bookings', guard, adminC.listBookings);
router.get('/bookings/:id', guard, adminC.getBookingDetail);
router.patch('/bookings/:id/status', guard, adminC.forceBookingStatus);
router.post('/bookings/:id/refund', guard, adminC.refundBooking);

// Disputes
router.get('/disputes', guard, adminC.listDisputes);
router.patch('/disputes/:id', guard, adminC.resolveDispute);

// Payouts
router.get('/payout-requests', guard, adminC.listPayoutRequests);
router.patch('/payout-requests/:id', guard, adminC.decidePayoutRequest);

// Service categories
router.get('/service-categories', guard, adminC.listCategories);
router.post('/service-categories', guard, adminC.createCategory);
router.patch('/service-categories/:id', guard, adminC.updateCategory);
router.delete('/service-categories/:id', guard, adminC.deleteCategory);

// Dashboard + analytics + settings
router.get('/homeservice/dashboard', guard, adminC.dashboard);
router.get('/homeservice/analytics', guard, adminC.analytics);
router.get('/homeservice/settings', guard, adminC.getSettings);
router.patch('/homeservice/settings', guard, adminC.patchSettings);

module.exports = router;
