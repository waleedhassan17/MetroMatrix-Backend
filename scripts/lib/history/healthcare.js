/**
 * Healthcare history for one doctor (Dr. Imran Qureshi, Cardiology).
 *
 * Mirrors the real flows (appointmentController, healthcare paymentService):
 *   wallet payment -> patient debit  healthcare_payment (relatedTo Appointment)
 *   completion     -> doctor credit  healthcare_earning + appointment.payout
 *                     (cash at clinic is marked paid at completion first)
 *   cancellation   -> patient credit refund when it had been paid
 * Past appointments end completed or cancelled — healthcare has no no-show
 * job, so a past "confirmed" would sit in the doctor's queue forever.
 *
 * Slots: an existing (template) slot at the chosen time is reused and marked
 * booked; otherwise a slot is created in the current format (Karachi-midnight
 * date, dateKey, startUtc/endUtc) — never colliding with the unique index
 * {doctorId, type, clinicId, startUtc}.
 */
const Slot = require('../../../src/modules/healthcare/models/Slot');
const Appointment = require('../../../src/modules/healthcare/models/Appointment');
const Prescription = require('../../../src/modules/healthcare/models/Prescription');
const Review = require('../../../src/modules/healthcare/models/Review');
const HealthRecord = require('../../../src/modules/healthcare/models/HealthRecord');
const HealthVital = require('../../../src/modules/healthcare/models/HealthVital');
const Doctor = require('../../../src/modules/healthcare/models/Doctor');
const { appointmentTimeFields } = require('../../../src/modules/healthcare/services/appointmentTime');
const { TZ, makeRng, pickRepeat, pkt, hhmm, addMin, eachDayKey, weekdayOf, dateKeyOf, oidAt, shortHex, HOUR, DAY } = require('./common');

const CASES = [
  {
    symptoms: 'Chest pain on exertion, settles with rest',
    diagnosis: 'Stable angina — rule out coronary artery disease',
    medications: [
      ['Aspirin', '75mg', 'Once daily', '30 days', 'After lunch'],
      ['Atorvastatin', '20mg', 'At night', '30 days', ''],
      ['Isosorbide mononitrate', '20mg', 'Twice daily', '30 days', ''],
    ],
    tests: ['Exercise tolerance test', 'Lipid profile'],
    advice: 'Avoid heavy exertion until the stress test. Go to emergency if chest pain lasts more than 15 minutes.',
  },
  {
    symptoms: 'High BP readings at home with morning headaches',
    diagnosis: 'Essential hypertension',
    medications: [['Amlodipine', '5mg', 'Once daily', '30 days', 'Morning']],
    tests: ['Serum creatinine', 'Urine routine examination'],
    advice: 'Keep salt under 5 g a day and record your BP every morning.',
  },
  {
    symptoms: 'Palpitations with occasional dizziness',
    diagnosis: 'Paroxysmal supraventricular tachycardia (suspected)',
    medications: [['Bisoprolol', '2.5mg', 'Once daily', '30 days', 'Morning']],
    tests: ['24-hour Holter monitoring', 'TSH'],
    advice: 'Avoid caffeine and energy drinks. Note the time and duration of each episode.',
  },
  {
    symptoms: 'Breathlessness on climbing stairs and swelling of both ankles',
    diagnosis: 'Heart failure with preserved ejection fraction',
    medications: [
      ['Furosemide', '20mg', 'Once daily', '14 days', 'Morning'],
      ['Spironolactone', '25mg', 'Once daily', '30 days', ''],
    ],
    tests: ['Echocardiogram', 'NT-proBNP'],
    advice: 'Check your weight every morning and limit fluids to 1.5 litres a day.',
  },
  {
    symptoms: 'Routine follow-up six months after angioplasty',
    diagnosis: 'Coronary artery disease, post-PCI — stable',
    medications: [
      ['Aspirin', '75mg', 'Once daily', '90 days', 'After lunch'],
      ['Clopidogrel', '75mg', 'Once daily', '90 days', ''],
      ['Rosuvastatin', '10mg', 'At night', '90 days', ''],
    ],
    tests: ['Lipid profile'],
    advice: 'Do not stop the blood thinners without speaking to your cardiologist.',
  },
  {
    symptoms: 'Raised cholesterol on a routine check-up',
    diagnosis: 'Dyslipidaemia',
    medications: [['Rosuvastatin', '10mg', 'At night', '90 days', '']],
    tests: ['Liver function tests'],
    advice: 'Low-fat diet and at least 150 minutes of brisk walking a week.',
  },
  {
    symptoms: 'Cardiac evaluation before planned knee surgery',
    diagnosis: 'Pre-operative cardiac assessment — fit for surgery',
    medications: [],
    tests: ['ECG'],
    advice: 'No cardiac reason to delay the planned procedure.',
  },
  {
    symptoms: 'Irregular heartbeat flagged by smartwatch',
    diagnosis: 'Atrial fibrillation — rate control and anticoagulation',
    medications: [
      ['Bisoprolol', '5mg', 'Once daily', '30 days', 'Morning'],
      ['Apixaban', '5mg', 'Twice daily', '30 days', 'Same times every day'],
    ],
    tests: ['Echocardiogram', 'Renal function tests'],
    advice: 'Take the blood thinner at the same times every day and report any unusual bleeding.',
  },
];

const PRIMARY_CASES = {
  initial: {
    symptoms: 'Palpitations and chest tightness after climbing stairs; home BP readings around 140/90',
    diagnosis: 'Stage 1 hypertension with sinus tachycardia',
    medications: [['Bisoprolol', '2.5mg', 'Once daily', '30 days', 'Morning, after breakfast']],
    tests: ['ECG', 'Lipid profile', 'CBC', 'TSH'],
    advice: 'Cut down on salt and caffeine, walk briskly for 30 minutes daily and log your BP every morning.',
    followUpDays: 21,
  },
  reports: {
    symptoms: 'Follow-up to review ECG and blood reports',
    diagnosis: 'Stage 1 hypertension — ECG sinus rhythm, LDL borderline (138 mg/dL), thyroid normal',
    medications: [['Bisoprolol', '2.5mg', 'Once daily', '30 days', 'Morning']],
    tests: ['Echocardiogram'],
    advice: 'Reports reviewed. Reduce fried food and repeat the lipid profile in three months.',
    followUpDays: 28,
  },
  echo: {
    symptoms: 'Follow-up with echocardiogram; palpitations much less frequent',
    diagnosis: 'Structurally normal heart on echo; BP improving (128/84)',
    medications: [['Bisoprolol', '2.5mg', 'Once daily', '30 days', 'Morning']],
    tests: [],
    advice: 'Echo is normal. Continue the medicine and the daily walks.',
    followUpDays: 28,
  },
  stable: {
    symptoms: 'Monthly follow-up — BP stable on the home log',
    diagnosis: 'Hypertension, well controlled',
    medications: [['Bisoprolol', '2.5mg', 'Once daily', '60 days', 'Morning']],
    tests: ['Lipid profile (repeat)'],
    advice: 'Continue the same dose. Repeat the lipid profile before the next visit.',
    followUpDays: 42,
  },
};

const PRIMARY_VISITS = [
  { day: '2026-08-22', time: '18:00', type: 'in-clinic', outcome: 'completed', pay: 'wallet', kase: 'initial', review: 5 },
  { day: '2026-09-12', time: '10:00', type: 'video', outcome: 'completed', pay: 'wallet', kase: 'reports', review: 5 },
  { day: '2026-10-03', time: '18:30', type: 'in-clinic', outcome: 'cancelled', pay: 'wallet', reason: 'Clash with a university exam' },
  { day: '2026-10-10', time: '18:30', type: 'in-clinic', outcome: 'completed', pay: 'cash_at_clinic', kase: 'echo', review: 4 },
  { day: '2026-11-07', time: '10:30', type: 'video', outcome: 'completed', pay: 'wallet', kase: 'stable', review: 5 },
];

const PRIMARY_RECORDS = [
  ['2026-08-22', '19:30', 'Resting ECG', 'lab_reports', 'Resting 12-lead ECG: sinus tachycardia at 102 bpm, no ST-T changes.'],
  ['2026-08-24', '12:10', 'Lipid profile', 'lab_reports', 'Total cholesterol 212, LDL 138, HDL 41, triglycerides 165 mg/dL.'],
  ['2026-08-24', '12:15', 'CBC and TSH', 'lab_reports', 'Complete blood count within normal limits. TSH 2.1 mIU/L.'],
  ['2026-10-10', '17:20', 'Echocardiogram', 'imaging', 'Normal LV size and function, EF 62%. No valvular disease.'],
];

const REVIEW_COMMENTS = {
  5: [
    'Dr. Qureshi explained everything patiently and never rushed the consultation.',
    'Very thorough — went through all my reports line by line.',
    'Excellent doctor. My BP is finally under control.',
    'On time and very professional. Highly recommended.',
  ],
  4: ['Good consultation, but the wait at the clinic was about 30 minutes.', 'Knowledgeable and clear. The video call dropped once.'],
  3: ['Treatment was fine but the appointment started late.'],
  2: ['Felt a little rushed during the visit.'],
};
const PATIENT_CANCEL_REASONS = [
  'Travelling out of Lahore',
  'Feeling better, will book later',
  'Clash with an office meeting',
  'Booked the wrong day by mistake',
];
const DOCTOR_CANCEL_REASON = 'Doctor unavailable — called in for an emergency procedure';

const toMedications = (rows) =>
  rows.map(([name, dosage, frequency, duration, instructions]) => ({ name, dosage, frequency, duration, instructions }));

function ageOf(user) {
  if (user.dateOfBirth) {
    const years = Math.floor((Date.now() - new Date(user.dateOfBirth).getTime()) / (365.25 * DAY));
    if (years > 0 && years < 110) return years;
  }
  return makeRng(`age:${user._id}`).int(24, 64);
}

class SlotBook {
  constructor(ctx, doctor, clinics, slots, busyStarts) {
    this.ctx = ctx;
    this.doctor = doctor;
    this.clinics = clinics;
    this.byKey = new Map();
    this.availableByDay = new Map();
    this.busy = new Set(busyStarts.map((d) => new Date(d).toISOString()));
    for (const s of slots) {
      if (!s.startUtc) continue;
      const iso = new Date(s.startUtc).toISOString();
      this.byKey.set(this.key(s.type, s.clinicId, iso), s);
      if (s.status === 'available') {
        const list = this.availableByDay.get(s.dateKey) || [];
        list.push(s);
        this.availableByDay.set(s.dateKey, list);
      } else {
        this.busy.add(iso);
      }
    }
  }

  key(type, clinicId, iso) {
    return `${type}|${clinicId ? String(clinicId) : ''}|${iso}`;
  }

  clinicFor(day) {
    // Mon/Wed/Fri at the first clinic, Tue/Thu/Sat at the second.
    const wd = weekdayOf(day);
    return this.clinics[wd % 2 === 1 || this.clinics.length < 2 ? 0 : 1];
  }

  /**
   * A free time on `day` that ends before `latest` (or starts after
   * `earliest` for upcoming ones). Prefers the doctor's real template slots.
   * Returns { existing } or { create }.
   */
  choose(rng, day, { latest = null, earliest = null, type = null, time = null } = {}) {
    const fits = (startUtc) => {
      const t = new Date(startUtc).getTime();
      if (latest && t > latest.getTime()) return false;
      if (earliest && t < earliest.getTime()) return false;
      return !this.busy.has(new Date(startUtc).toISOString());
    };

    const template = (this.availableByDay.get(day) || []).filter(
      (s) => fits(s.startUtc) && (!type || s.type === type) && (!time || s.startTime === time)
    );
    if (template.length) return { existing: rng.pick(template) };

    const wantType = type || (rng.chance(0.25) ? 'video' : 'in-clinic');
    const candidates = [];
    if (time) candidates.push(time);
    else if (wantType === 'video') for (let m = 9 * 60; m <= 11 * 60 + 30; m += 30) candidates.push(hhmm(m));
    else for (let m = 17 * 60; m <= 20 * 60 + 30; m += 30) candidates.push(hhmm(m));
    const clinic = wantType === 'video' ? null : this.clinicFor(day);
    const order = time ? candidates : candidates.sort(() => rng.next() - 0.5);
    for (const startTime of order) {
      for (let shift = 0; shift < 4; shift += 1) {
        const [h, m] = startTime.split(':').map(Number);
        const st = hhmm(h * 60 + m + shift * 30);
        const startUtc = pkt(day, st);
        if (!startUtc || !fits(startUtc)) continue;
        const iso = startUtc.toISOString();
        const clash = this.byKey.get(this.key(wantType, clinic && clinic._id, iso));
        if (clash) {
          if (clash.status === 'available') return { existing: clash };
          continue;
        }
        const [eh, em] = st.split(':').map(Number);
        const endTime = hhmm(eh * 60 + em + 30);
        return {
          create: {
            doctorId: this.doctor._id,
            clinicId: clinic ? clinic._id : null,
            date: pkt(day, '00:00'),
            startTime: st,
            endTime,
            startUtc,
            endUtc: pkt(day, endTime),
            clinicTimezone: TZ,
            dateKey: day,
            type: wantType,
            source: 'manual',
            maxPatients: 1,
          },
        };
      }
    }
    return null;
  }

  take(slot) {
    this.busy.add(new Date(slot.startUtc).toISOString());
    const list = this.availableByDay.get(slot.dateKey);
    if (list) this.availableByDay.set(slot.dateKey, list.filter((s) => String(s._id) !== String(slot._id)));
  }
}

async function seedAppointment(ctx, env, spec) {
  const { now } = ctx;
  const { doctor, doctorWallet, book } = env;
  const { key, patient, rng, choice, outcome, pay, kase, review, reason, cancelBy, bookedAt } = spec;
  if (ctx.has(`${key}:appt`)) {
    ctx.count('appointments', 'skipped');
    return null;
  }

  const active = ['pending', 'confirmed'].includes(outcome);
  let slot;
  if (choice.existing) {
    slot = choice.existing;
    if (outcome !== 'cancelled') {
      const ok = await ctx.bookExistingSlot(`${key}:slot`, slot._id);
      if (!ok) return null;
    }
  } else {
    const res = await ctx.put(Slot, `${key}:slot`, {
      ...choice.create,
      status: outcome === 'cancelled' ? 'available' : 'booked',
      bookedCount: outcome === 'cancelled' ? 0 : 1,
      createdAt: addMin(bookedAt, -2 * 1440),
      updatedAt: bookedAt,
    });
    slot = { ...choice.create, _id: res._id };
  }
  book.take(slot);

  const time = appointmentTimeFields(slot);
  const type = slot.type;
  const fee = type === 'video' ? doctor.videoConsultationFee || doctor.consultationFee || 2500 : doctor.consultationFee || 3000;
  const apptId = oidAt(bookedAt);

  const completedAt = outcome === 'completed' ? addMin(time.endUtc, rng.int(0, 25)) : null;
  const cancelAt =
    outcome === 'cancelled'
      ? new Date(Math.max(bookedAt.getTime() + HOUR, time.startUtc.getTime() - rng.int(3, 30) * HOUR))
      : null;

  // Payment
  let method = null;
  let paidAt = null;
  if (pay === 'wallet') {
    method = 'wallet';
    paidAt = addMin(bookedAt, rng.int(3, 40));
  } else if (pay === 'cash_at_clinic') {
    method = 'cash_at_clinic';
    paidAt = completedAt; // captured at completion
  }
  const paid = Boolean(paidAt) && paidAt <= now;
  const refunded = outcome === 'cancelled' && method === 'wallet';
  const payTxnId = method === 'wallet' ? oidAt(paidAt) : null;
  const earnTxnId = completedAt ? oidAt(completedAt) : null;

  const lastAt = completedAt || cancelAt || paidAt || bookedAt;
  const caseInfo = kase || null;
  await ctx.put(Appointment, `${key}:appt`, {
    _id: apptId,
    patientId: patient._id,
    doctorId: doctor._id,
    slotId: slot._id,
    clinicId: slot.clinicId || null,
    type,
    status: outcome,
    patientInfo: {
      name: patient.fullName,
      phone: patient.phoneNumber || '',
      age: ageOf(patient),
      gender: patient.gender || '',
      relationship: 'self',
    },
    symptoms: caseInfo ? caseInfo.symptoms : '',
    fee,
    discount: 0,
    totalAmount: fee,
    payment: {
      status: refunded ? 'refunded' : paid ? 'paid' : 'unpaid',
      method,
      amount: fee,
      walletTransactionId: payTxnId,
      paidAt: paid ? paidAt : null,
      refundedAt: refunded ? cancelAt : null,
      refundAmount: refunded ? fee : 0,
    },
    payout: completedAt
      ? { amount: fee, commission: 0, paidAt: completedAt, walletTransactionId: earnTxnId }
      : { amount: 0, commission: 0, paidAt: null, walletTransactionId: null },
    cancellationReason: outcome === 'cancelled' ? reason : '',
    cancelledBy: outcome === 'cancelled' ? cancelBy : '',
    completedAt,
    ...time,
    createdAt: bookedAt,
    updatedAt: lastAt > now ? now : lastAt,
  });

  const patientWallet = await ctx.wallet(patient._id, 'User', spec.walletLabel || patient.email);
  if (method === 'wallet' && paidAt <= now) {
    await ctx.customerDebit(`${key}:pay`, patientWallet, {
      _id: payTxnId,
      amount: fee,
      source: 'healthcare_payment',
      description: `Consultation fee for appointment ${apptId}`,
      relatedTo: { kind: 'Appointment', id: apptId },
      metadata: { appointmentId: String(apptId) },
      at: paidAt,
    });
  }
  if (completedAt) {
    await ctx.ledger(`${key}:earn`, doctorWallet, {
      _id: earnTxnId,
      type: 'credit',
      amount: fee,
      source: 'healthcare_earning',
      description: `Consultation earnings for appointment ${apptId}`,
      relatedTo: { kind: 'Appointment', id: apptId },
      transferGroupId: `payout_${shortHex(8)}`,
      metadata: { grossAmount: fee, commission: 0, commissionRate: 0 },
      at: completedAt,
    });
  }
  if (refunded) {
    await ctx.ledger(`${key}:refund`, patientWallet, {
      type: 'credit',
      amount: fee,
      source: 'refund',
      description: `Refund for cancelled appointment ${apptId}`,
      relatedTo: { kind: 'Appointment', id: apptId },
      at: cancelAt,
    });
  }

  if (completedAt && caseInfo) {
    await ctx.put(Prescription, `${key}:rx`, {
      appointmentId: apptId,
      doctorId: doctor._id,
      patientId: patient._id,
      diagnosis: caseInfo.diagnosis,
      symptoms: [caseInfo.symptoms],
      medications: toMedications(caseInfo.medications),
      tests: caseInfo.tests.map((name) => ({ name, instructions: '' })),
      advice: caseInfo.advice,
      followUpDate: caseInfo.followUpDays ? addMin(completedAt, caseInfo.followUpDays * 1440) : null,
      createdAt: completedAt,
    });
    if (review) {
      const reviewAt = addMin(completedAt, rng.int(2 * 60, 2 * 1440));
      if (reviewAt < now) {
        await ctx.put(Review, `${key}:review`, {
          appointmentId: apptId,
          doctorId: doctor._id,
          patientId: patient._id,
          rating: review,
          comment: rng.pick(REVIEW_COMMENTS[review] || REVIEW_COMMENTS[4]),
          createdAt: reviewAt,
        });
      }
    }
  }
  if (active) env.upcoming += 1;
  return { outcome, completedAt };
}

async function seedHealthcare(ctx, { primary, doctor, clinics, doctorProvider, patients, fromKey, toKey }) {
  const { now } = ctx;
  const windowStart = pkt(fromKey, '00:00');
  const horizon = new Date(now.getTime() + 16 * DAY);
  const [slots, appts] = await Promise.all([
    Slot.find({ doctorId: doctor._id, startUtc: { $gte: windowStart, $lte: horizon } }).lean(),
    Appointment.find({ doctorId: doctor._id, startUtc: { $gte: windowStart, $lte: horizon }, status: { $ne: 'cancelled' } })
      .select('startUtc')
      .lean(),
  ]);
  const book = new SlotBook(ctx, doctor, clinics, slots, appts.map((a) => a.startUtc));
  const env = {
    doctor,
    book,
    doctorWallet: await ctx.wallet(doctorProvider._id, 'Provider', 'Dr. Imran Qureshi (doctor)'),
    upcoming: 0,
  };
  const summary = { primary: 0, past: 0, upcoming: 0 };

  // 1. Ubaid's visits
  for (let i = 0; i < PRIMARY_VISITS.length; i += 1) {
    const v = PRIMARY_VISITS[i];
    const key = `hc:primary:${String(i + 1).padStart(2, '0')}`;
    const rng = makeRng(key);
    if (pkt(v.day, v.time) > now) continue;
    const choice =
      book.choose(rng, v.day, { type: v.type, time: v.time, latest: addMin(now, -90) }) ||
      book.choose(rng, v.day, { type: v.type, latest: addMin(now, -90) });
    if (!choice) {
      ctx.warn(`healthcare: no free slot for Ubaid's visit on ${v.day}`);
      continue;
    }
    const start = choice.existing ? new Date(choice.existing.startUtc) : choice.create.startUtc;
    const res = await seedAppointment(ctx, env, {
      key,
      patient: primary,
      rng,
      choice,
      outcome: v.outcome,
      pay: v.pay,
      kase: v.kase ? PRIMARY_CASES[v.kase] : null,
      review: v.review,
      reason: v.reason,
      cancelBy: 'patient',
      bookedAt: addMin(start, -rng.int(2 * 1440, 5 * 1440)),
      walletLabel: 'Ubaid (customer)',
    });
    if (res) summary.primary += 1;
  }

  // Ubaid's health records and weekly home BP/HR log
  for (let i = 0; i < PRIMARY_RECORDS.length; i += 1) {
    const [day, time, title, category, notes] = PRIMARY_RECORDS[i];
    const at = pkt(day, time);
    if (at > now) continue;
    await ctx.put(HealthRecord, `hc:primary:record:${i + 1}`, { userId: primary._id, title, category, date: at, notes, files: [], createdAt: at });
  }
  const vitalDays = eachDayKey('2026-08-20', toKey).filter((_, idx) => idx % 7 === 0);
  for (let i = 0; i < vitalDays.length; i += 1) {
    const rng = makeRng(`hc:primary:vital:${i}`);
    const progress = vitalDays.length > 1 ? i / (vitalDays.length - 1) : 1;
    const measuredAt = pkt(vitalDays[i], hhmm(8 * 60 + rng.int(0, 50)));
    if (measuredAt > now) continue;
    const systolic = Math.round(142 - 20 * progress + rng.int(-3, 3));
    const diastolic = Math.round(92 - 13 * progress + rng.int(-2, 2));
    const pulse = Math.round(98 - 24 * progress + rng.int(-3, 3));
    await ctx.put(HealthVital, `hc:primary:vital:${i}:bp`, {
      patientId: primary._id,
      type: 'blood_pressure',
      bloodPressure: { systolic, diastolic, meanArterial: Math.round(diastolic + (systolic - diastolic) / 3), pulse },
      source: { kind: 'manual' },
      measuredAt,
      createdAt: addMin(measuredAt, 2),
    });
    await ctx.put(HealthVital, `hc:primary:vital:${i}:hr`, {
      patientId: primary._id,
      type: 'heart_rate',
      heartRate: { bpm: pulse + rng.int(-2, 2) },
      source: { kind: 'manual' },
      measuredAt: addMin(measuredAt, 3),
      createdAt: addMin(measuredAt, 5),
    });
  }

  // 2. The practice: past appointments across the window (Sundays off)
  const days = eachDayKey(fromKey, toKey);
  for (let d = 0; d < days.length; d += 1) {
    const day = days[d];
    if (weekdayOf(day) === 7) continue;
    const progress = days.length > 1 ? d / (days.length - 1) : 1;
    const dayRng = makeRng(`hc:day:${day}`);
    const count = Math.floor(0.6 + 0.5 * progress + dayRng.next());
    for (let i = 0; i < count; i += 1) {
      const key = `hc:a:${day}:${i}`;
      const rng = makeRng(key);
      const choice = book.choose(rng, day, { latest: addMin(now, -90) });
      if (!choice) continue;
      const start = choice.existing ? new Date(choice.existing.startUtc) : choice.create.startUtc;
      const outcome = rng.weighted([['completed', 85], ['cancelled-patient', 10], ['cancelled-doctor', 5]]);
      const isCancelled = outcome !== 'completed';
      const pay = outcome === 'cancelled-doctor' ? 'wallet' : outcome === 'cancelled-patient' ? (rng.chance(0.5) ? 'wallet' : null) : rng.chance(0.65) ? 'wallet' : 'cash_at_clinic';
      const res = await seedAppointment(ctx, env, {
        key,
        patient: pickRepeat(rng, patients),
        rng,
        choice,
        outcome: isCancelled ? 'cancelled' : 'completed',
        pay,
        kase: rng.pick(CASES),
        review: !isCancelled && rng.chance(0.6) ? rng.weighted([[5, 55], [4, 30], [3, 10], [2, 5]]) : null,
        reason: outcome === 'cancelled-doctor' ? DOCTOR_CANCEL_REASON : rng.pick(PATIENT_CANCEL_REASONS),
        cancelBy: outcome === 'cancelled-doctor' ? 'doctor' : 'patient',
        bookedAt: addMin(start, -rng.int(20 * 60, 6 * 1440)),
      });
      if (res) summary.past += 1;
    }
  }

  // 3. Upcoming: the doctor's real open slots over the next two weeks
  const hasUpcoming = await Appointment.exists({
    patientId: primary._id,
    doctorId: doctor._id,
    status: { $in: ['pending', 'confirmed'] },
    startUtc: { $gt: now },
  });
  const upcomingPlan = [];
  for (let n = 0; n < 8; n += 1) upcomingPlan.push({ key: `hc:up:${n}`, patient: null });
  if (!hasUpcoming) upcomingPlan.push({ key: 'hc:primary:upcoming', patient: primary, dayOffset: 10 });
  for (let n = 0; n < upcomingPlan.length; n += 1) {
    const plan = upcomingPlan[n];
    const rng = makeRng(plan.key);
    const offset = plan.dayOffset || 1 + Math.floor((n * 13) / upcomingPlan.length) + rng.int(0, 1);
    let choice = null;
    for (let tries = 0; tries < 5 && !choice; tries += 1) {
      const day = dateKeyOf(new Date(now.getTime() + (offset + tries) * DAY));
      const found = book.choose(rng, day, { earliest: addMin(now, 180) });
      if (found && found.existing) choice = found; // upcoming only uses real open slots
    }
    if (!choice) continue;
    const patient = plan.patient || pickRepeat(rng, patients);
    const outcome = plan.patient ? 'confirmed' : rng.chance(0.7) ? 'confirmed' : 'pending';
    const pay = rng.weighted([['wallet', 60], [choice.existing.type === 'video' ? null : 'cash_at_clinic', 25], [null, 15]]);
    const res = await seedAppointment(ctx, env, {
      key: plan.key,
      patient,
      rng,
      choice,
      outcome,
      pay: plan.patient ? 'wallet' : pay,
      kase: plan.patient ? { symptoms: 'Follow-up — repeat lipid profile and BP review' } : { symptoms: rng.pick(CASES).symptoms },
      review: null,
      bookedAt: addMin(now, -rng.int(2 * 60, 3 * 1440)),
      walletLabel: plan.patient ? 'Ubaid (customer)' : undefined,
    });
    if (res) summary.upcoming += 1;
  }

  // Doctor rating from every review the doctor has.
  if (!ctx.dryRun) await recomputeDoctorRating(doctor._id);
  return summary;
}

async function recomputeDoctorRating(doctorId) {
  const [agg] = await Review.aggregate([
    { $match: { doctorId } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  await Doctor.collection.updateOne(
    { _id: doctorId },
    { $set: { rating: agg ? Math.round(agg.avg * 10) / 10 : 0, totalReviews: agg ? agg.count : 0 } }
  );
}

module.exports = { seedHealthcare, recomputeDoctorRating };
