/**
 * Move each doctor's legacy `absentDates` into `timeOff` ranges. Idempotent.
 *
 * Consecutive days become one range (reason "Absent", legacy: true). Days
 * already covered by a time-off entry are not duplicated. Slots on those days
 * that are blocked with no specific reason are marked as blocked by time off,
 * so removing the time off later reopens them.
 *
 * The original arrays are printed first, so the change can be reverted.
 *
 * Run AFTER deploying the time-off API:
 *   node scripts/healthcare-migrate-absent-dates.js --dry
 *   node scripts/healthcare-migrate-absent-dates.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Doctor = require('../src/modules/healthcare/models/Doctor');
const Clinic = require('../src/modules/healthcare/models/Clinic');
const Slot = require('../src/modules/healthcare/models/Slot');
const { resolveDoctorTimezone } = require('../src/modules/healthcare/services/availabilityService');
const { mergeConsecutiveDays, rangesOverlap } = require('../src/modules/healthcare/services/timeOffService');
const { toDateKey, paddedRange } = require('../src/utils/time');

const DRY = process.argv.includes('--dry');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

  const doctors = await Doctor.find({ 'absentDates.0': { $exists: true } })
    .select('_id timezone timeOff absentDates')
    .lean();

  console.log('original absentDates (for rollback):');
  console.log(JSON.stringify(doctors.map((d) => ({ _id: d._id, absentDates: d.absentDates }))));

  let ranges = 0;
  let slots = 0;
  for (const doctor of doctors) {
    const clinics = await Clinic.find({ doctorId: doctor._id, isActive: { $ne: false } }).select('timezone').lean();
    const tz = resolveDoctorTimezone(doctor, clinics);
    const existing = doctor.timeOff || [];

    const additions = mergeConsecutiveDays(doctor.absentDates.map((d) => toDateKey(d, tz)))
      .filter((r) => !existing.some((e) => rangesOverlap(e, r)))
      .map((r) => ({
        _id: new mongoose.Types.ObjectId(),
        from: r.from,
        to: r.to,
        reason: 'Absent',
        createdAt: new Date(),
        legacy: true,
      }));

    ranges += additions.length;
    console.log(`doctor ${doctor._id}: ${additions.map((r) => `${r.from}..${r.to}`).join(', ') || 'nothing new'}`);
    if (DRY) continue;

    await Doctor.updateOne(
      { _id: doctor._id },
      { $push: { timeOff: { $each: additions } }, $set: { absentDates: [] } }
    );

    for (const r of additions) {
      const range = paddedRange(r.from, r.to, tz);
      const res = await Slot.updateMany(
        { doctorId: doctor._id, ...range, status: 'blocked', blockedBy: { $in: [null, 'doctor'] } },
        { $set: { blockedBy: 'time_off' } }
      );
      slots += res.modifiedCount || 0;
    }
  }

  console.log(`${DRY ? '[dry] ' : ''}doctors ${doctors.length}, ranges ${ranges}, slots re-labelled ${slots}`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
