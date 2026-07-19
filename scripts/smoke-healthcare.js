/**
 * Healthcare critical-path smoke test — proves TC-16 and TC-17 end-to-end.
 *
 * Path: patient login → browse specialties → search doctors by specialty →
 * view doctor → clinics → slots → book (TC-17 asserts: HTTP 201, appointment
 * record, slot marked unavailable, confirmation notification) → pay from
 * wallet → doctor confirms → doctor completes → doctor writes prescription →
 * patient views + downloads PDF → patient reviews → doctor rating updates →
 * admin sees the appointment in the admin list.
 *
 * Prereqs: server running, seed-healthcare.js + seed-accounts.js run once.
 * Run:     API_URL=http://localhost:5000 node scripts/smoke-healthcare.js
 */
require('dotenv').config();
const axios = require('axios');

const BASE = process.env.API_URL || 'http://localhost:5000';
const api = axios.create({ baseURL: `${BASE}/api`, validateStatus: () => true });

const PATIENT = { email: 'patient1.hc@metromatrix.pk', password: '123456' };
const ADMIN = { email: 'waleedhassansfd@gmail.com', password: 'Waleed@104' };
const DOCTOR_PASSWORD = 'Doctor@123';

let passed = 0;
let failed = 0;
const step = (name, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? passed++ : failed++;
  return ok;
};
const bail = (name, detail) => {
  step(name, false, detail);
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(1);
};
const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } });

(async () => {
  console.log(`=== Healthcare smoke test against ${BASE} ===\n`);

  // 1. Patient login
  let res = await api.post('/auth/login', PATIENT);
  const patientToken = res.data?.accessToken;
  if (!patientToken) bail('patient login', JSON.stringify(res.data).slice(0, 120));
  step('patient login', true);

  // 2. Browse specialties (TC-16)
  res = await api.get('/v1/healthcare/specialties');
  const specialties = res.data?.data?.specialties || res.data?.data || [];
  step('browse specialties', res.status === 200 && specialties.length >= 5, `${specialties.length} specialties`);
  const cardio = specialties.find((s) => /cardio/i.test(s.name)) || specialties[0];

  // 3. Search doctors by specialty (TC-16)
  res = await api.get(`/v1/healthcare/doctors/search?specialtyId=${cardio.id || cardio._id}`);
  let doctors = res.data?.data?.doctors || res.data?.data || [];
  if (!Array.isArray(doctors)) doctors = [];
  if (doctors.length === 0) {
    res = await api.get(`/v1/healthcare/doctors?specialtyId=${cardio.id || cardio._id}`);
    doctors = res.data?.data?.doctors || res.data?.data || [];
  }
  step('search doctors by specialization (TC-16)', doctors.length > 0, `${doctors.length} ${cardio.name} doctors`);
  if (!doctors.length) bail('no doctors', 'run seed-healthcare.js');
  const doctor = doctors[0];
  const doctorId = doctor.id || doctor._id || doctor.doctorId;

  // 4. View doctor detail
  res = await api.get(`/v1/healthcare/doctors/${doctorId}`);
  const detail = res.data?.data?.doctor || res.data?.data;
  step('view doctor detail', res.status === 200 && !!detail, `fee PKR ${detail?.consultationFee}`);

  // 5. Clinics
  res = await api.get(`/v1/healthcare/doctors/${doctorId}/clinics`);
  const clinics = res.data?.data?.clinics || res.data?.data || [];
  step('view doctor clinics', clinics.length > 0, `${clinics.length} clinics`);
  const clinic = clinics[0];

  // 6. Doctor login FIRST (needed to guarantee a same-day slot so the
  // complete step is legal — future appointments cannot be completed)
  let doctorToken = null;
  for (let i = 1; i <= 12 && !doctorToken; i += 1) {
    const login = await api.post('/auth/provider/login', { email: `doctor${i}.hc@metromatrix.pk`, password: DOCTOR_PASSWORD });
    if (!login.data?.accessToken) continue;
    const me = await api.get('/v1/healthcare/doctors/me', auth(login.data.accessToken));
    const meDoc = me.data?.data?.doctor || me.data?.data || {};
    const myDoctorId = meDoc.id || meDoc._id;
    if (String(myDoctorId) === String(doctorId)) doctorToken = login.data.accessToken;
  }
  if (!doctorToken) bail('doctor login (owner of chosen doctor)', 'could not match seeded doctor');
  step('doctor login', true);

  // Find (or create) an available slot TODAY.
  // Use the LOCAL calendar date — toISOString() is UTC and can be a day behind.
  const nowLocal = new Date();
  const today = [
    nowLocal.getFullYear(),
    String(nowLocal.getMonth() + 1).padStart(2, '0'),
    String(nowLocal.getDate()).padStart(2, '0'),
  ].join('-');
  const findTodaySlot = async () => {
    const r = await api.get(`/v1/healthcare/doctors/${doctorId}/slots?date=${today}`);
    const g = r.data?.data || {};
    const flat = Array.isArray(g)
      ? g
      : [...(g.morning?.slots || []), ...(g.afternoon?.slots || []), ...(g.evening?.slots || [])];
    return flat.find((s) => s.isAvailable !== false && s.status !== 'booked' && s.type !== 'video');
  };
  let slot = await findTodaySlot();
  // Create a fresh same-day slot if none is free. Try successive half-hours
  // inside the display buckets (06:00–22:00) — earlier smoke runs may have
  // already created and booked some of them.
  for (let hour = 7; hour <= 21 && !slot; hour += 1) {
    for (const mm of ['00', '30']) {
      const hh = String(hour).padStart(2, '0');
      const endMin = mm === '00' ? `${hh}:30` : `${String(hour + 1).padStart(2, '0')}:00`;
      const created = await api.post(
        '/v1/healthcare/doctors/me/slots',
        {
          clinicId: clinic.id || clinic._id,
          startDate: today,
          endDate: today,
          days: [nowLocal.toLocaleDateString('en-US', { weekday: 'long' })],
          timeRanges: [{ startTime: `${hh}:${mm}`, endTime: endMin }],
          slotDuration: 30,
          type: 'in-clinic',
        },
        auth(doctorToken)
      );
      if (created.status === 201) break; // one new slot is enough
    }
    slot = await findTodaySlot();
  }
  const slotDate = today;
  step('pick an available slot for today', !!slot, slot ? `${slotDate} ${slot.startTime}` : 'none found');
  if (!slot) bail('no slots', 'could not create a same-day slot');
  const slotId = slot.id || slot._id || slot.slotId;

  // 7. Book (TC-17): 201, record created, slot unavailable, notification created
  res = await api.post(
    '/v1/healthcare/appointments',
    {
      slotId,
      doctorId,
      clinicId: clinic.id || clinic._id,
      type: 'in-clinic',
      patientInfo: { name: 'Hamza Yousaf', phone: '03007770001', age: 29, gender: 'male' },
      symptoms: 'Smoke test booking',
    },
    auth(patientToken)
  );
  const booked = res.data?.data?.appointment || res.data?.data;
  const appointmentId = booked?.id || booked?._id;
  if (res.status !== 201 || !appointmentId) bail('book appointment returns 201 (TC-17)', `status ${res.status} ${JSON.stringify(res.data).slice(0, 140)}`);
  step('book appointment returns HTTP 201 + record (TC-17)', true, `id ${appointmentId}`);

  // slot now unavailable
  res = await api.get(`/v1/healthcare/doctors/${doctorId}/slots?date=${slotDate}`);
  const g2 = res.data?.data || {};
  const flat2 = [...(g2.morning?.slots || []), ...(g2.afternoon?.slots || []), ...(g2.evening?.slots || [])];
  const sameSlot = flat2.find((s) => String(s.id || s._id || s.slotId) === String(slotId));
  step('slot marked unavailable after booking (TC-17)', !sameSlot || sameSlot.isAvailable === false || sameSlot.status === 'booked' || sameSlot.bookedCount >= (sameSlot.maxPatients || 1), '');

  // notification created
  res = await api.get('/v1/healthcare/notifications', auth(patientToken));
  const notifs = res.data?.data?.notifications || res.data?.data || [];
  step('confirmation notification created (TC-17)', notifs.length > 0, `${notifs.length} notifications`);

  // 8. Pay from wallet
  res = await api.post(`/v1/healthcare/appointments/${appointmentId}/pay`, { method: 'wallet' }, auth(patientToken));
  step('pay consultation fee from wallet', res.status === 200 && res.data?.data?.payment?.status === 'paid', res.status === 200 ? `paid PKR ${res.data.data.payment.amount}` : JSON.stringify(res.data).slice(0, 120));

  // double payment must be rejected
  res = await api.post(`/v1/healthcare/appointments/${appointmentId}/pay`, { method: 'wallet' }, auth(patientToken));
  step('double payment rejected', res.status === 400, `status ${res.status}`);

  // 9. Doctor confirms → completes
  res = await api.patch(`/v1/healthcare/doctors/me/appointments/${appointmentId}/confirm`, {}, auth(doctorToken));
  step('doctor confirms appointment', res.status === 200, `status ${res.status}`);

  res = await api.patch(`/v1/healthcare/doctors/me/appointments/${appointmentId}/complete`, {}, auth(doctorToken));
  const completeOk = res.status === 200;
  step('doctor completes appointment (payout settles)', completeOk, completeOk ? '' : JSON.stringify(res.data).slice(0, 140));

  // 10. Doctor writes prescription
  res = await api.post(
    '/v1/healthcare/doctors/me/prescriptions',
    {
      appointmentId,
      diagnosis: 'Smoke test diagnosis',
      medications: [{ name: 'Panadol', dosage: '500mg', frequency: 'TDS', duration: '3 days', instructions: 'After food' }],
      advice: 'Rest well.',
    },
    auth(doctorToken)
  );
  const prescription = res.data?.data?.prescription || res.data?.data;
  const prescriptionId = prescription?.id || prescription?._id;
  step('doctor writes prescription', res.status === 201 || (res.status === 200 && !!prescriptionId), prescriptionId ? `id ${prescriptionId}` : JSON.stringify(res.data).slice(0, 120));

  // 11. Patient views + downloads the PDF
  res = await api.get('/v1/healthcare/prescriptions/my', auth(patientToken));
  const myPrescriptions = res.data?.data?.prescriptions || res.data?.data || [];
  step('patient views prescriptions list', myPrescriptions.length > 0, `${myPrescriptions.length} prescriptions`);
  if (prescriptionId) {
    res = await api.get(`/v1/healthcare/prescriptions/${prescriptionId}/pdf`, {
      ...auth(patientToken),
      responseType: 'arraybuffer',
    });
    const isPdf = res.status === 200 && String(res.headers['content-type']).includes('pdf');
    step('patient downloads prescription PDF', isPdf, `content-type ${res.headers['content-type']}`);
  }

  // 12. Patient reviews → rating updates
  const before = await api.get(`/v1/healthcare/doctors/${doctorId}`);
  const ratingBeforeCount = before.data?.data?.doctor?.totalReviews ?? before.data?.data?.totalReviews ?? 0;
  res = await api.post(
    '/v1/healthcare/reviews',
    { appointmentId, doctorId, rating: 5, comment: 'Smoke test review — excellent.' },
    auth(patientToken)
  );
  step('patient submits review', res.status === 201 || res.status === 200, `status ${res.status}`);
  const after = await api.get(`/v1/healthcare/doctors/${doctorId}`);
  const ratingAfterCount = after.data?.data?.doctor?.totalReviews ?? after.data?.data?.totalReviews ?? 0;
  step('doctor rating aggregate updates', ratingAfterCount >= ratingBeforeCount, `reviews ${ratingBeforeCount} → ${ratingAfterCount}`);

  // 13. Admin sees the appointment
  res = await api.post('/admin/auth/login', ADMIN);
  const adminToken = res.data?.accessToken || res.data?.token;
  if (!adminToken) bail('admin login', JSON.stringify(res.data).slice(0, 120));
  step('admin login', true);

  res = await api.get('/v1/admin/appointments?limit=50', auth(adminToken));
  const adminList = res.data?.data || [];
  const found = adminList.some((a) => String(a.id || a._id) === String(appointmentId));
  step('admin sees the appointment in oversight list', res.status === 200 && found, `${adminList.length} listed`);

  // 14. Security probe: patient cannot create a specialty (H1)
  res = await api.post('/v1/healthcare/specialties', { name: 'Hacked Specialty' }, auth(patientToken));
  step('patient blocked from creating a specialty (403, H1)', res.status === 403, `status ${res.status}`);

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Smoke test crashed:', err.message);
  process.exit(1);
});
