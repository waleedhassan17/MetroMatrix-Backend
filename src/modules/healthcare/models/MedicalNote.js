const mongoose = require('mongoose');

const attachmentSchema = new mongoose.Schema(
  {
    name: { type: String, default: '' },
    type: { type: String, enum: ['image', 'file'], default: 'file' },
    uri: { type: String, default: '' },
    size: { type: Number, default: 0 },
  },
  { _id: true }
);

const medicalNoteSchema = new mongoose.Schema(
  {
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
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Appointment',
      default: null,
    },
    title: { type: String, default: '' },
    content: { type: String, default: '' },
    attachments: { type: [attachmentSchema], default: [] },
    tags: { type: [String], default: [] },
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

medicalNoteSchema.index({ doctorId: 1, patientId: 1, createdAt: -1 });

module.exports = mongoose.model('MedicalNote', medicalNoteSchema);
