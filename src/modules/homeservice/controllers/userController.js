const asyncHandler = require('express-async-handler');
const Booking = require('../models/Booking');
const SavedAddress = require('../models/SavedAddress');
const ServiceCategory = require('../models/ServiceCategory');
const Provider = require('../../../models/Provider');
const User = require('../../../models/User');
const { transition } = require('../services/bookingService');
const { STATUS } = require('../services/statusMap');
const { toUserBooking, avatar, CATEGORY_TO_SUBTYPE } = require('../services/serializers');

const ok = (res, data, message, pagination) =>
  res.json({ success: true, data, message, ...(pagination ? { pagination } : {}) });

// Static promos — marketing content, not data the report claims is dynamic.
const PROMOTIONS = [
  {
    id: 'promo-1',
    title: 'First Service Free',
    subtitle: 'Get 30% off on your first home service booking',
    discount: '30% OFF',
    badge: '🎉 NEW USER',
    gradient: ['#10B981', '#059669'],
    cta: 'Claim Now',
    icon: '🏠',
  },
  {
    id: 'promo-2',
    title: 'Weekend Special',
    subtitle: 'Book any service this weekend and save big',
    discount: '40% OFF',
    badge: '⚡ LIMITED',
    gradient: ['#8B5CF6', '#6D28D9'],
    cta: 'Book Now',
    icon: '🔧',
  },
];

// GET /api/user/home — home screen aggregate (categories from the catalogue + live provider counts)
const getHome = asyncHandler(async (req, res) => {
  const cats = await ServiceCategory.find({ isActive: true }).sort({ sortOrder: 1 });
  const categories = await Promise.all(
    cats.map(async (c) => {
      const providers = await Provider.find({
        providerType: 'home_service',
        providerSubType: c.providerSubType,
        adminVerified: 'approved',
      })
        .select('fullName profilePhoto')
        .limit(3);
      const count = await Provider.countDocuments({
        providerType: 'home_service',
        providerSubType: c.providerSubType,
        adminVerified: 'approved',
      });
      return {
        id: c.slug,
        name: c.name,
        badge: c.badge || c.name.toUpperCase(),
        badgeColor: c.badgeColor,
        description: c.description,
        image: c.image,
        providerCount: `${count}+ Experts`,
        providers: providers.map((p) => avatar(p.fullName, p.profilePhoto)),
        icon: c.icon,
      };
    })
  );
  ok(res, { categories, promotions: PROMOTIONS }, 'Home data fetched');
});

// GET /api/user/bookings?status= — customer bookings list (UserBooking[])
const getUserBookings = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 50 } = req.query;
  const query = { customer: req.user._id };
  const bookings = await Booking.find(query)
    .populate('provider', 'fullName profilePhoto')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit));

  let items = bookings.map(toUserBooking);
  if (status && status !== 'all') {
    items = items.filter((b) => b.status === status);
  }
  ok(res, items, 'Bookings fetched');
});

// POST /api/user/bookings/:bookingId/cancel
const cancelUserBooking = asyncHandler(async (req, res) => {
  await transition(req.booking, STATUS.CANCELLED, {
    id: req.user._id,
    role: req.bookingRole,
  }, { reason: req.body.reason || 'Cancelled by customer' });
  ok(res, { bookingId: String(req.booking._id) }, 'Booking cancelled');
});

// PATCH /api/user/bookings/:bookingId/status
const updateUserBookingStatus = asyncHandler(async (req, res) => {
  await transition(req.booking, req.body.status, {
    id: req.user._id,
    role: req.bookingRole,
  }, { reason: req.body.reason });
  ok(res, { bookingId: String(req.booking._id), status: req.booking.status }, 'Booking status updated');
});

// GET /api/user/profile — UserProfileData
const getUserProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  const addresses = await SavedAddress.find({ user: user._id }).sort({
    isDefault: -1,
    createdAt: -1,
  });
  const [bookings, reviews] = await Promise.all([
    Booking.countDocuments({ customer: user._id }),
    Booking.countDocuments({ customer: user._id, status: STATUS.COMPLETED }),
  ]);
  ok(res, {
    user: {
      id: String(user._id),
      name: user.fullName,
      email: user.email,
      phone: user.phoneNumber || '',
      avatar: avatar(user.fullName, user.profilePhoto),
      isPremium: false,
      stats: { bookings, reviews, points: bookings * 20 },
    },
    addresses: addresses.map((a) => ({
      id: String(a._id),
      label: a.label,
      address: a.line1,
      city: a.city,
      isDefault: a.isDefault,
    })),
    paymentMethods: [
      { id: 'wallet', type: 'wallet', label: 'MetroMatrix Wallet', isDefault: true },
    ],
  }, 'Profile fetched');
});

// PATCH /api/user/profile
const updateUserProfile = asyncHandler(async (req, res) => {
  const { name, phone } = req.body;
  const user = await User.findById(req.user._id);
  if (name) user.fullName = name;
  if (phone) user.phoneNumber = phone;
  await user.save();
  ok(res, {
    id: String(user._id),
    name: user.fullName,
    email: user.email,
    phone: user.phoneNumber || '',
    avatar: avatar(user.fullName, user.profilePhoto),
    isPremium: false,
    stats: { bookings: 0, reviews: 0, points: 0 },
  }, 'Profile updated');
});

// POST /api/user/profile/avatar
const updateUserAvatar = asyncHandler(async (req, res) => {
  const { avatar: avatarUri } = req.body;
  await User.updateOne({ _id: req.user._id }, { profilePhoto: avatarUri });
  ok(res, { avatar: avatarUri }, 'Avatar updated');
});

// GET /api/user/addresses
const getAddresses = asyncHandler(async (req, res) => {
  const addresses = await SavedAddress.find({ user: req.user._id }).sort({
    isDefault: -1,
    createdAt: -1,
  });
  ok(res, addresses.map((a) => ({
    id: String(a._id),
    label: a.label,
    address: a.line1,
    city: a.city,
    isDefault: a.isDefault,
    coordinates: {
      latitude: a.coordinates.coordinates[1],
      longitude: a.coordinates.coordinates[0],
    },
    icon: a.icon,
  })), 'Addresses fetched');
});

// POST /api/user/addresses
const addAddress = asyncHandler(async (req, res) => {
  const { label, address, city, isDefault, coordinates, icon } = req.body;
  if (!address) {
    res.status(400);
    throw new Error('Address line is required');
  }
  if (isDefault) {
    await SavedAddress.updateMany({ user: req.user._id }, { isDefault: false });
  }
  const doc = await SavedAddress.create({
    user: req.user._id,
    label: label || 'Home',
    line1: address,
    city: city || '',
    icon: icon || 'location',
    isDefault: !!isDefault,
    ...(coordinates && coordinates.latitude
      ? { coordinates: { type: 'Point', coordinates: [coordinates.longitude, coordinates.latitude] } }
      : {}),
  });
  ok(res, {
    id: String(doc._id),
    label: doc.label,
    address: doc.line1,
    city: doc.city,
    isDefault: doc.isDefault,
  }, 'Address added');
});

// PATCH /api/user/addresses/:addressId
const updateAddress = asyncHandler(async (req, res) => {
  const doc = await SavedAddress.findOne({ _id: req.params.addressId, user: req.user._id });
  if (!doc) {
    res.status(404);
    throw new Error('Address not found');
  }
  const { label, address, city, isDefault, icon, coordinates } = req.body;
  if (label !== undefined) doc.label = label;
  if (address !== undefined) doc.line1 = address;
  if (city !== undefined) doc.city = city;
  if (icon !== undefined) doc.icon = icon;
  if (coordinates && coordinates.latitude) {
    doc.coordinates = { type: 'Point', coordinates: [coordinates.longitude, coordinates.latitude] };
  }
  if (isDefault) {
    await SavedAddress.updateMany({ user: req.user._id }, { isDefault: false });
    doc.isDefault = true;
  }
  await doc.save();
  ok(res, {
    id: String(doc._id),
    label: doc.label,
    address: doc.line1,
    city: doc.city,
    isDefault: doc.isDefault,
  }, 'Address updated');
});

// DELETE /api/user/addresses/:addressId
const deleteAddress = asyncHandler(async (req, res) => {
  const doc = await SavedAddress.findOneAndDelete({
    _id: req.params.addressId,
    user: req.user._id,
  });
  if (!doc) {
    res.status(404);
    throw new Error('Address not found');
  }
  ok(res, { addressId: req.params.addressId }, 'Address deleted');
});

// GET /api/user/notifications — booking lifecycle notifications, derived
// from statusHistory (no separate notification store for home services).
const getNotifications = asyncHandler(async (req, res) => {
  const bookings = await Booking.find({ customer: req.user._id })
    .populate('provider', 'fullName')
    .sort({ updatedAt: -1 })
    .limit(30);

  const LABELS = {
    PENDING: 'Booking request sent',
    ACCEPTED: 'Provider accepted your booking',
    REJECTED: 'Provider declined your booking',
    CANCELLED: 'Booking was cancelled',
    EN_ROUTE: 'Provider is on the way',
    ARRIVED: 'Provider has arrived',
    IN_PROGRESS: 'Work has started',
    COMPLETED: 'Job completed — you can pay and review now',
  };

  const items = [];
  bookings.forEach((b) => {
    (b.statusHistory || []).forEach((h) => {
      items.push({
        id: `${b._id}-${h.status}-${h.changedAt ? h.changedAt.getTime() : 0}`,
        bookingId: String(b._id),
        type: h.status,
        title: LABELS[h.status] || h.status,
        body: `${b.serviceSubCategory || b.serviceCategory} · ${
          b.provider ? b.provider.fullName : 'Provider'
        }`,
        at: h.changedAt ? h.changedAt.toISOString() : b.updatedAt.toISOString(),
      });
    });
  });
  items.sort((a, b) => (a.at < b.at ? 1 : -1));
  ok(res, items.slice(0, 50), 'Notifications fetched');
});

module.exports = {
  getHome,
  getNotifications,
  getUserBookings,
  cancelUserBooking,
  updateUserBookingStatus,
  getUserProfile,
  updateUserProfile,
  updateUserAvatar,
  getAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
};
