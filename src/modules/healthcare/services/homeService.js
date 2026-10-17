const Doctor = require('../models/Doctor');
const Clinic = require('../models/Clinic');
const Specialty = require('../models/Specialty');
const Appointment = require('../models/Appointment');
const HealthcareBanner = require('../models/HealthcareBanner');
const doctorService = require('./doctorService');
const specialtyService = require('./specialtyService');
const { PATIENT_POPULATE, computeModifyFlags } = require('./appointmentService');
const { inferSlotInstants } = require('./appointmentTime');

// ============================================================================
// The patient's Health home in one payload: the city's top doctors, who is
// free today, the specialties and the concerns patients name, staff banners,
// and (signed in) the patient's next visit. Every list keeps the shape its own
// endpoint already returns (/doctors, /specialties, /appointments), so the app
// reads it with the serializers it already has.
// ============================================================================

const DEFAULT_CITY = 'Lahore';
const MINUTE = 60 * 1000;
/** A visit stays "next" for half an hour after it ends (a late-running clinic). */
const NEXT_VISIT_GRACE = 30 * MINUTE;
const RAIL_SIZE = 10;
const CONCERN_LIMIT = 12;

const EMERGENCY_NUMBERS = [
  { label: 'Rescue 1122', number: '1122' },
  { label: 'Edhi ambulance', number: '115' },
];

/** The city the home is about: asked for, else the patient's own, else Lahore. */
const resolveCity = (requested, patientCity) => {
  const asked = typeof requested === 'string' ? requested.trim().slice(0, 60) : '';
  if (asked) return asked;
  const own = typeof patientCity === 'string' ? patientCity.trim() : '';
  return own || DEFAULT_CITY;
};

/** Is a banner showing now, for a patient in `city`? */
const isLiveBanner = (banner, city, now) => {
  if (!banner || !banner.isActive) return false;
  if (banner.validFrom && new Date(banner.validFrom) > now) return false;
  if (banner.validUntil && new Date(banner.validUntil) <= now) return false;
  if (banner.city && banner.city.trim().toLowerCase() !== String(city).trim().toLowerCase()) return false;
  return true;
};

/**
 * A banner as the app reads it, or null when it leads nowhere that exists
 * any more (a removed specialty, an unlisted doctor, an unknown screen).
 * `names` maps the ids that still exist to their display names.
 */
const bannerView = (banner, names = { specialties: new Map(), doctors: new Map() }) => {
  let target = null;
  if (banner.targetType === 'specialty') {
    const name = banner.specialtyId && names.specialties.get(String(banner.specialtyId));
    if (!name) return null;
    target = { id: String(banner.specialtyId), name };
  } else if (banner.targetType === 'doctor') {
    const name = banner.doctorId && names.doctors.get(String(banner.doctorId));
    if (!name) return null;
    target = { id: String(banner.doctorId), name };
  } else if (banner.targetType === 'screen') {
    if (!HealthcareBanner.TARGET_SCREENS.includes(banner.targetScreen)) return null;
  }
  return {
    id: String(banner._id),
    title: banner.title,
    subtitle: banner.subtitle || '',
    image: banner.image,
    targetType: banner.targetType || 'none',
    targetScreen: banner.targetType === 'screen' ? banner.targetScreen : null,
    target,
  };
};

/**
 * The home's concern chips: specialties take turns, so the first row names a
 * concern from every specialty before any gets a second. A name appears once.
 */
const pickConcerns = (specialties, limit = CONCERN_LIMIT) => {
  const lists = (specialties || [])
    .filter((s) => s && s.isActive !== false && Array.isArray(s.commonConditions))
    .map((s) => ({ s, names: s.commonConditions.map((c) => String(c || '').trim()).filter(Boolean) }))
    .filter((l) => l.names.length);
  const out = [];
  const seen = new Set();
  const longest = Math.max(0, ...lists.map((l) => l.names.length));
  for (let round = 0; round < longest && out.length < limit; round += 1) {
    for (const { s, names } of lists) {
      if (out.length >= limit) break;
      const name = names[round];
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ name, specialtyId: String(s._id || s.id), specialtyName: s.name, icon: s.icon || '' });
    }
  }
  return out;
};

/** When a visit starts and ends: its own copied instants, else its slot's. */
const visitWindow = (appointment) => {
  if (appointment.startUtc) {
    const start = new Date(appointment.startUtc);
    const end = appointment.endUtc ? new Date(appointment.endUtc) : new Date(start.getTime() + 30 * MINUTE);
    return { start, end };
  }
  const { startUtc, endUtc } = inferSlotInstants(appointment.slotId, appointment.timezone);
  return startUtc ? { start: startUtc, end: endUtc } : null;
};

/** The patient's next pending or confirmed visit, soonest first. */
const nextVisit = async (patientId, now) => {
  const rows = await Appointment.find({ patientId, status: { $in: ['pending', 'confirmed'] } })
    .populate(PATIENT_POPULATE)
    .lean();
  const cutoff = now.getTime() - NEXT_VISIT_GRACE;
  const next = rows
    .map((a) => ({ a, w: visitWindow(a) }))
    .filter((x) => x.w && x.w.end.getTime() > cutoff)
    .sort((x, y) => x.w.start - y.w.start)[0];
  if (!next) return null;
  return { ...next.a, id: next.a._id, ...computeModifyFlags(next.a) };
};

const liveBanners = async (city, now) => {
  const rows = await HealthcareBanner.find({ isActive: true }).sort({ sortOrder: 1, createdAt: -1 }).limit(50).lean();
  const live = rows.filter((b) => isLiveBanner(b, city, now));
  const specialtyIds = live.filter((b) => b.targetType === 'specialty' && b.specialtyId).map((b) => b.specialtyId);
  const doctorIds = live.filter((b) => b.targetType === 'doctor' && b.doctorId).map((b) => b.doctorId);
  const [specialties, doctors] = await Promise.all([
    specialtyIds.length ? Specialty.find({ _id: { $in: specialtyIds }, isActive: true }).select('name').lean() : [],
    doctorIds.length
      ? Doctor.find({ _id: { $in: doctorIds }, verificationStatus: 'verified', isActive: true })
          .select('providerId')
          .populate('providerId', 'fullName')
          .lean()
      : [],
  ]);
  const names = {
    specialties: new Map(specialties.map((s) => [String(s._id), s.name])),
    doctors: new Map(doctors.map((d) => [String(d._id), d.providerId?.fullName || 'Doctor'])),
  };
  return live
    .map((b) => bannerView(b, names))
    .filter(Boolean)
    .slice(0, RAIL_SIZE);
};

/** Cities with at least one active clinic of a listed doctor. */
const activeCities = async () => {
  const listed = await Doctor.distinct('_id', { verificationStatus: 'verified', isActive: true });
  if (!listed.length) return [];
  const raw = await Clinic.distinct('city', { doctorId: { $in: listed }, isActive: true });
  const byKey = new Map();
  raw.forEach((c) => {
    const name = String(c || '').trim();
    if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  });
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
};

/**
 * @param {{ city?: string, patientId?: string|null, patientCity?: string|null, now?: Date }} args
 */
const getHome = async ({ city: requested, patientId = null, patientCity = null, now = new Date() } = {}) => {
  const city = resolveCity(requested, patientCity);
  const [specialtyResult, featured, today, banners, cities, upcoming] = await Promise.all([
    specialtyService.getSpecialties({}, { page: 1, limit: 50 }),
    doctorService.getDoctors({ city }, { sortBy: 'rating', limit: RAIL_SIZE }),
    // A bookable time left today on Pakistan's calendar — the same list the
    // doctor list's "Available today" filter opens.
    doctorService.getDoctors({ city, availability: 'today' }, { sortBy: 'rating', limit: RAIL_SIZE }),
    liveBanners(city, now),
    activeCities(),
    patientId ? nextVisit(patientId, now) : null,
  ]);
  const specialties = specialtyResult.specialties;
  return {
    city,
    cities,
    specialties,
    commonConcerns: pickConcerns(specialties),
    featuredDoctors: featured.doctors,
    availableToday: today.doctors,
    banners,
    upcoming,
    emergencyNumbers: EMERGENCY_NUMBERS,
  };
};

module.exports = {
  getHome,
  resolveCity,
  isLiveBanner,
  bannerView,
  pickConcerns,
  visitWindow,
  EMERGENCY_NUMBERS,
};
