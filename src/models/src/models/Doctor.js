const mongoose = require('mongoose');

const doctorSchema = new mongoose.Schema({
  providerId:            { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true, unique: true },
  specialtyId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Specialty' },
  pmcNumber:             { type: String, unique: true, sparse: true },
  qualifications:        [String],
  experience:            { type: Number, default: 0 },
  about:                 { type: String, maxlength: 1000 },
  consultationFee:       { type: Number, default: 0 },
  videoConsultationFee:  { type: Number, default: 0 },
  rating:                { type: Number, default: 0, min: 0, max: 5 },
  totalReviews:          { type: Number, default: 0 },
  verificationStatus:    { type: String, enum: ['pending','approved','rejected'], default: 'pending' },
  verificationNotes:     String,
  isActive:              { type: Boolean, default: false },
  isAvailable:           { type: Boolean, default: true },
  unavailableFrom:       Date,
  unavailableTo:         Date,
}, { timestamps: true });

module.exports = mongoose.model('Doctor', doctorSchema);
