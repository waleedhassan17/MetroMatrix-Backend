// ============================================================================
// Customer favourites (the wishlist heart on a provider profile).
//
// The heart existed in the app but had nothing behind it — no route, no model,
// no controller — so tapping it could never persist anything. This mirrors the
// shopping module's wishlistController so the two behave the same way.
//
// Every handler returns the FULL updated list. The client can then replace its
// state outright instead of trying to reconcile a partial response, which is
// what makes an optimistic heart safe to roll back.
// ============================================================================

const asyncHandler = require('express-async-handler');
const Favorite = require('../models/Favorite');
const Provider = require('../../../models/Provider');
const { toProviderCard } = require('../services/serializers');

const ok = (res, data, message) => res.json({ success: true, data, message });
const fail = (res, code, message) => res.status(code).json({ success: false, message });

const getOrCreate = async (userId) => {
  let list = await Favorite.findOne({ userId });
  if (!list) list = await Favorite.create({ userId, items: [] });
  return list;
};

const serialize = async (list) => {
  await list.populate({
    path: 'items.provider',
    select:
      'fullName email phoneNumber profilePhoto ratings experience basePrice adminVerified ' +
      'verificationStatus isAvailable isOnline profession specialty briefDescription ' +
      'serviceAreas city providerSubType skills certifications languages completedBookings ' +
      'totalBookings currentLocation createdAt updatedAt',
  });

  return list.items
    // A provider whose account was removed leaves a dangling ref; drop it
    // rather than serializing null and crashing the list.
    .filter((it) => it.provider)
    .map((it) => ({
      ...toProviderCard(it.provider),
      favoritedAt: it.addedAt,
    }));
};

// @desc  GET /api/user/favorites
const getFavorites = asyncHandler(async (req, res) => {
  const list = await getOrCreate(req.user._id);
  return ok(res, await serialize(list), 'Favorites fetched');
});

// @desc  POST /api/user/favorites/:providerId
const addFavorite = asyncHandler(async (req, res) => {
  const provider = await Provider.findById(req.params.providerId);
  if (!provider) return fail(res, 404, 'Provider not found');

  const list = await getOrCreate(req.user._id);
  const exists = list.items.some(
    (it) => String(it.provider) === String(provider._id)
  );
  // Adding twice is a no-op, not an error — the client may retry after a
  // dropped response and must not get a 409 for it.
  if (!exists) {
    list.items.push({ provider: provider._id });
    await list.save();
  }

  return ok(res, await serialize(list), 'Added to favorites');
});

// @desc  DELETE /api/user/favorites/:providerId
const removeFavorite = asyncHandler(async (req, res) => {
  const list = await getOrCreate(req.user._id);
  list.items = list.items.filter(
    (it) => String(it.provider) !== String(req.params.providerId)
  );
  await list.save();

  return ok(res, await serialize(list), 'Removed from favorites');
});

module.exports = { getFavorites, addFavorite, removeFavorite };
