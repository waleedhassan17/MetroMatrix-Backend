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

module.exports = mongoose.model('Slot', slotSchema);
