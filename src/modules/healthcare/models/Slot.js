const mongoose = require('mongoose');

const slotSchema = new mongoose.Schema(
  {
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Doctor',
      required: [true, 'Doctor reference is required'],
    },
    clinicId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      default: null,
    },
    date: {
      type: Date,
      required: [true, 'Slot date is required'],
    },
    startTime: {
      type: String,
      required: [true, 'Start time is required'],
      match: [/^([01]\d|2[0-3]):([0-5]\d)$/, 'Start time must be in HH:MM format'],
    },
    endTime: {
      type: String,
      required: [true, 'End time is required'],
      match: [/^([01]\d|2[0-3]):([0-5]\d)$/, 'End time must be in HH:MM format'],
    },
    // ------------------------------------------------------------------
    // THE CANONICAL INSTANTS.
    //
    // `date` + `startTime` are what the doctor AUTHORED: wall-clock time at a
    // clinic. They stay, because they are stable (a DST rule change must not
    // silently move a doctor's published hours) and every existing reader uses
    // them. But a wall-clock string cannot be compared, sorted, or filtered
    // against "now" — which is exactly why patients were shown 09:00 slots at
    // 18:00 and why refund windows were computed in the wrong zone.
    //
    // These are the derived truth: the actual moment the slot happens, built
    // from date + startTime + the CLINIC's timezone via utils/time.js. Filter
    // and sort on these; display from the wall clock.
    // ------------------------------------------------------------------
    startUtc: {
      type: Date,
      default: null,
      index: true,
    },
    endUtc: {
      type: Date,
      default: null,
    },
    // Snapshotted so a slot can be rendered without joining the clinic, and so
    // a later clinic-timezone correction cannot retroactively reinterpret slots
    // that were already published and booked under the old zone.
    clinicTimezone: {
      type: String,
      default: 'Asia/Karachi',
    },

    type: {
      type: String,
      enum: ['in-clinic', 'video'],
      required: [true, 'Slot type is required'],
    },
    status: {
      type: String,
      enum: ['available', 'booked', 'blocked'],
      default: 'available',
    },
    maxPatients: {
      type: Number,
      default: 1,
      min: 1,
    },
    bookedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

// Virtual: check if slot is full
slotSchema.virtual('isFull').get(function () {
  return this.bookedCount >= this.maxPatients;
});

// Indexes
slotSchema.index({ doctorId: 1, date: 1 });
slotSchema.index({ doctorId: 1, date: 1, startTime: 1 });
slotSchema.index({ clinicId: 1, date: 1 });
slotSchema.index({ status: 1 });
slotSchema.index({ date: 1, status: 1 });
slotSchema.index({ type: 1 });

// The discovery query — "what can this doctor still offer, from now on" — and
// the next-available scan. Neither had an index leading with doctorId + an
// instant, so both scanned every slot the doctor has ever had.
slotSchema.index({ doctorId: 1, startUtc: 1 });
// The hot availability read filters on status too; the compound above stopped
// at `date`, so status was always an in-memory filter.
slotSchema.index({ doctorId: 1, date: 1, status: 1 });

// ---------------------------------------------------------------------------
// THE DOUBLE-BOOKING BACKSTOP.
//
// Booking is guarded in application code by a conditional $inc (slotService),
// which is correct and handles multi-patient slots. This index is the second
// line of defence: it makes a duplicate single-patient slot impossible at the
// database, so any code path that bypasses the service — a script, an admin
// route, a future endpoint — still cannot create two competing slots for the
// same doctor, clinic and instant.
//
// PARTIAL, on purpose. `maxPatients > 1` slots legitimately allow several
// bookings; a blanket unique index would forbid group consultations outright.
// Also skips docs without startUtc so pre-backfill rows do not collide.
// ---------------------------------------------------------------------------
slotSchema.index(
  { doctorId: 1, clinicId: 1, startUtc: 1 },
  {
    unique: true,
    partialFilterExpression: {
      maxPatients: { $eq: 1 },
      startUtc: { $type: 'date' },
    },
    name: 'uniq_single_patient_slot',
  }
);

module.exports = mongoose.model('Slot', slotSchema);
