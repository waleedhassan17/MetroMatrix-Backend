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
