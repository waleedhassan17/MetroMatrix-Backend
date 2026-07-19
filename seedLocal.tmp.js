// Local dev seed: creates loginable doctor/patient/admin + specialties, clinic, future slots.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./src/config/db');
const Provider = require('./src/models/Provider');
const User = require('./src/models/User');
const Admin = require('./src/models/Admin');
const Specialty = require('./src/modules/healthcare/models/Specialty');
const Doctor = require('./src/modules/healthcare/models/Doctor');
const Clinic = require('./src/modules/healthcare/models/Clinic');
const Slot = require('./src/modules/healthcare/models/Slot');

const PASS = 'Test@1234';

(async () => {
  await connectDB();
  await new Promise((r) => setTimeout(r, 1500));

  // Clean slate
  await Promise.all([
    Provider.deleteMany({ email: /@mmlocal\.dev$/ }),
    User.deleteMany({ email: /@mmlocal\.dev$/ }),
    Admin.deleteMany({ email: /@mmlocal\.dev$/ }),
  ]);

  // Specialties
  const specNames = [
    { name: 'Cardiology', icon: 'heart' },
    { name: 'General Medicine', icon: 'medkit' },
    { name: 'Dermatology', icon: 'body' },
  ];
  const specialties = [];
  for (const s of specNames) {
    let sp = await Specialty.findOne({ name: s.name });
    if (!sp) sp = await Specialty.create({ ...s, isActive: true });
    specialties.push(sp);
  }
  const cardiology = specialties[0];

  // Doctor (Provider + Doctor profile), login-ready
  const provider = await Provider.create({
    email: 'doctor@mmlocal.dev',
    password: PASS,
    fullName: 'Dr. Sarah Ahmed',
    phoneNumber: '03001112222',
    providerType: 'doctor',
    specialty: String(cardiology._id),
    city: 'Lahore',
    isActive: true,
    emailVerified: 'active',
    adminVerified: 'active',
    verificationStatus: 'approved',
  });
  const doctor = await Doctor.create({
    providerId: provider._id,
    specialtyId: cardiology._id,
    pmcNumber: 'PMC-LOCAL-001',
    qualifications: ['MBBS', 'FCPS (Cardiology)'],
    experience: 12,
    about: 'Consultant Cardiologist with 12 years of experience.',
    consultationFee: 2000,
    videoConsultationFee: 1500,
    rating: 4.7,
    totalReviews: 0,
    verificationStatus: 'verified',
    isActive: true,
    isAvailable: true,
  });
  const clinic = await Clinic.create({
    doctorId: doctor._id,
    name: 'Heart Care Clinic',
    address: '12 Jail Road',
    city: 'Lahore',
    area: 'Gulberg',
    phone: '042-111-2222',
  });

  // Future slots: next 4 days, 3 slots/day (in-clinic + one video)
  const times = [
    { startTime: '10:00', endTime: '10:30', type: 'in-clinic' },
    { startTime: '11:00', endTime: '11:30', type: 'in-clinic' },
    { startTime: '17:00', endTime: '17:30', type: 'video' },
  ];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  let slotCount = 0;
  for (let d = 1; d <= 4; d++) {
    const date = new Date(base);
    date.setDate(date.getDate() + d);
    for (const t of times) {
      await Slot.create({
        doctorId: doctor._id,
        clinicId: t.type === 'in-clinic' ? clinic._id : null,
        date,
        startTime: t.startTime,
        endTime: t.endTime,
        type: t.type,
        status: 'available',
        maxPatients: 1,
      });
      slotCount++;
    }
  }

  // Patient
  const patient = await User.create({
    email: 'patient@mmlocal.dev',
    password: PASS,
    fullName: 'Ali Raza',
    phoneNumber: '03003334444',
    isActive: true,
    isVerified: true,
    emailVerified: true,
  });

  // Admin
  const admin = await Admin.create({
    email: 'admin@mmlocal.dev',
    password: PASS,
    fullName: 'Platform Admin',
    role: 'super_admin',
    isActive: true,
  });

  console.log('\n========== LOCAL SEED COMPLETE ==========');
  console.log(`Specialties: ${specialties.length}, Slots: ${slotCount}`);
  console.log('\n--- LOGIN CREDENTIALS (password for all: ' + PASS + ') ---');
  console.log('DOCTOR  (provider login): doctor@mmlocal.dev');
  console.log('PATIENT (user login)    : patient@mmlocal.dev');
  console.log('ADMIN   (admin login)   : admin@mmlocal.dev');
  console.log('\nDoctor: Dr. Sarah Ahmed | Cardiology | fee 2000 | ' + slotCount + ' future slots');
  console.log('=========================================\n');

  await mongoose.connection.close();
  process.exit(0);
})().catch((e) => {
  console.error('SEED ERROR:', e.message);
  process.exit(1);
});
