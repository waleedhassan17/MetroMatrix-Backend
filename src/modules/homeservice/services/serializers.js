/**
 * Doc → frontend-shape serializers. Field names here MUST match
 * models/serviceProviders/*.ts in the app — the frontend renders these
 * objects without an adapter layer.
 */
const {
  toBookingStatus,
  toConfirmationStatus,
  toJobBucket,
  toDashboardStatus,
} = require('./statusMap');

const SUBTYPE_TO_CATEGORY = {
  electrician: 'electricians',
  plumber: 'plumbers',
  ac_repairer: 'ac-repairers',
};
const CATEGORY_TO_SUBTYPE = {
  electricians: 'electrician',
  plumbers: 'plumber',
  'ac-repairers': 'ac_repairer',
};

const DEFAULT_AVATAR = 'https://ui-avatars.com/api/?background=4F46E5&color=fff&name=';

function avatar(name, photo) {
  return photo || `${DEFAULT_AVATAR}${encodeURIComponent(name || 'P')}`;
}

function coords(geo) {
  const c = geo && geo.coordinates ? geo.coordinates : [74.3587, 31.5204];
  return { latitude: c[1], longitude: c[0] };
}

// → models/serviceProviders/provider.ts Provider
function toProviderCard(p, extras = {}) {
  return {
    id: String(p._id),
    name: p.fullName,
    image: avatar(p.fullName, p.profilePhoto),
    email: p.email,
    phoneNumber: p.phoneNumber,
    rating: p.ratings ? Math.round((p.ratings.average || 0) * 10) / 10 : 0,
    reviews: p.ratings ? p.ratings.count || 0 : 0,
    experience: p.experience || '1 year',
    price: p.basePrice || 0,
    verified: p.adminVerified === 'approved' || p.verificationStatus === 'approved',
    available: p.isAvailable !== false,
    isOnline: !!p.isOnline,
    responseTime: p.isOnline ? '~15 min' : '~1 hour',
    specialty: p.profession || p.specialty || '',
    bio: p.briefDescription || '',
    address: (p.serviceAreas && p.serviceAreas[0]) || p.city || '',
    city: p.city || '',
    category: SUBTYPE_TO_CATEGORY[p.providerSubType] || 'electricians',
    skills: p.skills || [],
    certifications: p.certifications || [],
    languages: p.languages || ['Urdu', 'English'],
    completedJobs: p.completedBookings || 0,
    jobSuccessRate:
      p.totalBookings > 0
        ? Math.round((p.completedBookings / p.totalBookings) * 100)
        : 100,
    coordinates: coords(p.currentLocation),
    createdAt: p.createdAt ? p.createdAt.toISOString() : new Date().toISOString(),
    updatedAt: p.updatedAt ? p.updatedAt.toISOString() : new Date().toISOString(),
    ...extras,
  };
}

// → models/serviceProviders/booking.ts BookingProvider
function toBookingProvider(p) {
  const card = toProviderCard(p);
  return {
    id: card.id,
    name: card.name,
    image: card.image,
    service: card.specialty || card.category,
    specialty: card.specialty,
    rating: card.rating,
    reviews: card.reviews,
    experience: card.experience,
    verified: card.verified,
    isOnline: card.isOnline,
    responseTime: card.responseTime,
    basePrice: card.price,
    category: card.category,
  };
}

// → userNetwork.ts UserBooking (customer bookings tab)
function toUserBooking(b) {
  const p = b.provider || {};
  const scheduled = b.scheduledFor ? new Date(b.scheduledFor) : new Date();
  const base = toBookingStatus(b.status);
  // The bookings tab has an extra 'upcoming' filter bucket for accepted
  // future bookings.
  const status =
    b.status === 'ACCEPTED' && scheduled > new Date() ? 'upcoming' : base;
  return {
    id: String(b._id),
    serviceId: b.serviceCategory,
    serviceName: b.serviceSubCategory || b.serviceCategory,
    serviceImage: '',
    categoryType: b.serviceCategory,
    providerId: String(p._id || b.provider),
    providerName: p.fullName || '',
    providerAvatar: avatar(p.fullName, p.profilePhoto),
    status,
    date: scheduled.toISOString().slice(0, 10),
    time: b.scheduledTime || '',
    address: [b.address && b.address.line1, b.address && b.address.city]
      .filter(Boolean)
      .join(', '),
    price: (b.pricing && (b.pricing.finalPrice || b.pricing.estimatedPrice)) || 0,
    rating: b.reviewRating,
    review: b.reviewComment,
    createdAt: b.createdAt ? b.createdAt.toISOString() : '',
    updatedAt: b.updatedAt ? b.updatedAt.toISOString() : '',
  };
}

// → booking.ts SavedAddress
function toSavedAddress(a) {
  return {
    id: String(a._id),
    label: a.label || 'Home',
    address: [a.line1 || a.address, a.city].filter(Boolean).join(', '),
    icon: a.icon || 'location',
    isDefault: !!a.isDefault,
    coordinates: coords(a.coordinates),
  };
}

// → job.ts Job (provider job list)
function toJob(b, now = new Date()) {
  const c = b.customer || {};
  const scheduled = b.scheduledFor ? new Date(b.scheduledFor) : now;
  return {
    id: String(b._id),
    title: b.serviceSubCategory || b.serviceCategory,
    category: b.serviceCategory,
    serviceType: b.serviceSubCategory || b.serviceCategory,
    customer: c.fullName || '',
    customerAvatar: avatar(c.fullName, c.profilePhoto),
    customerPhone: c.phoneNumber || '',
    location: (b.address && b.address.line1) || '',
    city: (b.address && b.address.city) || '',
    date: scheduled.toISOString().slice(0, 10),
    time: b.scheduledTime || '',
    price: (b.pricing && (b.pricing.finalPrice || b.pricing.estimatedPrice)) || 0,
    status: toJobBucket(b.status, b.scheduledFor, now),
    coordinates: coords(b.address && b.address.coordinates),
    specialInstructions: b.instructions || b.description || '',
  };
}

// → dashboard.ts DashboardJob
function toDashboardJob(b) {
  const j = toJob(b);
  return {
    id: j.id,
    title: j.title,
    category: j.category,
    customer: j.customer,
    customerAvatar: j.customerAvatar,
    location: j.location,
    date: j.date,
    time: j.time,
    price: j.price,
    status: toDashboardStatus(b.status),
    phone: j.customerPhone,
  };
}

module.exports = {
  SUBTYPE_TO_CATEGORY,
  CATEGORY_TO_SUBTYPE,
  avatar,
  coords,
  toProviderCard,
  toBookingProvider,
  toUserBooking,
  toSavedAddress,
  toJob,
  toDashboardJob,
  toConfirmationStatus,
};
