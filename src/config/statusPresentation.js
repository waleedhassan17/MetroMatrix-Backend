/**
 * How each status value is presented: a human label and a semantic tone
 * (neutral | info | success | warning | danger). Served by GET /api/admin/meta
 * so the admin app never hardcodes a status list, label or colour — it maps
 * tones to its own palette, and renders an unknown value as neutral with a
 * readable label instead of crashing.
 *
 * The VALUES themselves come from the schemas (Model.schema.path().enumValues)
 * in controllers/admin/meta.js; this file only adds presentation.
 */
const PRESENTATION = {
  providerState: {
    incomplete: ['Not submitted', 'neutral'],
    pending: ['Awaiting review', 'warning'],
    approved: ['Approved', 'success'],
    rejected: ['Rejected', 'danger'],
    suspended: ['Suspended', 'danger'],
  },
  bookingStatus: {
    PENDING: ['Pending', 'warning'],
    ACCEPTED: ['Accepted', 'info'],
    REJECTED: ['Rejected', 'danger'],
    CANCELLED: ['Cancelled', 'neutral'],
    EN_ROUTE: ['On the way', 'info'],
    ARRIVED: ['Arrived', 'info'],
    IN_PROGRESS: ['In progress', 'info'],
    COMPLETED: ['Completed', 'success'],
  },
  appointmentStatus: {
    pending: ['Pending', 'warning'],
    confirmed: ['Confirmed', 'info'],
    completed: ['Completed', 'success'],
    cancelled: ['Cancelled', 'neutral'],
  },
  orderStatus: {
    pending: ['Pending', 'warning'],
    confirmed: ['Confirmed', 'info'],
    processing: ['Processing', 'info'],
    shipped: ['Shipped', 'info'],
    out_for_delivery: ['Out for delivery', 'info'],
    delivered: ['Delivered', 'success'],
    cancelled: ['Cancelled', 'neutral'],
    returned: ['Returned', 'warning'],
    refunded: ['Refunded', 'neutral'],
  },
  returnStatus: {
    requested: ['Requested', 'warning'],
    approved: ['Approved', 'info'],
    rejected: ['Rejected', 'danger'],
    picked_up: ['Picked up', 'info'],
    refunded: ['Refunded', 'success'],
  },
  disputeStatus: {
    open: ['Open', 'warning'],
    investigating: ['Investigating', 'info'],
    resolved: ['Resolved', 'success'],
    rejected: ['Rejected', 'neutral'],
  },
  payoutStatus: {
    pending: ['Pending', 'warning'],
    approved: ['Approved', 'success'],
    rejected: ['Rejected', 'danger'],
  },
  brandStatus: {
    pending: ['Awaiting review', 'warning'],
    active: ['Active', 'success'],
    approved: ['Approved', 'success'],
    rejected: ['Rejected', 'danger'],
    suspended: ['Suspended', 'danger'],
    inactive: ['Inactive', 'neutral'],
  },
  doctorVerificationStatus: {
    pending: ['Pending', 'warning'],
    under_review: ['Under review', 'warning'],
    verified: ['Verified', 'success'],
    rejected: ['Rejected', 'danger'],
  },
  adjustmentStatus: {
    pending: ['Awaiting approval', 'warning'],
    applying: ['Applying', 'info'],
    applied: ['Applied', 'success'],
    rejected: ['Rejected', 'neutral'],
    failed: ['Failed', 'danger'],
  },
  providerType: {
    home_service: ['Home services', 'neutral'],
    doctor: ['Doctor', 'neutral'],
    vendor: ['Shopping vendor', 'neutral'],
  },
  providerSubType: {
    electrician: ['Electrician', 'neutral'],
    plumber: ['Plumber', 'neutral'],
    ac_repairer: ['AC repairer', 'neutral'],
  },
};

const humanize = (value) => {
  const text = String(value).replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** [{ value, label, tone }] for the given values of one kind. */
function present(kind, values) {
  const table = PRESENTATION[kind] || {};
  return values
    .filter((v) => v !== null && v !== undefined && v !== '')
    .map((value) => {
      const [label, tone] = table[value] || [humanize(value), 'neutral'];
      return { value, label, tone };
    });
}

module.exports = { PRESENTATION, present, humanize };
