const mongoose = require('mongoose');

/**
 * One vital-sign reading a patient took — from a Bluetooth monitor (standard
 * GATT Heart Rate 0x180D / Blood Pressure 0x1810 services) or typed in.
 * Visible to the patient and to doctors they have an appointment with.
 */
const healthVitalSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['heart_rate', 'blood_pressure'], required: true },
    heartRate: {
      bpm: { type: Number, min: 25, max: 250 },
    },
    bloodPressure: {
      systolic: { type: Number, min: 60, max: 260 },
      diastolic: { type: Number, min: 30, max: 160 },
      meanArterial: { type: Number },
      pulse: { type: Number, min: 25, max: 250 },
    },
    source: {
      kind: { type: String, enum: ['ble', 'manual'], required: true },
      deviceName: { type: String, default: '', maxlength: 60 },
    },
    measuredAt: { type: Date, required: true },
    // Set by the app per reading, so a batch retried after a timeout is not
    // stored twice.
    clientId: { type: String, maxlength: 64 },
  },
  { timestamps: true }
);

healthVitalSchema.index({ patientId: 1, type: 1, measuredAt: -1 });
healthVitalSchema.index(
  { patientId: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } }
);

healthVitalSchema.set('toJSON', {
  versionKey: false,
  transform: (doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    if (ret.type !== 'heart_rate') delete ret.heartRate;
    if (ret.type !== 'blood_pressure') delete ret.bloodPressure;
    return ret;
  },
});

module.exports = mongoose.models.HealthVital || mongoose.model('HealthVital', healthVitalSchema);
