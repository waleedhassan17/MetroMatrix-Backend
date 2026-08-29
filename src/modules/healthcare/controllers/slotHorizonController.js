const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const Doctor = require('../models/Doctor');
const Clinic = require('../models/Clinic');
const {
  refreshAllDoctors,
  ensureHorizon,
  availabilityRunway,
  HORIZON_DAYS,
} = require('../services/slotGenerationService');
const { DEFAULT_TIMEZONE } = require('../../../utils/time');

// ============================================================================
// The production trigger for the rolling slot horizon.
//
// Vercel is serverless: there is no long-lived process, so node-cron cannot
// fire there. (This repo already learned that the hard way — the Socket.IO
// layer was registered in server.js and was silently a no-op in production
// because vercel.json rewrites everything to api/index.js.) The scheduler
// therefore lives OUTSIDE the app: Vercel Cron calls this endpoint, which does
// the same work the local cron does.
// ============================================================================

/** Timing-safe compare so the key cannot be discovered by response timing. */
function keyMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * POST /api/internal/slots/refresh-horizon
 *
 * Accepts either the shared internal key (same header the realtime bridge
 * already uses) or Vercel Cron's own bearer token.
 */
const refreshHorizon = asyncHandler(async (req, res) => {
  const expected = process.env.INTERNAL_API_KEY;
  const cronSecret = process.env.CRON_SECRET;
  const authorized =
    keyMatches(req.headers['x-internal-key'], expected) ||
    (cronSecret && req.headers.authorization === `Bearer ${cronSecret}`);

  if (!authorized) {
    // Refuse BEFORE comparing when nothing is configured, so an unset
    // INTERNAL_API_KEY cannot be matched by an absent header.
    res.status(401);
    throw new Error('Not authorized');
  }

  const result = await refreshAllDoctors();
  console.log(
    `[slots] horizon refresh (http): ${result.created} slot(s) for ` +
      `${result.touched}/${result.doctors} doctor(s)`
  );
  res.json({ success: true, data: { ...result, horizonDays: HORIZON_DAYS } });
});

/**
 * GET /doctors/me/availability/status
 *
 * How much bookable runway this doctor has left — what the warning banner
 * reads. Silence is what allowed production to reach zero bookable slots
 * without anyone noticing, so this is deliberately a first-class endpoint
 * rather than something inferred client-side.
 */
const getAvailabilityStatus = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id }).select(
    '_id weeklyAvailability'
  );
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }

  const clinics = await Clinic.find({ doctorId: doctor._id }).select('timezone').lean();
  const tz = clinics[0]?.timezone || DEFAULT_TIMEZONE;

  const hasTemplate = (doctor.weeklyAvailability || []).some(
    (d) =>
      d.isWorking &&
      ((d.online?.enabled && d.online.ranges?.length) ||
        (d.onsite?.enabled && d.onsite.ranges?.length))
  );

  const runway = await availabilityRunway(doctor._id, tz);

  // Three distinct states, because they need three different messages. Telling
  // a doctor who has never set availability to "extend" it would be nonsense.
  let state = 'ok';
  if (!hasTemplate) state = 'not_set';
  else if (runway.daysRemaining <= 0) state = 'exhausted';
  else if (runway.daysRemaining <= 7) state = 'running_out';

  res.json({
    success: true,
    data: {
      state,
      hasTemplate,
      hasClinics: clinics.length > 0,
      lastAvailableDate: runway.lastDate,
      daysRemaining: runway.daysRemaining,
      horizonDays: HORIZON_DAYS,
      timezone: tz,
    },
  });
});

/**
 * POST /doctors/me/slots/refresh — the doctor asking for it themselves.
 * Idempotent; safe to press twice.
 */
const refreshMyHorizon = asyncHandler(async (req, res) => {
  const doctor = await Doctor.findOne({ providerId: req.user._id });
  if (!doctor) {
    res.status(404);
    throw new Error('Doctor profile not found');
  }
  const result = await ensureHorizon(doctor, req.body?.slotDuration);
  res.json({ success: true, data: { ...result, horizonDays: HORIZON_DAYS } });
});

module.exports = { refreshHorizon, getAvailabilityStatus, refreshMyHorizon };
