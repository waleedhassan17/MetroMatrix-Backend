const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema(
  {
    post: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Post',
      required: true,
    },
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
      required: [true, 'Comment content is required'],
      maxlength: [300, 'Comment cannot be longer than 300 characters'],
    },
    parentComment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Comment',
      default: null,
    },
    replies: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Comment',
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
    isEdited: {
      type: Boolean,
      default: false,
    },
    editedAt: Date,
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: Date,
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
  },
  {
    timestamps: true,
  }
);

// Indexes
commentSchema.index({ post: 1, createdAt: -1 });
commentSchema.index({ author: 1 });
commentSchema.index({ parentComment: 1 });

// Virtual for like count
commentSchema.virtual('likeCount').get(function () {
  return this.likes ? this.likes.length : 0;
});

// Virtual for reply count
commentSchema.virtual('replyCount').get(function () {
  return this.replies ? this.replies.length : 0;
});

// Method to check if a specific user has liked the comment
commentSchema.methods.hasUserLiked = function (userId, userType) {
  return this.likes.some(
    (like) => like.user.toString() === userId.toString() && like.userType === userType
  );
};

// Method to add a like
commentSchema.methods.addLike = function (userId, userType) {
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
commentSchema.methods.removeLike = function (userId, userType) {
  const initialLength = this.likes.length;
  this.likes = this.likes.filter(
    (like) => !(like.user.toString() === userId.toString() && like.userType === userType)
  );
  return this.likes.length < initialLength;
};

// Method to soft delete
commentSchema.methods.softDelete = function () {
  this.isDeleted = true;
  this.deletedAt = new Date();
  this.content = '[This comment has been deleted]';
};

// Method to add a report
commentSchema.methods.addReport = function (reporterId, reporterType, reason, description) {
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

// Pre-save middleware
commentSchema.pre('save', function (next) {
  if (this.isModified('content') && !this.isNew && !this.isDeleted) {
    this.isEdited = true;
    this.editedAt = new Date();
  }
  next();
});

// Populate author info when converting to JSON
commentSchema.set('toJSON', {
  virtuals: true,
  transform: function (doc, ret) {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Comment', commentSchema);