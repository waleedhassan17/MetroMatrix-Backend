const mongoose = require('mongoose');
const { resolveCity, isLiveBanner, bannerView, pickConcerns, visitWindow } = require('../services/homeService');
const { normaliseBanner } = require('../../../controllers/adminHealthcareBannerController');

const id = () => new mongoose.Types.ObjectId();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

describe('Health home helpers', () => {
  it('resolveCity: asked for, else the patient’s own, else Lahore', () => {
    expect(resolveCity(' Karachi ', 'Multan')).toBe('Karachi');
    expect(resolveCity('', 'Multan')).toBe('Multan');
    expect(resolveCity(undefined, null)).toBe('Lahore');
    expect(resolveCity(['x'], '')).toBe('Lahore');
  });

  it('isLiveBanner: active, inside its window, for this city or every city', () => {
    const now = new Date('2026-10-17T10:00:00Z');
    const b = (o) => ({ isActive: true, validFrom: null, validUntil: null, city: null, ...o });
    expect(isLiveBanner(b(), 'Lahore', now)).toBe(true);
    expect(isLiveBanner(b({ isActive: false }), 'Lahore', now)).toBe(false);
    expect(isLiveBanner(b({ validFrom: new Date(now.getTime() + HOUR) }), 'Lahore', now)).toBe(false);
    expect(isLiveBanner(b({ validUntil: now }), 'Lahore', now)).toBe(false);
    expect(isLiveBanner(b({ city: 'lahore ' }), 'Lahore', now)).toBe(true);
    expect(isLiveBanner(b({ city: 'Karachi' }), 'Lahore', now)).toBe(false);
  });

  it('bannerView drops a banner whose target is gone, and names the rest', () => {
    const spec = id();
    const names = { specialties: new Map([[String(spec), 'Dermatology']]), doctors: new Map() };
    const base = { _id: id(), title: 'T', subtitle: '', image: 'https://x/y.jpg' };
    expect(bannerView({ ...base, targetType: 'specialty', specialtyId: spec }, names).target).toEqual({ id: String(spec), name: 'Dermatology' });
    expect(bannerView({ ...base, targetType: 'specialty', specialtyId: id() }, names)).toBeNull();
    expect(bannerView({ ...base, targetType: 'doctor', doctorId: id() }, names)).toBeNull();
    expect(bannerView({ ...base, targetType: 'screen', targetScreen: 'nope' }, names)).toBeNull();
    const screen = bannerView({ ...base, targetType: 'screen', targetScreen: 'records' }, names);
    expect(screen).toMatchObject({ targetType: 'screen', targetScreen: 'records', target: null });
    expect(bannerView({ ...base, targetType: 'none', targetScreen: 'records' }, names).targetScreen).toBeNull();
  });

  it('pickConcerns: specialties take turns, each name once, inactive ones skipped', () => {
    const s = (name, list, isActive = true) => ({ _id: id(), name, icon: name[0], isActive, commonConditions: list });
    const out = pickConcerns([s('Skin', ['Acne', 'Eczema', ' ']), s('Heart', ['Chest pain', 'acne']), s('Old', ['Gout'], false)]);
    expect(out.map((c) => c.name)).toEqual(['Acne', 'Chest pain', 'Eczema']);
    expect(out[1]).toMatchObject({ specialtyName: 'Heart', icon: 'H' });
    expect(pickConcerns([s('A', ['1', '2', '3'])], 2).map((c) => c.name)).toEqual(['1', '2']);
    expect(pickConcerns(undefined)).toEqual([]);
  });

  it('visitWindow: the copied instants, else the slot’s, else nothing', () => {
    const start = new Date('2026-10-20T05:00:00Z');
    expect(visitWindow({ startUtc: start, endUtc: null }).end.getTime()).toBe(start.getTime() + 30 * 60 * 1000);
    const legacy = visitWindow({ slotId: { date: new Date('2026-10-20T00:00:00Z'), startTime: '10:00', endTime: '10:30' }, timezone: 'Asia/Karachi' });
    expect(legacy.start.toISOString()).toBe('2026-10-20T05:00:00.000Z');
    expect(visitWindow({ slotId: null })).toBeNull();
  });

  it('normaliseBanner: an https image and a target that matches its type', () => {
    const ok = { title: 'Video', image: 'https://images.example/v.jpg', targetType: 'screen', targetScreen: 'video_consultation' };
    expect(normaliseBanner(ok)).toMatchObject({ targetScreen: 'video_consultation', specialtyId: null, isActive: true });
    expect(() => normaliseBanner({ ...ok, image: 'http://x/y.jpg' })).toThrow(/https/);
    expect(() => normaliseBanner({ ...ok, title: ' ' })).toThrow(/title/);
    expect(() => normaliseBanner({ ...ok, targetScreen: 'wallet' })).toThrow(/targetScreen/);
    expect(() => normaliseBanner({ ...ok, targetType: 'specialty' })).toThrow(/specialtyId/);
    expect(() => normaliseBanner({ ...ok, validFrom: '2026-10-10', validUntil: '2026-10-01' })).toThrow(/after/);
    // An update keeps what it does not change, and can switch a banner off.
    const current = normaliseBanner(ok);
    expect(normaliseBanner({ isActive: false }, current)).toMatchObject({ title: 'Video', isActive: false, targetScreen: 'video_consultation' });
  });
});

// Real queries and routes — only against the throwaway database jest starts.
const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('GET /api/v1/healthcare/home and the banner admin API', () => {
  const { connect, disconnect } = require('../../../../test/helpers/db');
  const { createAdmin, createUser } = require('../../../../test/helpers/factories');
  const { api, signIn } = require('../../../../test/helpers/agent');
  const { generateAccessToken } = require('../../../utils/generateToken');
  const { toDateKey } = require('../../../utils/time');
  const HealthcareBanner = require('../models/HealthcareBanner');

  const now = new Date();
  const ids = {};
  let db;
  let patient;

  beforeAll(async () => {
    await connect();
    db = mongoose.connection.db;

    ids.skin = id();
    ids.heart = id();
    await db.collection('specialties').insertMany([
      { _id: ids.skin, name: 'Dermatology', icon: 'body', isActive: true, commonConditions: ['Acne', 'Eczema'] },
      { _id: ids.heart, name: 'Cardiology', icon: 'heart', isActive: true, commonConditions: ['Chest pain'] },
      { _id: id(), name: 'Retired', icon: '', isActive: false, commonConditions: ['Gout'] },
    ]);

    // Lahore: lhrTop (4.9), lhrFree (4.2, free today), lhrHidden (unverified). Karachi: khi (5.0).
    const doctor = async (key, { city, rating, verified = true, specialty = ids.skin }) => {
      const providerId = id();
      ids[key] = id();
      await db.collection('providers').insertOne({ _id: providerId, fullName: `Dr ${key}`, providerType: 'doctor', email: `${key}@test.local`, phoneNumber: String(providerId) });
      await db.collection('doctors').insertOne({
        _id: ids[key],
        providerId,
        specialtyId: specialty,
        verificationStatus: verified ? 'verified' : 'pending',
        isActive: true,
        rating,
        totalReviews: 3,
        consultationFee: 2000,
        videoConsultationFee: 1500,
      });
      await db.collection('clinics').insertOne({ _id: id(), doctorId: ids[key], name: `${key} clinic`, city, isActive: true });
    };
    await doctor('lhrTop', { city: 'Lahore', rating: 4.9 });
    await doctor('lhrFree', { city: 'Lahore', rating: 4.2, specialty: ids.heart });
    await doctor('lhrHidden', { city: 'Lahore', rating: 5, verified: false });
    await doctor('khi', { city: 'Karachi', rating: 5 });

    const slot = (doctorId, startUtc, status = 'available') => ({
      _id: id(),
      doctorId,
      date: startUtc,
      startTime: '10:00',
      endTime: '10:30',
      type: 'in-clinic',
      status,
      startUtc,
      endUtc: new Date(startUtc.getTime() + 30 * 60 * 1000),
      dateKey: toDateKey(startUtc),
      clinicTimezone: 'Asia/Karachi',
    });
    // A time later today (Pakistan's calendar) for lhrFree; lhrTop only tomorrow.
    const laterToday = new Date(now.getTime() + 60 * 1000);
    const slots = [slot(ids.lhrTop, new Date(now.getTime() + DAY + HOUR))];
    if (toDateKey(laterToday) === toDateKey(now)) slots.push(slot(ids.lhrFree, laterToday));
    ids.freeToday = slots.length === 2;
    ids.slotSoon = id();
    ids.slotLater = id();
    slots.push({ ...slot(ids.khi, new Date(now.getTime() + DAY), 'booked'), _id: ids.slotSoon });
    slots.push({ ...slot(ids.khi, new Date(now.getTime() + 3 * DAY), 'booked'), _id: ids.slotLater });
    await db.collection('slots').insertMany(slots);

    patient = await createUser({ address: { city: 'Karachi' } });
    const appt = (slotId, startUtc, status, createdAt) => ({
      _id: id(),
      patientId: patient._id,
      doctorId: ids.khi,
      slotId,
      type: 'in-clinic',
      status,
      startUtc,
      endUtc: new Date(startUtc.getTime() + 30 * 60 * 1000),
      payment: { status: 'unpaid' },
      createdAt,
    });
    ids.apptSoon = id();
    await db.collection('appointments').insertMany([
      // Booked last but happens first: "next" is by visit time, not booking time.
      { ...appt(ids.slotSoon, new Date(now.getTime() + DAY), 'confirmed', new Date(now.getTime() - HOUR)), _id: ids.apptSoon },
      appt(ids.slotLater, new Date(now.getTime() + 3 * DAY), 'pending', now),
      appt(ids.slotSoon, new Date(now.getTime() + HOUR), 'cancelled', now),
      appt(ids.slotSoon, new Date(now.getTime() - 2 * DAY), 'confirmed', now),
    ]);

    const banner = (title, o) => ({ title, image: 'https://images.example/b.jpg', isActive: true, targetType: 'screen', targetScreen: 'records', ...o });
    await HealthcareBanner.insertMany([
      banner('Everywhere', { sortOrder: 2 }),
      banner('Lahore skin', { sortOrder: 1, city: 'Lahore', targetType: 'specialty', targetScreen: null, specialtyId: ids.skin }),
      banner('Karachi only', { sortOrder: 3, city: 'Karachi' }),
      banner('Expired', { validUntil: new Date(now.getTime() - HOUR) }),
      banner('Not yet', { validFrom: new Date(now.getTime() + HOUR) }),
      banner('Off', { isActive: false }),
      banner('Dangling', { targetType: 'specialty', targetScreen: null, specialtyId: id() }),
    ]);
  });

  afterAll(disconnect);

  it('signed out: Lahore, its listed doctors best first, its banners, no visit', async () => {
    const res = await api().get('/api/v1/healthcare/home');
    expect(res.status).toBe(200);
    const h = res.body.data;
    expect(h.city).toBe('Lahore');
    expect(h.cities).toEqual(['Karachi', 'Lahore']);
    expect(h.featuredDoctors.map((x) => String(x._id))).toEqual([String(ids.lhrTop), String(ids.lhrFree)]);
    expect(h.featuredDoctors[0].providerId.fullName).toBe('Dr lhrTop');
    expect(h.availableToday.map((x) => String(x._id))).toEqual(ids.freeToday ? [String(ids.lhrFree)] : []);
    expect(h.banners.map((b) => b.title)).toEqual(['Lahore skin', 'Everywhere']);
    expect(h.banners[0].target).toEqual({ id: String(ids.skin), name: 'Dermatology' });
    expect(h.commonConcerns.map((c) => c.name)).toEqual(['Chest pain', 'Acne', 'Eczema']);
    expect(h.specialties.length).toBe(2);
    expect(h.upcoming).toBeNull();
    expect(h.emergencyNumbers[0].number).toBe('1122');
  });

  it('another city: its own doctors and banners', async () => {
    const h = (await api().get('/api/v1/healthcare/home?city=karachi')).body.data;
    expect(h.featuredDoctors.map((x) => String(x._id))).toEqual([String(ids.khi)]);
    expect(h.banners.map((b) => b.title)).toEqual(['Everywhere', 'Karachi only']);
  });

  it("a patient: their own city by default, and their soonest active visit", async () => {
    const token = generateAccessToken(patient._id, { userType: 'user' });
    const h = (await api().get('/api/v1/healthcare/home').set('Authorization', `Bearer ${token}`)).body.data;
    expect(h.city).toBe('Karachi');
    expect(String(h.upcoming._id)).toBe(String(ids.apptSoon));
    expect(h.upcoming.slotId.startTime).toBe('10:00');
    expect(h.upcoming.doctorId.providerId.fullName).toBe('Dr khi');
  });

  it('banner admin: healthcare staff create, edit and delete; others are refused', async () => {
    const staff = await signIn(await createAdmin({ permissions: { canManageHealthcare: true } }));
    const as = (r) => r.set('Authorization', staff.bearer());
    const body = { title: 'Heart week', image: 'https://images.example/h.jpg', targetType: 'specialty', specialtyId: String(ids.heart) };

    const made = await as(api().post('/api/v1/admin/healthcare/banners')).send(body);
    expect(made.status).toBe(201);
    const bannerId = made.body.data.id;

    const missing = await as(api().post('/api/v1/admin/healthcare/banners')).send({ ...body, specialtyId: String(id()) });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION_FAILED');

    const edited = await as(api().patch(`/api/v1/admin/healthcare/banners/${bannerId}`)).send({ isActive: false });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ isActive: false, title: 'Heart week' });

    const list = await as(api().get('/api/v1/admin/healthcare/banners'));
    expect(list.body.data.some((b) => b.id === bannerId)).toBe(true);

    expect((await as(api().delete(`/api/v1/admin/healthcare/banners/${bannerId}`))).status).toBe(200);
    expect((await as(api().delete(`/api/v1/admin/healthcare/banners/${bannerId}`))).status).toBe(404);

    const other = await signIn(await createAdmin({ permissions: { canManageShopping: true } }));
    const refused = await api().get('/api/v1/admin/healthcare/banners').set('Authorization', other.bearer());
    expect(refused.status).toBe(403);
    const token = generateAccessToken(patient._id, { userType: 'user' });
    expect((await api().get('/api/v1/admin/healthcare/banners').set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });
});
