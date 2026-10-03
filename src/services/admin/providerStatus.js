/**
 * A provider's admin state — the single place it is read and written.
 *
 * States the console shows (PROVIDER_STATES):
 *   incomplete  signed up, profile/documents not submitted yet
 *   pending     submitted, waiting for an admin decision      ← the queue
 *   approved    can work on the platform
 *   rejected    application turned down
 *   suspended   was approved; an admin has switched them off
 *
 * Stored as `verificationStatus` (pending/approved/rejected) + `isSuspended`.
 * Provider login still reads the older `adminVerified` flag and `protect`
 * reads `isActive`; every write here keeps both in step (dual-write), so the
 * provider app needs no change.
 *
 * Before this, "rejected" on the dashboard counted adminVerified 'inactive' —
 * which also covered approved providers who were later deactivated — and the
 * pending count included everyone who had merely signed up.
 */
const PROVIDER_STATES = Object.freeze(['incomplete', 'pending', 'approved', 'rejected', 'suspended']);

// Mongo filter for one state.
function stateFilter(state) {
  switch (state) {
    case 'incomplete':
      return { verificationStatus: 'pending', isSuspended: { $ne: true }, submittedAt: null };
    case 'pending':
      return { verificationStatus: 'pending', isSuspended: { $ne: true }, submittedAt: { $ne: null } };
    case 'approved':
      return { verificationStatus: 'approved', isSuspended: { $ne: true } };
    case 'rejected':
      return { verificationStatus: 'rejected', isSuspended: { $ne: true } };
    case 'suspended':
      return { isSuspended: true };
    default:
      return null;
  }
}

function stateOf(p) {
  if (p.isSuspended) return 'suspended';
  if (p.verificationStatus === 'approved') return 'approved';
  if (p.verificationStatus === 'rejected') return 'rejected';
  return p.submittedAt ? 'pending' : 'incomplete';
}

// adminVerified as login expects it, from the canonical state.
const adminVerifiedFor = (verificationStatus, isSuspended) =>
  verificationStatus === 'approved' && !isSuspended ? 'active' : verificationStatus === 'pending' ? 'pending' : 'inactive';

function approve(provider, { admin, notes }) {
  provider.verificationStatus = 'approved';
  provider.status = 'approved';
  provider.onboardingStatus = 'approved';
  provider.isVerified = true;
  provider.canLogin = true;
  provider.approvedAt = new Date();
  provider.approvedBy = admin._id;
  provider.rejectionReason = undefined;
  if (notes) provider.adminNotes = notes;
  provider.adminVerified = adminVerifiedFor('approved', provider.isSuspended);
  if (!provider.isSuspended) provider.isActive = true;
}

function reject(provider, { admin, reason, notes }) {
  provider.verificationStatus = 'rejected';
  provider.status = 'rejected';
  provider.onboardingStatus = 'rejected';
  provider.isVerified = false;
  provider.canLogin = false;
  provider.rejectionReason = reason;
  provider.rejectedAt = new Date();
  provider.rejectedBy = admin._id;
  if (notes) provider.adminNotes = notes;
  provider.adminVerified = 'inactive';
}

// Suspension ends access at once: protect refuses inactive accounts on every
// request, and login refuses adminVerified !== 'active'.
function suspend(provider, { admin, reason }) {
  provider.isSuspended = true;
  provider.suspendedReason = reason;
  provider.suspendedAt = new Date();
  provider.suspendedBy = admin._id;
  provider.isActive = false;
  provider.adminVerified = 'inactive';
}

function unsuspend(provider) {
  provider.isSuspended = false;
  provider.suspendedReason = undefined;
  provider.suspendedAt = undefined;
  provider.suspendedBy = undefined;
  provider.isActive = true;
  provider.adminVerified = adminVerifiedFor(provider.verificationStatus, false);
}

module.exports = { PROVIDER_STATES, stateFilter, stateOf, adminVerifiedFor, approve, reject, suspend, unsuspend };
