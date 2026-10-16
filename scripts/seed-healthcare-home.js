/**
 * Health home content — `npm run seed:healthcare-home -- --confirm-db=<db name>`.
 *
 * ADDITIVE AND IDEMPOTENT, so it is safe on the live database:
 *  - Adds five home banners, each matched on its `seedKey`, only when missing:
 *    a seeded banner staff have since edited or switched off stays that way,
 *    and banners staff create in the admin API (no seedKey) are never touched.
 *  - Fills `commonConditions` on a specialty only where the list is EMPTY, so
 *    anything an admin has written stays as it is.
 *
 * Banner photos are Unsplash images (Unsplash License: free for commercial
 * use, no attribution required), each showing what its banner opens:
 *  video        Vitaly Gariev       photo-1758691463620-188ca7c1a04f
 *  skin         Anna Keibalo        photo-1688588162416-f7a7e726e0bf
 *  symptoms     Vitaly Gariev       photo-1758273241078-8eec353836be
 *  child        Ortopediatri        photo-1708687045004-a3e3c4420e6d
 *  records      CDC                 photo-1632053002928-1919605ee6f7
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { assertSafeSeedTarget } = require('./lib/seedSafety');
const Specialty = require('../src/modules/healthcare/models/Specialty');
const HealthcareBanner = require('../src/modules/healthcare/models/HealthcareBanner');

const log = (m) => console.log(`  ${m}`);
const photo = (id) => `https://images.unsplash.com/${id}?w=1200&q=70&auto=format&fit=crop`;

// Concerns patients name, by specialty (matched case-insensitively on the
// specialty's name, or a common variant of it).
const CONCERNS = [
  [['cardiology', 'cardiologist'], ['Chest pain', 'High blood pressure', 'Palpitations']],
  [['dermatology', 'dermatologist'], ['Acne', 'Hair fall', 'Eczema']],
  [['neurology', 'neurologist'], ['Migraine', 'Dizziness', 'Numbness']],
  [['gastroenterology', 'gastroenterologist'], ['Stomach pain', 'Acidity', 'Diarrhoea']],
  [['orthopedics', 'orthopaedics', 'orthopedic surgeon'], ['Back pain', 'Knee pain', 'Joint pain']],
  [['pediatrics', 'paediatrics', 'pediatrician'], ['Child fever', 'Vaccination', 'Child cough']],
  [['gynecology', 'gynaecology', 'gynecologist'], ['Pregnancy care', 'Irregular periods', 'PCOS']],
  [['general physician', 'general medicine', 'general practice', 'family medicine'], ['Fever', 'Cough and flu', 'Diabetes']],
];

const BANNERS = [
  {
    seedKey: 'home_video',
    title: 'See a doctor by video today',
    subtitle: 'Verified doctors, from home. You pay the doctor directly.',
    image: photo('photo-1758691463620-188ca7c1a04f'),
    targetType: 'screen',
    targetScreen: 'video_consultation',
    sortOrder: 1,
  },
  {
    seedKey: 'home_skin',
    title: 'Skin and hair specialists',
    subtitle: 'Acne, hair fall and eczema, seen by dermatologists near you.',
    image: photo('photo-1688588162416-f7a7e726e0bf'),
    targetType: 'specialty',
    specialty: ['dermatology', 'dermatologist'],
    sortOrder: 2,
  },
  {
    seedKey: 'home_symptoms',
    title: 'Not sure who to see?',
    subtitle: 'Describe how you feel and we will suggest the right specialist.',
    image: photo('photo-1758273241078-8eec353836be'),
    targetType: 'screen',
    targetScreen: 'symptom_checker',
    sortOrder: 3,
  },
  {
    seedKey: 'home_child',
    title: 'Gentle care for your child',
    subtitle: 'Paediatricians in Lahore for check-ups, fevers and vaccines.',
    image: photo('photo-1708687045004-a3e3c4420e6d'),
    targetType: 'specialty',
    specialty: ['pediatrics', 'paediatrics', 'pediatrician'],
    city: 'Lahore',
    sortOrder: 4,
  },
  {
    seedKey: 'home_records',
    title: 'Your records, in one place',
    subtitle: 'Reports and prescriptions from every visit, ready when you need them.',
    image: photo('photo-1632053002928-1919605ee6f7'),
    targetType: 'screen',
    targetScreen: 'records',
    sortOrder: 5,
  },
];

async function main() {
  assertSafeSeedTarget();
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ MongoDB connected\n=== Health home seed ===');

  const specialties = await Specialty.find({});
  const byName = (names) => specialties.find((s) => names.includes(s.name.trim().toLowerCase())) || null;

  // 1. Concerns — on every matching specialty that has none ("General
  //    Medicine" and "General Physician" can both exist; the home shows a
  //    shared name once).
  let filled = 0;
  for (const [names, concerns] of CONCERNS) {
    for (const spec of specialties.filter((s) => names.includes(s.name.trim().toLowerCase()))) {
      if (spec.commonConditions && spec.commonConditions.length) continue;
      spec.commonConditions = concerns;
      await spec.save();
      filled += 1;
    }
  }
  log(`concerns filled on ${filled} specialt${filled === 1 ? 'y' : 'ies'} (others already had their own)`);

  // 2. Banners — upserted by seedKey; a specialty banner is skipped when that
  //    specialty does not exist here.
  let upserted = 0;
  for (const { specialty, ...b } of BANNERS) {
    const doc = { ...b, targetScreen: b.targetScreen || null, specialtyId: null, doctorId: null, city: b.city || null, isActive: true };
    if (b.targetType === 'specialty') {
      const spec = byName(specialty);
      if (!spec) {
        log(`skipped "${b.title}": no ${specialty[0]} specialty`);
        continue;
      }
      doc.specialtyId = spec._id;
    }
    // Insert-only: once a seeded banner exists, staff own it (an edit or a
    // switch-off survives every re-run).
    const res = await HealthcareBanner.updateOne({ seedKey: b.seedKey }, { $setOnInsert: doc }, { upsert: true });
    if (res.upsertedCount) upserted += 1;
  }
  log(`banners added: ${upserted} (existing seeded banners left as they are)`);

  await mongoose.disconnect();
  console.log('✓ done');
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
