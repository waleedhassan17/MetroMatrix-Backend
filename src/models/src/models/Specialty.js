const mongoose = require('mongoose');

const specialtySchema = new mongoose.Schema({
  name:             { type: String, required: true, unique: true, trim: true },
  icon:             { type: String },
  description:      { type: String },
  commonConditions: [String],
  isActive:         { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Specialty', specialtySchema);
