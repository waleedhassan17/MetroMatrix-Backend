const mongoose = require('mongoose');

const medicationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    dosage: { type: String, default: '' },
    frequency: { type: String, default: '' },
    duration: { type: String, default: '' },
    instructions: { type: String, default: '' },
  },
  { _id: false }
);

const testSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    instructions: { type: String, default: '' },
  },
  { _id: false }
);

const prescriptionSchema = new mongoose.Schema(
  {
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Appointment',
      required: [true, 'Appointment reference is required'],
      unique: true,
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Doctor',
      required: [true, 'Doctor reference is required'],
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Patient reference is required'],
    },
    diagnosis: {
      type: String,
      default: '',
    },
    symptoms: {
      type: [String],
      default: [],
    },
    medications: {
      type: [medicationSchema],
      default: [],
    },
    tests: {
      type: [testSchema],
      default: [],
    },
    advice: {
      type: String,
      default: '',
    },
    followUpDate: {
      type: Date,
      default: null,
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

// Indexes
prescriptionSchema.index({ appointmentId: 1 }, { unique: true });
prescriptionSchema.index({ doctorId: 1, createdAt: -1 });
prescriptionSchema.index({ patientId: 1, createdAt: -1 });

module.exports = mongoose.model('Prescription', prescriptionSchema);
