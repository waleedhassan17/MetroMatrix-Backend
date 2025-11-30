const mongoose = require('mongoose');

const providerDocumentSchema = new mongoose.Schema(
  {
    providerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Provider',
      required: true,
      index: true,
    },
    documentType: {
      type: String,
      enum: [
        'medicalLicense',
        'degreeCertificate',
        'professionalCertificate',
        'businessLicense',
        'nationalIdCard',
      ],
      required: true,
    },
    fileName: {
      type: String,
      required: true,
    },
    fileUrl: {
      type: String,
      required: true,
    },
    fileSize: {
      type: Number, // in bytes
    },
    mimeType: {
      type: String,
    },
    publicId: {
      type: String, // Cloudinary public ID for deletion
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
    verified: {
      type: Boolean,
      default: false,
    },
    verifiedAt: Date,
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
    },
    rejectionReason: String,
  },
  { timestamps: true }
);

// Index for efficient queries
providerDocumentSchema.index({ providerId: 1, documentType: 1 });

module.exports = mongoose.model('ProviderDocument', providerDocumentSchema);
