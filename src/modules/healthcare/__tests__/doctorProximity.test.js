const mongoose = require('mongoose');
const { restrictIds, parsePatientPoint } = require('../services/doctorService');

const id = () => new mongoose.Types.ObjectId();

describe('doctor list helpers', () => {
  it('restrictIds intersects successive id filters', () => {
    const [a, b, c] = [id(), id(), id()];
    const q = {};
    restrictIds(q, [a, b]);
    restrictIds(q, [b, c]);
    expect(q._id.$in.map(String)).toEqual([String(b)]);
  });

  it('parsePatientPoint accepts a real position only', () => {
    expect(parsePatientPoint('31.5', '74.3')).toEqual({ lat: 31.5, lng: 74.3 });
    expect(parsePatientPoint('0', '0')).toBeNull();
    expect(parsePatientPoint(undefined, '74')).toBeNull();
    expect(parsePatientPoint('abc', '74')).toBeNull();
    expect(parsePatientPoint('95', '74')).toBeNull();
  });
});

// Real aggregation — only against a throwaway database (see discovery.integration.test.js).
const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('doctor proximity against MongoDB', () => {
  const { getDoctors } = require('../services/doctorService');
  // populate() needs these registered, as the running app always has them.
  require('../../../models/Provider');
  require('../models/Specialty');
  const PATIENT = { lat: 31.52, lng: 74.35 };
  const near = (km) => [PATIENT.lng, PATIENT.lat + km * 0.009];
  let db;

  async function seed(name, { km, rating = 4.5, specialty, active = true, clinicActive = true, unplaced = false }) {
    const providerId = id();
    const doctorId = id();
    await db.collection('providers').insertOne({ _id: providerId, fullName: name, providerType: 'doctor', email: `${providerId}@test.local`, phoneNumber: String(providerId) });
    await db.collection('doctors').insertOne({
      _id: doctorId,
      providerId,
      specialtyId: specialty,
      verificationStatus: 'verified',
      isActive: active,
      rating,
      totalReviews: 10,
      consultationFee: 2000,
    });
    await db.collection('clinics').insertOne({
      doctorId,
      name: `${name} Clinic`,
      city: 'Lahore',
      area: 'Gulberg',
      isActive: clinicActive,
      location: { type: 'Point', coordinates: unplaced ? [0, 0] : near(km) },
    });
    return doctorId;
  }

  beforeAll(async () => {
    await mongoose.connect(URI.replace(/\/[^/]*$/, '/mm_doctor_test'));
    db = mongoose.connection.db;
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    for (const c of ['providers', 'doctors', 'clinics', 'specialties', 'slots']) await db.collection(c).deleteMany({});
    await db.collection('clinics').createIndex({ location: '2dsphere' });
  });

  it('nearest first, with distance and the nearest clinic attached', async () => {
    const cardio = id();
    await db.collection('specialties').insertOne({ _id: cardio, name: 'Cardiology', isActive: true });
    await seed('Far', { km: 9, specialty: cardio, rating: 5 });
    await seed('Near', { km: 2, specialty: cardio, rating: 3 });
    await seed('Nowhere', { km: 0, specialty: cardio, unplaced: true });
    const res = await getDoctors({ lat: PATIENT.lat, lng: PATIENT.lng }, { sortBy: 'distance', page: 1, limit: 10 });
    expect(res.doctors.map((x) => x.providerId.fullName)).toEqual(['Near', 'Far']);
    expect(res.doctors[0].distanceKm).toBeCloseTo(2, 0);
    expect(res.doctors[0].nearestClinic.name).toBe('Near Clinic');
    expect(res.pagination.total).toBe(2); // the [0,0] clinic cannot be placed
  });

  it('without "nearest", distance is attached but nobody is dropped', async () => {
    const s = id();
    await seed('A', { km: 3, specialty: s });
    await seed('Unplaced', { km: 0, specialty: s, unplaced: true });
    const res = await getDoctors({ lat: PATIENT.lat, lng: PATIENT.lng }, { sortBy: 'rating', page: 1, limit: 10 });
    expect(res.pagination.total).toBe(2);
    const byName = Object.fromEntries(res.doctors.map((x) => [x.providerId.fullName, x.distanceKm]));
    expect(byName.A).toBeCloseTo(3, 0);
    expect(byName.Unplaced).toBeNull();
  });

  it('search matches the practitioner noun to the specialty, and minRating filters', async () => {
    const neuro = id();
    const derm = id();
    await db.collection('specialties').insertMany([
      { _id: neuro, name: 'Neurology', isActive: true },
      { _id: derm, name: 'Dermatology', isActive: true },
    ]);
    await seed('Neuro High', { km: 1, specialty: neuro, rating: 4.8 });
    await seed('Neuro Low', { km: 1, specialty: neuro, rating: 3.1 });
    await seed('Skin', { km: 1, specialty: derm, rating: 4.9 });
    const res = await getDoctors({ search: 'Neurologist', minRating: 4 }, { page: 1, limit: 10 });
    expect(res.doctors.map((x) => x.providerId.fullName)).toEqual(['Neuro High']);
  });

  it('a city filter with regex syntax does not crash', async () => {
    await seed('A', { km: 1, specialty: id() });
    await expect(getDoctors({ city: '(Lahore' }, { page: 1, limit: 10 })).resolves.toBeDefined();
  });
});
