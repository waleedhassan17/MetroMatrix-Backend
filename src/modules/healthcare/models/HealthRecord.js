const mongoose = require('mongoose');

const healthRecordSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
    },
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
    },
    category: {
      type: String,
      enum: ['prescriptions', 'lab_reports', 'imaging', 'vaccination'],
      required: [true, 'Category is required'],
    },
    date: {
      type: Date,
      default: Date.now,
    },
    notes: {
      type: String,
      default: '',
    },
    files: {
      type: [String],
      default: [],
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
healthRecordSchema.index({ userId: 1, createdAt: -1 });
healthRecordSchema.index({ userId: 1, category: 1 });
healthRecordSchema.index({ date: -1 });

module.exports = mongoose.model('HealthRecord', healthRecordSchema);
