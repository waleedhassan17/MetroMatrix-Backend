/**
 * Backfill slot fields the doctor Availability hub relies on. Idempotent.
 *
 *   startUtc / endUtc  — legacy hand-made slots never had them, so patients
 *                        could not see them and past ones stayed bookable
 *   dateKey            — the calendar day in the slot's own zone
 *   source             — 'template' when it has an instant (only the generator
 *                        ever wrote one), otherwise 'manual'
 *   blockedBy          — 'doctor' for blocked slots with no recorded reason
 *   clinicTimezone     — filled from the clinic when missing
 *
 * Nothing is guessed: a slot whose time cannot be derived is reported, not
 * written. Duplicates the unique index refuses are reported by id.
 *
 * Run BEFORE deploying the matching API, then again after (to catch the gap):
 *   node scripts/healthcare-backfill-slots.js --dry
 *   node scripts/healthcare-backfill-slots.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Slot = require('../src/modules/healthcare/models/Slot');
const Clinic = require('../src/modules/healthcare/models/Clinic');
const { inferSlotInstants } = require('../src/modules/healthcare/services/appointmentTime');
const { toDateKey, safeZone } = require('../src/utils/time');

const DRY = process.argv.includes('--dry');
const BATCH = 500;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

  const clinics = new Map(
    (await Clinic.find({}).select('_id timezone').lean()).map((c) => [String(c._id), c])
  );

  const cursor = Slot.find({
    $or: [
      { startUtc: null },
      { dateKey: null },
      { source: { $exists: false } },
      { status: 'blocked', blockedBy: null },
    ],
  })
    .select('_id date dateKey startTime endTime startUtc endUtc clinicTimezone clinicId source status blockedBy')
    .lean()
    .cursor();

  let scanned = 0;
  let written = 0;
  let ops = [];
  const unfixable = [];
  const duplicates = [];

  const flush = async () => {
    if (!ops.length) return;
    if (DRY) {
      written += ops.length;
    } else {
      try {
        const r = await Slot.bulkWrite(ops, { ordered: false });
        written += r.modifiedCount;
      } catch (err) {
        if (!err.writeErrors) throw err;
        const errors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
        for (const w of errors) duplicates.push(String(ops[w.index].updateOne.filter._id));
        written += (err.result && err.result.nModified) || 0;
      }
    }
    ops = [];
  };

  for await (const s of cursor) {
    scanned += 1;
    const tz = safeZone(s.clinicTimezone || (clinics.get(String(s.clinicId)) || {}).timezone);
    const set = {};

    if (!s.startUtc || !s.endUtc) {
      const inferred = inferSlotInstants(s, tz);
      if (!inferred.startUtc) {
        unfixable.push(String(s._id));
      } else {
        set.startUtc = inferred.startUtc;
        set.endUtc = inferred.endUtc;
        if (!s.dateKey) set.dateKey = inferred.dateKey;
      }
    }
    if (!s.dateKey && !set.dateKey && s.startUtc) set.dateKey = toDateKey(s.startUtc, tz);
    if (!s.source) set.source = s.startUtc ? 'template' : 'manual';
    if (s.status === 'blocked' && !s.blockedBy) set.blockedBy = 'doctor';
    if (!s.clinicTimezone) set.clinicTimezone = tz;

    if (Object.keys(set).length) ops.push({ updateOne: { filter: { _id: s._id }, update: { $set: set } } });
    if (ops.length >= BATCH) await flush();
  }
  await flush();

  console.log(`${DRY ? '[dry] ' : ''}scanned ${scanned}, ${DRY ? 'would update' : 'updated'} ${written}`);
  if (unfixable.length) console.log(`could not derive a time for ${unfixable.length}: ${unfixable.join(', ')}`);
  if (duplicates.length) console.log(`refused as duplicates (${duplicates.length}): ${duplicates.join(', ')}`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
