const mongoose = require('mongoose');

const postSchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: 'authorType',
    },
    authorType: {
      type: String,
      required: true,
      enum: ['User', 'Provider'],
    },
    content: {
      type: String,
      required: [true, 'Post content is required'],
      maxlength: [500, 'Post cannot be longer than 500 characters'],
    },
    images: [
      {
        url: String,
        publicId: String,
      },
    ],
    likes: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          refPath: 'likeUserType',
        },
        userType: {
          type: String,
          enum: ['User', 'Provider'],
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    comments: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Comment',
      },
    ],
    tags: [String],
    category: {
      type: String,
      enum: ['general', 'announcement', 'question', 'recommendation', 'service'],
      default: 'general',
    },
    isPublished: {
      type: Boolean,
      default: true,
    },
    isPinned: {
      type: Boolean,
      default: false,
    },
    viewCount: {
      type: Number,
      default: 0,
    },
    shareCount: {
      type: Number,
      default: 0,
    },
    reportCount: {
      type: Number,
      default: 0,
    },
    reports: [
      {
        reporter: {
          type: mongoose.Schema.Types.ObjectId,
          refPath: 'reporterType',
        },
        reporterType: {
          type: String,
          enum: ['User', 'Provider'],
        },
        reason: {
          type: String,
          enum: ['spam', 'inappropriate', 'harassment', 'false_info', 'other'],
        },
        description: String,
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    editHistory: [
      {
        content: String,
        editedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Indexes
postSchema.index({ author: 1, createdAt: -1 });
postSchema.index({ category: 1 });
postSchema.index({ tags: 1 });
postSchema.index({ createdAt: -1 });

// Virtual for like count
postSchema.virtual('likeCount').get(function () {
  return this.likes ? this.likes.length : 0;
});

// Virtual for comment count
postSchema.virtual('commentCount').get(function () {
  return this.comments ? this.comments.length : 0;
});

// Virtual for checking if user liked the post
postSchema.virtual('isLiked').get(function () {
  // This will be set in the controller based on the current user
  return this._isLiked || false;
});

// Method to check if a specific user has liked the post
postSchema.methods.hasUserLiked = function (userId, userType) {
  return this.likes.some(
    (like) => like.user.toString() === userId.toString() && like.userType === userType
  );
};

// Method to add a like
postSchema.methods.addLike = function (userId, userType) {
  if (!this.hasUserLiked(userId, userType)) {
    this.likes.push({
      user: userId,
      userType: userType,
    });
    return true;
  }
  return false;
};

// Method to remove a like
postSchema.methods.removeLike = function (userId, userType) {
  const initialLength = this.likes.length;
  this.likes = this.likes.filter(
    (like) => !(like.user.toString() === userId.toString() && like.userType === userType)
  );
  return this.likes.length < initialLength;
};

// Method to add a report
postSchema.methods.addReport = function (reporterId, reporterType, reason, description) {
  const alreadyReported = this.reports.some(
    (report) =>
      report.reporter.toString() === reporterId.toString() &&
      report.reporterType === reporterType
  );

  if (!alreadyReported) {
    this.reports.push({
      reporter: reporterId,
      reporterType,
      reason,
      description,
    });
    this.reportCount += 1;
    return true;
  }
  return false;
};

// Populate author info when converting to JSON
postSchema.set('toJSON', {
  virtuals: true,
  transform: function (doc, ret) {
    delete ret.__v;
    return ret;
  },
});

// Pre-save middleware to track edits
postSchema.pre('save', function (next) {
  if (this.isModified('content') && !this.isNew) {
    this.editHistory.push({
      content: this.content,
      editedAt: new Date(),
    });
  }
  next();
});

module.exports = mongoose.model('Post', postSchema);