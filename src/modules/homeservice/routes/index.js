/**
 * Home Services routes — mounted at /api in src/app.js BEFORE the legacy
 * /api/providers mount. The paths below are exactly what the frontend's
 * networks/serviceProviders/* modules already call (HOMESERVICE_SPEC.md §1).
 * GET /providers and GET /providers/:id fall through (next()) to the legacy
 * handlers when the request is not about a home-service provider.
 */
const express = require('express');
const router = express.Router();

const { protect, userOnly, providerOnly } = require('../../../middleware/authMiddleware');
const { loadBookingWithAccess } = require('../middleware/bookingAccess');

const bookingC = require('../controllers/bookingController');
const userC = require('../controllers/userController');
const jobC = require('../controllers/jobController');
const searchC = require('../controllers/providerSearchController');
const paymentC = require('../controllers/paymentController');
const reviewC = require('../controllers/reviewController');
const earningsC = require('../controllers/earningsController');
const chatC = require('../controllers/chatController');
const hsNotifC = require('../controllers/hsNotificationController');
const trackingC = require('../controllers/trackingController');
const adminC = require('../controllers/adminController');
const favoritesC = require('../controllers/favoritesController');

// ---------- Provider discovery (public) ----------
router.get('/providers', searchC.searchProviders); // falls through if not HS
router.get('/providers/:providerId/reviews', searchC.getProviderReviews);
router.get('/providers/:providerId', searchC.getProviderDetails); // falls through if not HS

// ---------- Public service catalogue ----------
router.get('/service-categories', adminC.publicCategories);

// ---------- Customer: bookings ----------
router.get('/bookings/init/:providerId', protect, userOnly, bookingC.initBooking);
router.post('/bookings', protect, userOnly, bookingC.createBooking);
router.get('/bookings/:id/service-status', protect, loadBookingWithAccess, bookingC.getServiceStatus);
router.get('/bookings/:bookingId/tracking', protect, loadBookingWithAccess, trackingC.getTrackingData);
router.patch('/bookings/:id/status', protect, loadBookingWithAccess, bookingC.patchBookingStatus);
router.post('/bookings/:id/complete', protect, loadBookingWithAccess, bookingC.completeBookingByCustomer);
router.post('/bookings/:id/cancel', protect, loadBookingWithAccess, bookingC.cancelBooking);
router.post('/bookings/:id/dispute', protect, loadBookingWithAccess, adminC.raiseDispute);
router.get('/bookings/:id', protect, loadBookingWithAccess, bookingC.getBooking);

// ---------- Customer: user aggregate ----------
router.get('/user/home', protect, userOnly, userC.getHome);
router.get('/user/bookings', protect, userOnly, userC.getUserBookings);
router.post('/user/bookings/:bookingId/cancel', protect, loadBookingWithAccess, userC.cancelUserBooking);
router.patch('/user/bookings/:bookingId/status', protect, loadBookingWithAccess, userC.updateUserBookingStatus);
router.post('/user/bookings/:bookingId/rate', protect, loadBookingWithAccess, (req, res, next) => {
  // Legacy rate endpoint — same guard path as POST /reviews
  req.body.bookingId = req.params.bookingId;
  req.body.feedback = req.body.review || req.body.feedback;
  require('../controllers/reviewController').submitReview(req, res, next);
});
router.get('/user/notifications', protect, userOnly, userC.getNotifications);

// ---------------------------------------------------------------------------
// Persisted notifications — BOTH roles, one set of endpoints.
//
// `protect` alone, deliberately: it resolves a token against User then Provider
// and sets req.user either way, and every query below is scoped by
// req.user._id. So a customer and a provider each see exactly their own rows
// with no role gate to get wrong. Adding userOnly/providerOnly would mean two
// parallel route sets for one behaviour.
//
// Distinct from /user/notifications above, which synthesizes a read-only list
// from booking statusHistory on every request and is customer-only. That stays
// for the existing customer screen; this is the durable store, and the provider
// side had no notifications of any kind before it.
//
// `/read-all` MUST precede `/:notificationId/read`, or Express matches
// "read-all" as a notificationId.
// ---------------------------------------------------------------------------
router.get('/notifications', protect, hsNotifC.listNotifications);
router.get('/notifications/unread-count', protect, hsNotifC.unreadCount);
router.patch('/notifications/read-all', protect, hsNotifC.markAllRead);
router.patch('/notifications/:notificationId/read', protect, hsNotifC.markRead);

router.get('/user/profile', protect, userOnly, userC.getUserProfile);
router.patch('/user/profile', protect, userOnly, userC.updateUserProfile);
router.post('/user/profile/avatar', protect, userOnly, userC.updateUserAvatar);
router.get('/user/addresses', protect, userOnly, userC.getAddresses);
router.post('/user/addresses', protect, userOnly, userC.addAddress);
router.patch('/user/addresses/:addressId', protect, userOnly, userC.updateAddress);
router.delete('/user/addresses/:addressId', protect, userOnly, userC.deleteAddress);

// ---------- Customer: favourite providers (the wishlist heart) ----------
router.get('/user/favorites', protect, userOnly, favoritesC.getFavorites);
router.post('/user/favorites/:providerId', protect, userOnly, favoritesC.addFavorite);
router.delete('/user/favorites/:providerId', protect, userOnly, favoritesC.removeFavorite);

// ---------- Provider: jobs ----------
router.get('/provider/jobs', protect, providerOnly, jobC.listJobs);
router.get('/provider/jobs/:jobId/awaiting-approval', protect, providerOnly, loadBookingWithAccess, jobC.getAwaitingApproval);
router.get('/provider/jobs/:jobId/approval-status', protect, providerOnly, loadBookingWithAccess, jobC.getApprovalStatus);
router.get('/provider/jobs/:jobId/in-progress', protect, providerOnly, loadBookingWithAccess, jobC.getInProgressData);
router.get('/provider/jobs/:jobId/completion', protect, providerOnly, loadBookingWithAccess, jobC.getCompletionData);
router.get('/provider/jobs/:jobId/navigation', protect, providerOnly, loadBookingWithAccess, jobC.getNavigationData);
router.get('/provider/jobs/:jobId/payment', protect, providerOnly, loadBookingWithAccess, paymentC.initProviderPayment);
router.post('/provider/jobs/:jobId/accept', protect, providerOnly, loadBookingWithAccess, jobC.acceptJob);
router.post('/provider/jobs/:jobId/reject', protect, providerOnly, loadBookingWithAccess, jobC.rejectJob);
router.post('/provider/jobs/:jobId/start', protect, providerOnly, loadBookingWithAccess, jobC.startJob);
router.post('/provider/jobs/:jobId/arrived', protect, providerOnly, loadBookingWithAccess, jobC.arriveJob);
router.post('/provider/jobs/:jobId/start-work', protect, providerOnly, loadBookingWithAccess, jobC.startWork);
router.post('/provider/jobs/:jobId/complete-work', protect, providerOnly, loadBookingWithAccess, jobC.completeWork);
router.post('/provider/jobs/:jobId/complete', protect, providerOnly, loadBookingWithAccess, jobC.completeJob);
router.post('/provider/jobs/:jobId/finalize', protect, providerOnly, loadBookingWithAccess, jobC.finalizeJob);
router.post('/provider/jobs/:jobId/request-payment', protect, providerOnly, loadBookingWithAccess, paymentC.requestPayment);
router.post('/provider/jobs/:jobId/confirm-payment', protect, providerOnly, loadBookingWithAccess, paymentC.confirmOnlinePayment);
router.post('/provider/jobs/:jobId/confirm-cash', protect, providerOnly, loadBookingWithAccess, paymentC.confirmCashPayment);
router.get('/provider/jobs/:jobId', protect, providerOnly, loadBookingWithAccess, jobC.getJobDetail);

// ---------- Provider: dashboard / profile / earnings / location ----------
router.get('/provider/dashboard', protect, providerOnly, jobC.getDashboard);
router.get('/provider/profile', protect, providerOnly, jobC.getProviderProfile);
router.patch('/provider/profile', protect, providerOnly, jobC.updateProviderProfile);
router.patch('/provider/status', protect, providerOnly, jobC.updateOnlineStatus);
router.patch('/provider/online-status', protect, providerOnly, jobC.updateOnlineStatus);
router.get('/provider/earnings', protect, providerOnly, earningsC.getEarnings);
router.post('/provider/earnings/payout', protect, providerOnly, earningsC.requestPayout);
router.post('/provider/payout-request', protect, providerOnly, earningsC.requestPayout);
router.post('/provider/location', protect, providerOnly, trackingC.updateProviderLocation);

// ---------- Chat — RETIRED, OWNED BY THE REALTIME SERVICE ----------
//
// Chat and calling live in the `metromatrix-realtime` service, not here. It
// owns the socket layer (live delivery, typing, read receipts, call
// signalling) plus the REST history/send endpoints the app actually calls:
//
//   GET  {REALTIME_URL}/api/chat/:roomId?roomType=homeservice|healthcare
//   POST {REALTIME_URL}/api/chat/:roomId/messages
//
// Both services write the SAME collection (`hschatmessages`) with identical
// field names, so history is shared — see the contract note in
// metromatrix-realtime/src/models/ChatMessage.js. That is precisely why these
// routes are unsafe to leave mounted: they are a second, socket-less write
// path into that collection. A message accepted here is persisted but never
// broadcast and never pushed, so the other party sees nothing until they cold-
// load history.
//
// The app stopped calling these when chat moved to the realtime service
// (networks/serviceProviders/chatNetwork.ts routes every chat call through
// realtimeClient). Commented out rather than deleted so the controller remains
// for reference and for scripts/seed-homeservice.js, which writes chat threads
// through the ChatMessage model directly rather than over HTTP.
//
// router.get('/chat/:bookingId', protect, loadBookingWithAccess, chatC.getChatData);
// router.post('/chat/:bookingId/messages', protect, loadBookingWithAccess, chatC.sendMessage);

// ---------- Payments (customer) ----------
router.get('/payments/:bookingId/init', protect, userOnly, loadBookingWithAccess, paymentC.initCustomerPayment);
router.post('/payments/process', protect, userOnly, paymentC.processPayment);

// ---------- Reviews ----------
router.get('/reviews/:bookingId/init', protect, userOnly, loadBookingWithAccess, reviewC.initReview);
router.post('/reviews', protect, userOnly, reviewC.submitReview);

module.exports = router;
