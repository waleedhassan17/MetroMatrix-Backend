const mongoose = require('mongoose');

const ProviderSubmissionSchema = new mongoose.Schema({
  // Basic Info
  providerType: {
    type: String,
    enum: ['doctor', 'home_service', 'vendor'],
    required: true,
  },
  providerSubType: {
    type: String,
  },
  fullName: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
  },
  phoneNumber: {
    type: String,
    required: true,
  },
  
  // Professional Info
  specialty: String,
  experience: String,
  qualification: String,
  
  // Location
  city: {
    type: String,
    required: true,
  },
  address: String,
  
  // Identity
  idNumber: {
    type: String,
    required: true,
  },
  
  // Description
  bio: String,
  services: [String],
  
  // Pricing
  consultationFee: Number,
  serviceFee: Number,
  
  // Documents (URLs stored in Cloudinary)
  documents: {
    medicalLicense: {
      url: String,
      publicId: String,
    },
    degreeCertificate: {
      url: String,
      publicId: String,
    },
    nationalIdCard: {
      url: String,
      publicId: String,
    },
    additionalCertificates: [{
      url: String,
      publicId: String,
      name: String,
    }],
    profilePhoto: {
      url: String,
      publicId: String,
    },
  },
  
  // Submission Status
  status: {
    type: String,
    enum: ['pending_review', 'approved', 'rejected'],
    default: 'pending_review',
  },
  
  // Linked User ID (from email verification)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  
  // Timestamps
  submittedAt: {
    type: Date,
    default: Date.now,
  },
  reviewedAt: Date,
  
  // Admin Review
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
  },
  rejectionReason: String,
  adminNotes: String,
  
  // After Approval
  providerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Provider',
  },
}, {
  timestamps: true,
});

// Index for faster queries
ProviderSubmissionSchema.index({ email: 1 });
ProviderSubmissionSchema.index({ status: 1 });
ProviderSubmissionSchema.index({ submittedAt: -1 });

module.exports = mongoose.model('ProviderSubmission', ProviderSubmissionSchema);
