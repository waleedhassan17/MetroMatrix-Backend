/**
 * Copy each appointment's time from its slot onto the appointment. Idempotent.
 *
 * The doctor app's lists, dashboard and earnings query appointments by their
 * own startUtc / dateKey. Appointments booked before those fields existed have
 * neither, so this fills them. Appointments whose slot no longer exists are
 * listed, not guessed.
 *
 * Run AFTER scripts/healthcare-backfill-slots.js:
 *   node scripts/healthcare-backfill-appointment-times.js --dry
 *   node scripts/healthcare-backfill-appointment-times.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Appointment = require('../src/modules/healthcare/models/Appointment');
const Slot = require('../src/modules/healthcare/models/Slot');
const { appointmentTimeFields } = require('../src/modules/healthcare/services/appointmentTime');

const DRY = process.argv.includes('--dry');
const BATCH = 500;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

  let scanned = 0;
  let written = 0;
  const orphaned = [];
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    const slots = await Slot.find({ _id: { $in: batch.map((a) => a.slotId).filter(Boolean) } })
      .select('date dateKey startTime endTime startUtc endUtc clinicTimezone')
      .lean();
    const byId = new Map(slots.map((s) => [String(s._id), s]));

    const ops = [];
    for (const a of batch) {
      const fields = appointmentTimeFields(byId.get(String(a.slotId)));
      if (!fields.startUtc) {
        orphaned.push(String(a._id));
        continue;
      }
      ops.push({ updateOne: { filter: { _id: a._id, startUtc: null }, update: { $set: fields } } });
    }
    if (ops.length) {
      if (DRY) written += ops.length;
      else written += (await Appointment.bulkWrite(ops, { ordered: false })).modifiedCount;
    }
    batch = [];
  };

  const cursor = Appointment.find({ startUtc: null }).select('_id slotId').lean().cursor();
  for await (const a of cursor) {
    scanned += 1;
    batch.push(a);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  console.log(`${DRY ? '[dry] ' : ''}scanned ${scanned}, ${DRY ? 'would update' : 'updated'} ${written}`);
  if (orphaned.length) console.log(`no usable slot for ${orphaned.length}: ${orphaned.join(', ')}`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
