const mongoose = require('mongoose');

const doctorSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
    },
    specialtyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Specialty',
      required: [true, 'Specialty is required'],
    },
    pmcNumber: {
      type: String,
      required: [true, 'PMC number is required'],
      unique: true,
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
      enum: ['pending', 'verified', 'rejected'],
      default: 'pending',
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
doctorSchema.index({ userId: 1 }, { unique: true });
doctorSchema.index({ specialtyId: 1 });
doctorSchema.index({ pmcNumber: 1 });
doctorSchema.index({ verificationStatus: 1 });
doctorSchema.index({ isActive: 1 });
doctorSchema.index({ rating: -1 });
doctorSchema.index({ consultationFee: 1 });

module.exports = mongoose.model('Doctor', doctorSchema);
