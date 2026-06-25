const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  patientId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  doctorId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  slotId:             { type: mongoose.Schema.Types.ObjectId, ref: 'TimeSlot', required: true },
  clinicId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic' },
  type:               { type: String, enum: ['in-clinic','video'], required: true },
  status:             { type: String, enum: ['pending','confirmed','completed','cancelled'], default: 'pending' },
  patientName:        { type: String, required: true },
  patientPhone:       String,
  patientAge:         Number,
  patientGender:      String,
  relationship:       String,
  symptoms:           String,
  fee:                { type: Number, default: 0 },
  discount:           { type: Number, default: 0 },
  totalAmount:        { type: Number, default: 0 },
  cancellationReason: String,
  cancelledBy:        { type: String, enum: ['patient','doctor'] },
  completedAt:        Date,
  reviewSubmitted:    { type: Boolean, default: false },
}, { timestamps: true });

appointmentSchema.index({ patientId: 1, status: 1 });
appointmentSchema.index({ doctorId: 1, status: 1 });

module.exports = mongoose.model('Appointment', appointmentSchema);
