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

const { pktDateString } = require('./time');
const { billOf } = require('./money');

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
    verified: p.adminVerified === 'active' || p.verificationStatus === 'approved',
    available: p.isAvailable !== false,
    isOnline: !!p.isOnline,
    responseTime: p.isOnline ? '~15 min' : '~1 hour',
    specialty: p.profession || p.specialty || '',
    bio: p.briefDescription || '',
    address: (p.serviceAreas && p.serviceAreas[0]) || p.city || '',
    city: p.city || '',
    // `null`, not a guess. This used to fall back to 'electricians', so any
    // provider whose subtype the mapping could not resolve was SERIALISED as an
    // electrician — the report that "everything shows electricians" was partly
    // this: the label was manufactured here, upstream of every screen, and no
    // amount of client-side care could have detected it.
    //
    // The client's categoryAccent() already degrades an unknown category to a
    // neutral accent, so null renders honestly instead of wrongly. Run
    // `npm run validate:homeservice` to find the providers that produce it.
    category: SUBTYPE_TO_CATEGORY[p.providerSubType] || null,
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

/**
 * The provider card as ANYONE may see it. /providers and /providers/:id are
 * public — no login — and used to hand every provider's email address and
 * phone number to whoever asked. A customer never needs either: calls and
 * messages go through the app, and the phone number is shared with a
 * customer only once they have a booking (service status, tracking).
 */
function toPublicProviderCard(p, extras = {}) {
  const card = toProviderCard(p, extras);
  delete card.email;
  delete card.phoneNumber;
  return card;
}

/** "Sarah Malik" → "Sarah M." — how a public review names its author. */
function publicName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Customer';
  const first = parts[0][0].toUpperCase() + parts[0].slice(1);
  if (parts.length === 1) return first;
  return `${first} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

// → models/serviceProviders/booking.ts BookingProvider
function toBookingProvider(p) {
  const card = toProviderCard(p);
  return {
    id: card.id,
    name: card.name,
    image: card.image,
    service: card.specialty || card.category || 'Home service',
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
  const status = toBookingStatus(b.status);
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
    date: pktDateString(scheduled),
    time: b.scheduledTime || '',
    address: [b.address && b.address.line1, b.address && b.address.city]
      .filter(Boolean)
      .join(', '),
    price: billOf(b),
    // The list needs to know a completed booking is still unpaid, so the
    // bookings tab can offer "Pay now" — otherwise a customer who left the
    // service screen before paying has no route back to payment. Only the
    // status is exposed; the amount is already in `price` above.
    payment: { status: (b.payment && b.payment.status) || 'unpaid' },
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
    date: pktDateString(scheduled),
    time: b.scheduledTime || '',
    price: billOf(b),
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
    // Where the job is. The dashboard opened jobs with a hardcoded city-centre
    // position because these were missing, so the job map and "Start
    // navigation" pointed at central Lahore instead of the customer.
    city: j.city,
    coordinates: j.coordinates,
    specialInstructions: j.specialInstructions,
    bucket: j.status,
  };
}

module.exports = {
  SUBTYPE_TO_CATEGORY,
  CATEGORY_TO_SUBTYPE,
  avatar,
  coords,
  toProviderCard,
  toPublicProviderCard,
  publicName,
  toBookingProvider,
  toUserBooking,
  toSavedAddress,
  toJob,
  toDashboardJob,
  toConfirmationStatus,
};
