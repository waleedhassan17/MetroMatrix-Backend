/**
 * Healthcare module seed — realistic demo dataset. IDEMPOTENT: every entity
 * is upserted by a stable natural key (email, specialty name, clinic name,
 * seeded appointment marker), so running twice never duplicates.
 *
 * Creates:
 *   - 8 specialties
 *   - 12 approved doctors (each an approved Provider providerType 'doctor')
 *   - 2 clinics per doctor at real Lahore coordinates with timings
 *   - 4 weeks of slots per doctor (2/day at their first clinic)
 *   - 5 patients (healthcare demo patients, wallet-funded)
 *   - 20 appointments covering EVERY status (pending/confirmed/completed/cancelled)
 *     incl. paid, unpaid, refunded and rescheduled examples
 *   - prescriptions on completed appointments, health records, reviews
 *   - a full clinic day TODAY for doctor 1 (3 completed + 3 upcoming) so the
 *     doctor dashboard, patient queue and earnings are not empty on sign-in
 *
 * Run: node scripts/seed-healthcare.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const User = require('../src/models/User');
const Provider = require('../src/models/Provider');
const WalletService = require('../src/services/walletService');

const Specialty = require('../src/modules/healthcare/models/Specialty');
const Doctor = require('../src/modules/healthcare/models/Doctor');
const Clinic = require('../src/modules/healthcare/models/Clinic');
const Slot = require('../src/modules/healthcare/models/Slot');
const Appointment = require('../src/modules/healthcare/models/Appointment');
const Prescription = require('../src/modules/healthcare/models/Prescription');
const Review = require('../src/modules/healthcare/models/Review');
const HealthRecord = require('../src/modules/healthcare/models/HealthRecord');

const log = (m) => console.log(`  ${m}`);
const DAY = 86400000;

const SPECIALTIES = [
  ['Cardiology', 'heart'],
  ['Dermatology', 'body'],
  ['Neurology', 'brain'],
  ['Gastroenterology', 'stomach'],
  ['Orthopedics', 'bone'],
  ['Pediatrics', 'child'],
  ['Gynecology', 'female'],
  ['General Physician', 'stethoscope'],
];

const DOCTORS = [
  ['Dr. Imran Qureshi', 'Cardiology', 3000, 2500],
  ['Dr. Sana Javed', 'Cardiology', 3500, 3000],
  ['Dr. Hira Baig', 'Dermatology', 2500, 2000],
  ['Dr. Adeel Akhtar', 'Dermatology', 2000, 1800],
  ['Dr. Nadia Hussain', 'Neurology', 4000, 3500],
  ['Dr. Faisal Rehman', 'Gastroenterology', 3000, 2600],
  ['Dr. Ayesha Siddiqui', 'Orthopedics', 2800, 2400],
  ['Dr. Kamran Ali', 'Orthopedics', 2600, 2200],
  ['Dr. Mahnoor Khan', 'Pediatrics', 2000, 1700],
  ['Dr. Rabia Anwar', 'Gynecology', 3200, 2800],
  ['Dr. Usman Sheikh', 'General Physician', 1500, 1200],
  ['Dr. Zainab Tariq', 'General Physician', 1200, 1000],
];

const LAHORE = [
  ['Gulberg III', 'M.M. Alam Road, Gulberg III', 31.509, 74.3444],
  ['DHA Phase 3', 'Y-Block Commercial, DHA Phase 3', 31.4795, 74.3936],
  ['Johar Town', 'Khayaban-e-Firdousi, Johar Town', 31.4676, 74.2665],
  ['Model Town', 'Bank Square Market, Model Town', 31.4833, 74.3231],
];

const PATIENTS = [
  ['patient1.hc@metromatrix.pk', 'Hamza Yousaf', '03007770001'],
  ['patient2.hc@metromatrix.pk', 'Mariam Aslam', '03007770002'],
  ['patient3.hc@metromatrix.pk', 'Tariq Mehmood', '03007770003'],
  ['patient4.hc@metromatrix.pk', 'Kiran Shafiq', '03007770004'],
  ['patient5.hc@metromatrix.pk', 'Danish Iqbal', '03007770005'],
];

// 20 appointments covering every status; SEED-HC-nn marker via symptoms field
const APPOINTMENT_PLAN = [
  ...Array.from({ length: 8 }, (_, i) => ({ n: i + 1, status: 'completed', paid: true, review: i < 6 })),
  { n: 9, status: 'completed', paid: true, cash: true },
  { n: 10, status: 'completed', paid: true },
  { n: 11, status: 'confirmed', paid: true },
  { n: 12, status: 'confirmed', paid: true },
  { n: 13, status: 'confirmed', paid: false },
  { n: 14, status: 'pending', paid: false },
  { n: 15, status: 'pending', paid: false },
  { n: 16, status: 'pending', paid: true },
  { n: 17, status: 'cancelled', paid: true, refunded: true },
  { n: 18, status: 'cancelled', paid: false },
  { n: 19, status: 'cancelled', paid: false, byDoctor: true },
  { n: 20, status: 'confirmed', paid: true, rescheduled: true },
];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected\n=== Healthcare seed ===');

  // 1. Specialties
  const specByName = {};
  for (const [name, icon] of SPECIALTIES) {
    let spec = await Specialty.findOne({ name });
    if (!spec) spec = await Specialty.create({ name, icon, description: `${name} care` });
    specByName[name] = spec;
  }
  log(`specialties ready: ${SPECIALTIES.length}`);

  // 2. Doctors (Provider + Doctor profile), clinics, slots
  const doctors = [];
  for (let i = 0; i < DOCTORS.length; i += 1) {
    const [fullName, specName, fee, videoFee] = DOCTORS[i];
    const email = `doctor${i + 1}.hc@metromatrix.pk`;

    let provider = await Provider.findOne({ email });
    if (!provider) {
      provider = await Provider.create({
        email,
        password: 'Doctor@123',
        fullName,
        phoneNumber: `030088800${String(i + 1).padStart(2, '0')}`,
        providerType: 'doctor',
        specialty: specName,
        emailVerified: 'active',
        adminVerified: 'active',
        isActive: true,
      });
    }

    let doctor = await Doctor.findOne({ providerId: provider._id });
    if (!doctor) {
      doctor = await Doctor.create({
        providerId: provider._id,
        specialtyId: specByName[specName]._id,
        pmcNumber: `PMC-${10000 + i}`,
        qualifications: ['MBBS', i % 2 ? 'FCPS' : 'MD'],
        experience: 4 + (i % 10),
        about: `${fullName} is a ${specName} specialist practising in Lahore.`,
        consultationFee: fee,
        videoConsultationFee: videoFee,
        verificationStatus: 'verified',
        isActive: true,
      });
    } else if (doctor.verificationStatus !== 'verified') {
      doctor.verificationStatus = 'verified';
      doctor.isActive = true;
      await doctor.save();
    }

    // 2 clinics per doctor
    const clinics = [];
    for (let c = 0; c < 2; c += 1) {
      const spot = LAHORE[(i + c) % LAHORE.length];
      const name = `${fullName.replace('Dr. ', '')} Clinic ${spot[0]}`;
      let clinic = await Clinic.findOne({ doctorId: doctor._id, name });
      if (!clinic) {
        clinic = await Clinic.create({
          doctorId: doctor._id,
          name,
          address: spot[1],
          city: 'Lahore',
          area: spot[0],
          phone: '+92-42-35761234',
          latitude: spot[2],
          longitude: spot[3],
          isActive: true,
        });
      }
      clinics.push(clinic);
    }

    // 4 weeks of slots (2/day, weekdays, first clinic)
    const existingSlots = await Slot.countDocuments({ doctorId: doctor._id, date: { $gte: new Date() } });
    if (existingSlots < 10) {
      const slots = [];
      for (let d = 1; d <= 28; d += 1) {
        const date = new Date(Date.now() + d * DAY);
        if ([0, 6].includes(date.getDay())) continue; // weekdays only
        for (const [startTime, endTime] of [['18:00', '18:30'], ['18:30', '19:00']]) {
          slots.push({
            doctorId: doctor._id,
            clinicId: clinics[0]._id,
            date: new Date(date.toISOString().slice(0, 10)),
            startTime,
            endTime,
            type: startTime === '18:00' ? 'in-clinic' : 'video',
            status: 'available',
            maxPatients: 1,
            bookedCount: 0,
          });
        }
      }
      await Slot.insertMany(slots);
    }

    doctors.push({ doctor, clinics, fee });
  }
  log(`doctors ready: ${doctors.length} (each with 2 clinics + 4 weeks of slots)`);

  // 3. Patients with wallet balances
  const patients = [];
  for (const [email, fullName, phoneNumber] of PATIENTS) {
    let user = await User.findOne({ email }).select('+password');
    if (!user) {
      user = new User({ email, fullName, phoneNumber, isActive: true, isEmailVerified: true });
      user.password = '123456';
      await user.save();
    }
    const wallet = await WalletService.getOrCreateWallet(user._id, 'User');
    if (wallet.balance < 20000) {
      const amount = 50000 - wallet.balance;
      await wallet.credit(amount);
      await WalletService.recordTransaction(wallet._id, {
        type: 'credit',
        amount,
        description: 'Seed top-up for healthcare demo',
        source: 'admin_adjustment',
        status: 'completed',
      });
    }
    patients.push(user);
  }
  log(`patients ready: ${patients.length} (123456, wallet-funded)`);

  // 4. Appointments covering every status
  let created = 0;
  for (const plan of APPOINTMENT_PLAN) {
    const marker = `SEED-HC-${String(plan.n).padStart(2, '0')}`;
    if (await Appointment.findOne({ symptoms: new RegExp(`^${marker}`) })) continue;

    const { doctor, clinics, fee } = doctors[plan.n % doctors.length];
    const patient = patients[plan.n % patients.length];
    const isPast = ['completed', 'cancelled'].includes(plan.status);
    const dayOffset = isPast ? -(plan.n % 10) - 2 : (plan.n % 10) + 2;
    const date = new Date(Date.now() + dayOffset * DAY);

    const slot = await Slot.create({
      doctorId: doctor._id,
      clinicId: clinics[0]._id,
      date: new Date(date.toISOString().slice(0, 10)),
      startTime: '17:00',
      endTime: '17:30',
      type: plan.n % 4 === 0 ? 'video' : 'in-clinic',
      status: plan.status === 'cancelled' ? 'available' : 'booked',
      maxPatients: 1,
      bookedCount: plan.status === 'cancelled' ? 0 : 1,
    });

    const paid = !!plan.paid;
    const refunded = !!plan.refunded;
    const appointment = await Appointment.create({
      patientId: patient._id,
      doctorId: doctor._id,
      slotId: slot._id,
      clinicId: clinics[0]._id,
      type: plan.n % 4 === 0 ? 'video' : 'in-clinic',
      status: plan.status,
      patientInfo: { name: patient.fullName, phone: '03007770000', age: 25 + plan.n, gender: plan.n % 2 ? 'male' : 'female' },
      symptoms: `${marker}: seeded demo appointment`,
      fee,
      discount: 0,
      totalAmount: fee,
      payment: {
        status: refunded ? 'refunded' : paid ? 'paid' : 'unpaid',
        method: paid ? (plan.cash ? 'cash_at_clinic' : 'wallet') : null,
        amount: fee,
        paidAt: paid ? new Date(date.getTime() - DAY) : null,
        refundedAt: refunded ? new Date() : null,
        refundAmount: refunded ? fee : 0,
      },
      cancellationReason: plan.status === 'cancelled' ? (plan.byDoctor ? 'Doctor unavailable' : 'Patient request') : '',
      cancelledBy: plan.status === 'cancelled' ? (plan.byDoctor ? 'doctor' : 'patient') : '',
      completedAt: plan.status === 'completed' ? date : null,
      createdAt: new Date(date.getTime() - 3 * DAY),
    });
    created += 1;

    // Prescription + review + health record on completed ones
    if (plan.status === 'completed') {
      await Prescription.create({
        appointmentId: appointment._id,
        doctorId: doctor._id,
        patientId: patient._id,
        diagnosis: 'Seasonal viral infection (demo)',
        medications: [
          { name: 'Panadol Extra', dosage: '500mg', frequency: 'TDS', duration: '5 days', instructions: 'After meals' },
          { name: 'Cough syrup', dosage: '10ml', frequency: 'BD', duration: '5 days', instructions: '' },
        ],
        advice: 'Rest, hydrate well, and return if symptoms persist beyond a week.',
      });

      if (plan.review) {
        const rating = 3 + (plan.n % 3); // 3..5 spread
        await Review.create({
          appointmentId: appointment._id,
          patientId: patient._id,
          doctorId: doctor._id,
          rating,
          comment: rating >= 4 ? 'Very thorough and on time. Recommended.' : 'Average experience, long wait at the clinic.',
        });
        const [agg] = await Review.aggregate([
          { $match: { doctorId: doctor._id } },
          { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
        ]);
        await Doctor.updateOne(
          { _id: doctor._id },
          { $set: { rating: Math.round((agg.avg || 0) * 10) / 10, totalReviews: agg.count || 0 } }
        );
      }
    }
  }
  log(`appointments created: ${created} (skipped ${APPOINTMENT_PLAN.length - created} already present)`);


  // 4b. TODAY's clinic day for the demo doctor.
  //
  // Every appointment above is deliberately 2-11 days in the past or future,
  // so a doctor signing in saw 0 TOTAL / 0 SEEN / 0 PENDING on the dashboard,
  // "0 waiting · 0 completed" in the patient queue, and PKR 0 earnings — the
  // doctor view looked broken when it was simply showing an empty day. This
  // gives doctor 1 a realistic day: three consultations already done and three
  // still to come.
  //
  // Idempotent PER DAY: the marker carries the date, so re-running tomorrow
  // seeds tomorrow without duplicating today.
  const demo = doctors[0];
  const todayKey = new Date().toISOString().slice(0, 10);
  const TODAY_PLAN = [
    { n: 1, time: ['09:00', '09:30'], status: 'completed' },
    { n: 2, time: ['10:00', '10:30'], status: 'completed' },
    { n: 3, time: ['11:00', '11:30'], status: 'completed' },
    { n: 4, time: ['15:00', '15:30'], status: 'confirmed' },
    { n: 5, time: ['16:00', '16:30'], status: 'confirmed' },
    { n: 6, time: ['17:00', '17:30'], status: 'confirmed', video: true },
  ];

  let todayCreated = 0;
  for (const plan of TODAY_PLAN) {
    const marker = `SEED-HC-TODAY-${todayKey}-${plan.n}`;
    if (await Appointment.findOne({ symptoms: new RegExp(`^${marker}`) })) continue;

    const patient = patients[plan.n % patients.length];
    const isDone = plan.status === 'completed';
    const type = plan.video ? 'video' : 'in-clinic';

    const slot = await Slot.create({
      doctorId: demo.doctor._id,
      clinicId: demo.clinics[0]._id,
      date: new Date(todayKey),
      startTime: plan.time[0],
      endTime: plan.time[1],
      type,
      status: 'booked',
      maxPatients: 1,
      bookedCount: 1,
    });

    const appointment = await Appointment.create({
      patientId: patient._id,
      doctorId: demo.doctor._id,
      slotId: slot._id,
      clinicId: demo.clinics[0]._id,
      type,
      status: plan.status,
      // Real age/gender: the app only renders the demographics line when the
      // backend actually supplies them.
      patientInfo: {
        name: patient.fullName,
        phone: '03007770000',
        age: 24 + plan.n * 3,
        gender: plan.n % 2 ? 'male' : 'female',
      },
      symptoms: `${marker}: ${isDone ? 'Follow-up review' : 'General consultation'}`,
      fee: demo.fee,
      discount: 0,
      totalAmount: demo.fee,
      payment: {
        status: 'paid',
        method: plan.n % 3 === 0 ? 'cash_at_clinic' : 'wallet',
        amount: demo.fee,
        paidAt: new Date(),
      },
      completedAt: isDone ? new Date() : null,
      createdAt: new Date(Date.now() - DAY),
    });

    if (isDone) {
      await Prescription.create({
        appointmentId: appointment._id,
        doctorId: demo.doctor._id,
        patientId: patient._id,
        diagnosis: 'Hypertension follow-up (demo)',
        medications: [
          { name: 'Amlodipine', dosage: '5mg', frequency: 'OD', duration: '30 days', instructions: 'Morning, after breakfast' },
        ],
        advice: 'Monitor blood pressure daily and reduce salt intake.',
      });
    }
    todayCreated += 1;
  }
  log(`today's appointments for ${DOCTORS[0][0]}: ${todayCreated} created (${TODAY_PLAN.length - todayCreated} already present)`);

  // 5. A couple of health records per patient
  for (const patient of patients.slice(0, 3)) {
    const exists = await HealthRecord.findOne({ userId: patient._id, title: 'Seed CBC report' });
    if (!exists) {
      await HealthRecord.create({
        userId: patient._id,
        title: 'Seed CBC report',
        category: 'lab_reports',
        notes: 'Complete blood count — demo record',
        files: ['https://picsum.photos/seed/cbc/600/800'],
      });
    }
  }

  console.log('=== Done ===');
  console.log('Logins:');
  console.log('  doctors: doctor1..12.hc@metromatrix.pk / Doctor@123');
  console.log('  patients: patient1..5.hc@metromatrix.pk / 123456');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Healthcare seed failed:', err);
  process.exit(1);
});
