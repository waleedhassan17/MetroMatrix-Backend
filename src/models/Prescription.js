const mongoose = require('mongoose');

const medicationSchema = new mongoose.Schema({
  name:         String,
  dosage:       String,
  frequency:    String,
  duration:     String,
  instructions: String,
}, { _id: false });

const testSchema = new mongoose.Schema({
  name:         String,
  instructions: String,
}, { _id: false });

const prescriptionSchema = new mongoose.Schema({
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true, unique: true },
  doctorId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  patientId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  diagnosis:     { type: String, required: true },
  symptoms:      [String],
  medications:   [medicationSchema],
  tests:         [testSchema],
  advice:        String,
  followUpDate:  Date,
}, { timestamps: true });

module.exports = mongoose.model('Prescription', prescriptionSchema);
