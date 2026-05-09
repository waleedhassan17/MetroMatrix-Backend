const mongoose = require('mongoose');

const timeSlotSchema = new mongoose.Schema({
  doctorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  clinicId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic' }, // null for video
  date:        { type: Date, required: true },
  startTime:   { type: String, required: true }, // '09:00'
  endTime:     { type: String, required: true }, // '09:20'
  type:        { type: String, enum: ['in-clinic','video'], required: true },
  status:      { type: String, enum: ['available','booked','blocked'], default: 'available' },
  maxPatients: { type: Number, default: 1 },
  bookedCount: { type: Number, default: 0 },
}, { timestamps: true });

// Index for fast queries
timeSlotSchema.index({ doctorId: 1, date: 1, status: 1 });

module.exports = mongoose.model('TimeSlot', timeSlotSchema);
