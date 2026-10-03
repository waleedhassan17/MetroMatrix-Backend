/**
 * Soft delete for accounts (User, Provider).
 *
 * Adds deletedAt / deletedBy / deleteReason and hides deleted documents from
 * find / findOne / findOneAndUpdate / countDocuments / distinct / aggregate
 * automatically, so a deleted account can't sign in, doesn't appear in lists,
 * searches or counts, and no query has to remember to exclude it.
 *
 * Not filtered:
 *  - queries that pass { withDeleted: true } as an option (admin restore,
 *    audit views, the deletion itself);
 *  - queries that filter on deletedAt themselves;
 *  - id-batch lookups shaped exactly { _id: { $in: [...] } } — that is how
 *    populate() resolves references, and a past booking/order/appointment
 *    must still show who it was with after that account is deleted.
 */
const mongoose = require('mongoose');

const isIdBatchLookup = (filter) => {
  const keys = Object.keys(filter || {});
  return keys.length === 1 && keys[0] === '_id' && !!filter._id && Array.isArray(filter._id.$in);
};

function excludeDeleted() {
  if (this.getOptions().withDeleted) return;
  const filter = this.getFilter();
  if (Object.prototype.hasOwnProperty.call(filter, 'deletedAt') || isIdBatchLookup(filter)) return;
  this.where({ deletedAt: null });
}

// Stages that must stay first in a pipeline.
const MUST_BE_FIRST = ['$geoNear', '$search', '$searchMeta', '$vectorSearch', '$collStats', '$indexStats'];

function softDelete(schema) {
  schema.add({
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    deleteReason: { type: String, default: '' },
    // The email the account had, kept for restore; `email` itself is replaced
    // so the address can register again.
    deletedEmail: { type: String, default: null, select: false },
    // Whether the account was active when deleted — restore returns it there.
    deletedWasActive: { type: Boolean, default: undefined, select: false },
  });
  schema.index({ deletedAt: 1 });

  for (const op of ['find', 'findOne', 'findOneAndUpdate', 'countDocuments', 'distinct']) {
    schema.pre(op, excludeDeleted);
  }

  schema.pre('aggregate', function excludeDeletedFromPipeline() {
    if (this.options?.withDeleted) return;
    const pipeline = this.pipeline();
    const first = pipeline[0] ? Object.keys(pipeline[0])[0] : null;
    const at = first && MUST_BE_FIRST.includes(first) ? 1 : 0;
    pipeline.splice(at, 0, { $match: { deletedAt: null } });
  });
}

module.exports = softDelete;
module.exports.isIdBatchLookup = isIdBatchLookup;
