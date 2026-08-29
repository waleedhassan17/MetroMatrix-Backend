const mongoose = require('mongoose');

const clinicSchema = new mongoose.Schema(
  {
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Doctor',
      required: [true, 'Doctor reference is required'],
    },
    name: {
      type: String,
      required: [true, 'Clinic name is required'],
      trim: true,
    },
    address: {
      type: String,
      default: '',
    },
    city: {
      type: String,
      default: '',
    },
    area: {
      type: String,
      default: '',
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        default: [0, 0],
      },
    },
    phone: {
      type: String,
      default: '',
    },
    isActive: {
      type: Boolean,
      default: true,
    },

    // The IANA zone this clinic's wall-clock hours are expressed in.
    //
    // Slots are authored as "18:30" — a time on a door, not an instant. Without
    // knowing WHERE that 18:30 is you cannot turn it into a UTC instant, so
    // every comparison silently fell back to the server's zone, which nothing
    // in this project sets. This is the missing half of every slot time.
    timezone: {
      type: String,
      default: 'Asia/Karachi',
      trim: true,
    },

    // A telemedicine "clinic" has no address. Modelling that explicitly lets
    // the patient UI group and label video availability instead of inferring it
    // from a null address or from Slot.type.
    type: {
      type: String,
      enum: ['physical', 'online'],
      default: 'physical',
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
clinicSchema.virtual('timings', {
  ref: 'ClinicTiming',
  localField: '_id',
  foreignField: 'clinicId',
});

// Indexes
clinicSchema.index({ location: '2dsphere' });
clinicSchema.index({ doctorId: 1 });
clinicSchema.index({ city: 1 });
clinicSchema.index({ area: 1 });
clinicSchema.index({ isActive: 1 });

module.exports = mongoose.model('Clinic', clinicSchema);
