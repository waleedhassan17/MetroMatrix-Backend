const mongoose = require('mongoose');

const doctorSchema = new mongoose.Schema(
  {
    // A doctor is a Provider (providerType: 'doctor'). Identity links to Provider.
    providerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Provider',
      required: [true, 'Provider reference is required'],
    },
    specialtyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Specialty',
      default: null,
    },
    pmcNumber: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    qualifications: {
      type: [String],
      default: [],
    },
    experience: {
      type: Number,
      default: 0,
      min: 0,
    },
    about: {
      type: String,
      default: '',
    },
    consultationFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    videoConsultationFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    totalReviews: {
      type: Number,
      default: 0,
    },
    verificationStatus: {
      type: String,
      // 'verified' is the patient-visible / approved state.
      enum: ['pending', 'under_review', 'verified', 'rejected'],
      default: 'pending',
    },
    verificationNotes: {
      type: String,
      default: '',
    },
    verificationDocuments: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Availability toggle (doctor temporarily unavailable)
    isAvailable: {
      type: Boolean,
      default: true,
    },
    unavailableFrom: {
      type: Date,
      default: null,
    },
    unavailableTo: {
      type: Date,
      default: null,
    },
    // Weekly recurring availability. Per day, the doctor can be available online
    // (video) and/or onsite (in-clinic), each with its own time ranges.
    //
    // CLINIC LIVES ON THE RANGE, NOT THE DAY.
    //
    // `onsite.clinicId` below is the ORIGINAL day-level field, and it made the
    // product requirement unrepresentable: a doctor who works Clinic A in the
    // morning and Clinic B in the evening had nowhere to say so, because one
    // day carried exactly one clinic. Every generated slot for that day was
    // stamped with the same clinic, or — since the editor never wired its own
    // clinic picker — with null.
    //
    // `ranges[].clinicId` is the real binding. The day-level value is retained
    // and read as a FALLBACK so the twelve doctors whose documents predate this
    // keep working untouched; new writes populate the range. Resolution order
    // is always range first, then day (see resolveRangeClinic in
    // services/availabilityService.js).
    weeklyAvailability: {
      type: [
        {
          _id: false,
          day: {
            type: String,
            enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
          },
          isWorking: { type: Boolean, default: false },
          online: {
            enabled: { type: Boolean, default: false },
            ranges: {
              // Online ranges may carry a clinicId too: a doctor can run
              // telemedicine "from" a particular practice, and it decides which
              // fee and which timezone the slot inherits.
              type: [
                {
                  _id: false,
                  startTime: String,
                  endTime: String,
                  clinicId: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null },
                },
              ],
              default: [],
            },
          },
          onsite: {
            enabled: { type: Boolean, default: false },
            /** @deprecated day-level fallback — prefer ranges[].clinicId */
            clinicId: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null },
            ranges: {
              type: [
                {
                  _id: false,
                  startTime: String,
                  endTime: String,
                  clinicId: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null },
                },
              ],
              default: [],
            },
          },
        },
      ],
      default: [],
    },
    /**
     * @deprecated Use `timeOff`. One Date per day, no reason, and compared
     * across zones as instants. Still read (unioned with timeOff) until
     * scripts/healthcare-migrate-absent-dates.js has run.
     */
    absentDates: {
      type: [Date],
      default: [],
    },

    // ── Booking settings (the doctor app's Availability hub) ──────────────
    // Consultation length lived nowhere: the app hardcoded 30 and the nightly
    // job read an env var, so the two could generate overlapping grids. Null
    // means "not chosen yet" and resolves to DEFAULT_SLOT_MINUTES.
    slotDuration: { type: Number, min: 5, max: 240, default: null },
    // Minutes of gap after each slot.
    bufferMinutes: { type: Number, min: 0, max: 120, default: 0 },
    // The app showed a "Video consultations" switch that was never stored.
    videoConsultation: { type: Boolean, default: true },
    // Bookings go straight to confirmed instead of waiting for approval.
    autoConfirm: { type: Boolean, default: false },
    // Zone for slots with no clinic (video). Null falls back to the first
    // active clinic's zone, then Asia/Karachi.
    timezone: { type: String, default: null },
    // Optimistic concurrency for applying weekly hours, so two devices cannot
    // silently overwrite each other's template.
    availabilityVersion: { type: Number, default: 0 },
    // Leave, as inclusive ranges of calendar days in the doctor's zone.
    timeOff: {
      type: [
        {
          from: { type: String, required: true }, // YYYY-MM-DD
          to: { type: String, required: true }, // YYYY-MM-DD
          reason: { type: String, default: '', maxlength: 200 },
          createdAt: { type: Date, default: Date.now },
          // Migrated from absentDates rather than entered in the hub.
          legacy: { type: Boolean, default: false },
        },
      ],
      default: [],
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

// Virtuals
doctorSchema.virtual('clinics', {
  ref: 'Clinic',
  localField: '_id',
  foreignField: 'doctorId',
});

doctorSchema.virtual('slots', {
  ref: 'Slot',
  localField: '_id',
  foreignField: 'doctorId',
});

// Indexes
doctorSchema.index({ providerId: 1 }, { unique: true });
doctorSchema.index({ specialtyId: 1 });
doctorSchema.index({ verificationStatus: 1 });
doctorSchema.index({ isActive: 1 });
doctorSchema.index({ rating: -1 });
doctorSchema.index({ consultationFee: 1 });

module.exports = mongoose.model('Doctor', doctorSchema);
