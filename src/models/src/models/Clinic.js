const mongoose = require('mongoose');

const clinicTimingSchema = new mongoose.Schema({
  day:       { type: String, enum: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'] },
  startTime: String,
  endTime:   String,
}, { _id: false });

const clinicSchema = new mongoose.Schema({
  doctorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  name:        { type: String, required: true, trim: true },
  address:     { type: String, required: true },
  city:        { type: String, required: true },
  area:        String,
  coordinates: { lat: Number, lng: Number },
  phone:       String,
  timings:     [clinicTimingSchema],
  isActive:    { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Clinic', clinicSchema);
