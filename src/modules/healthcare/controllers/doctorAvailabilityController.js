const asyncHandler = require('express-async-handler');
const Doctor = require('../models/Doctor');
const Clinic = require('../models/Clinic');
const { DOCTOR_CONTEXT_FIELDS } = require('../middleware/healthcareAuth');
const applyService = require('../services/availabilityApplyService');
const timeOffService = require('../services/timeOffService');
const calendar = require('../services/slotCalendarService');
const { isValidTimezone, safeZone, todayKey } = require('../../../utils/time');

// ============================================================================
// The doctor app's Availability hub: weekly hours, the calendar, time off.
// Every route runs after attachDoctor, so `req.doctor` is the signed-in doctor.
// ============================================================================

/**
 * Wrap a handler so a service error with a status becomes a JSON error with a
 * stable `error` code the app can branch on (TEMPLATE_CHANGED, SLOT_HAS_BOOKINGS,
 * CONFLICTS_CHANGED, …) and a `message` it can show as-is.
 */
const handler = (fn) =>
  asyncHandler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err && Number.isInteger(err.statusCode)) {
        return res.status(err.statusCode).json({
          success: false,
          error: err.code || err.message,
          message: err.message,
          ...(err.data ? { data: err.data } : {}),
        });
      }
      if (err && err.name === 'CastError') {
        return res.status(400).json({ success: false, error: 'INVALID_ID', message: 'Invalid id' });
      }
      throw err;
    }
  });

/** The zone the doctor's calendar days are counted in. */
async function zoneFor(doctor) {
  if (isValidTimezone(doctor.timezone)) return doctor.timezone;
  const clinic = await Clinic.findOne({ doctorId: doctor._id, isActive: { $ne: false }, timezone: { $ne: null } })
    .select('timezone')
    .lean();
  return safeZone(clinic && clinic.timezone);
}

const reloadDoctor = (doctorId) => Doctor.findById(doctorId).select(DOCTOR_CONTEXT_FIELDS).lean();

// ── Weekly hours ────────────────────────────────────────────────

// GET /doctors/me/availability
const getAvailability = handler(async (req, res) => {
  res.json({ success: true, data: await applyService.getAvailabilityHub(req.doctor) });
});

// POST /doctors/me/availability/preview  { weeklyAvailability, settings }
const previewAvailability = handler(async (req, res) => {
  res.json({ success: true, data: await applyService.previewTemplateChange(req.doctor, req.body || {}) });
});

// PUT /doctors/me/availability  { baseVersion, weeklyAvailability, settings }
const applyAvailability = handler(async (req, res) => {
  const baseVersion = Number(req.body && req.body.baseVersion);
  if (!Number.isInteger(baseVersion) || baseVersion < 0) {
    return res.status(400).json({
      success: false,
      error: 'VALIDATION',
      message: 'baseVersion is required — preview the change first',
    });
  }
  const result = await applyService.applyTemplateChange(req.doctor, req.body, { baseVersion });
  res.json({ success: true, data: result });
});

// PATCH /doctors/me/availability/settings  { autoConfirm }
const updateSettings = handler(async (req, res) => {
  const settings = await applyService.updateBookingSettings(req.doctor, req.body || {});
  res.json({ success: true, data: { settings } });
});

/**
 * PATCH /doctors/me/availability — the save of app builds that predate the hub.
 *
 * It used to cancel every appointment on a newly-absent day on the spot — no
 * refund, no slot release — and cancel whole ranges when "unavailable" was set.
 * Now weekly hours go through the same plan as the hub (stale open slots are
 * removed, booked ones kept) and absent days become time off with bookings kept.
 */
const legacySetAvailability = handler(async (req, res) => {
  const doctor = req.doctor;
  const body = req.body || {};

  const set = {};
  if (typeof body.isAvailable === 'boolean') set.isAvailable = body.isAvailable;
  for (const key of ['unavailableFrom', 'unavailableTo']) {
    if (body[key] === undefined) continue;
    const value = body[key] ? new Date(body[key]) : null;
    if (value && Number.isNaN(value.getTime())) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: `${key} is not a valid date` });
    }
    set[key] = value;
  }
  if (Object.keys(set).length) await Doctor.updateOne({ _id: doctor._id }, { $set: set });

  const conflicts = [];
  const warnings = [];

  if (Array.isArray(body.weeklyAvailability)) {
    const applied = await applyService.applyTemplateChange(doctor, { weeklyAvailability: body.weeklyAvailability });
    conflicts.push(...applied.conflicts);
    warnings.push(...applied.warnings.map((w) => w.message));
  }

  if (Array.isArray(body.absentDates)) {
    const fresh = await reloadDoctor(doctor._id);
    const synced = await timeOffService.syncLegacyAbsentDates(fresh, body.absentDates, await zoneFor(fresh));
    conflicts.push(...synced.conflicts);
    warnings.push(...synced.warnings);
  }

  const hub = await applyService.getAvailabilityHub(await reloadDoctor(doctor._id));
  res.json({ success: true, data: { ...hub, conflicts, warnings } });
});

// ── Time off ────────────────────────────────────────────────────

// GET /doctors/me/time-off?include=past
const listTimeOff = handler(async (req, res) => {
  const tz = await zoneFor(req.doctor);
  const today = todayKey(tz);
  const includePast = req.query.include === 'past';
  const timeOff = (req.doctor.timeOff || [])
    .filter((r) => includePast || r.to >= today)
    .sort((a, b) => a.from.localeCompare(b.from))
    .map(timeOffService.toTimeOffItem);
  res.json({ success: true, data: { timeOff, timezone: tz } });
});

// POST /doctors/me/time-off/preview  { from, to }
const previewTimeOff = handler(async (req, res) => {
  const tz = await zoneFor(req.doctor);
  res.json({ success: true, data: await timeOffService.previewTimeOff(req.doctor, req.body || {}, tz) });
});

// POST /doctors/me/time-off  { from, to, reason, onConflict, confirmAppointmentIds }
const createTimeOff = handler(async (req, res) => {
  const tz = await zoneFor(req.doctor);
  const result = await timeOffService.addTimeOff(req.doctor, req.body || {}, tz);
  res.status(201).json({ success: true, data: result });
});

// PATCH /doctors/me/time-off/:timeOffId  { reason }
const updateTimeOff = handler(async (req, res) => {
  const item = await timeOffService.updateTimeOffReason(req.doctor, req.params.timeOffId, (req.body || {}).reason);
  res.json({ success: true, data: { timeOff: item } });
});

// DELETE /doctors/me/time-off/:timeOffId
const deleteTimeOff = handler(async (req, res) => {
  const tz = await zoneFor(req.doctor);
  res.json({ success: true, data: await timeOffService.removeTimeOff(req.doctor, req.params.timeOffId, tz) });
});

// ── Calendar ────────────────────────────────────────────────────

// GET /doctors/me/slots/day?date=YYYY-MM-DD
const getDay = handler(async (req, res) => {
  const tz = await zoneFor(req.doctor);
  const date = req.query.date || todayKey(tz);
  res.json({ success: true, data: await calendar.getDayView(req.doctor, date, tz) });
});

// GET /doctors/me/slots/summary?from=&to=
const getSummary = handler(async (req, res) => {
  const tz = await zoneFor(req.doctor);
  const from = req.query.from || todayKey(tz);
  const to = req.query.to || from;
  res.json({ success: true, data: await calendar.getCalendarSummary(req.doctor, from, to, tz) });
});

// POST /doctors/me/slots  { date, startTime, endTime, type, clinicId, split, slotDuration, maxPatients }
const createSlots = handler(async (req, res) => {
  const tz = await zoneFor(req.doctor);
  const result = await calendar.createOneOffSlots(req.doctor, req.body || {}, tz);
  res.status(201).json({ success: true, data: result });
});

// PATCH /doctors/me/slots/:slotId  { action: 'block' | 'unblock' }
const patchSlot = handler(async (req, res) => {
  const slot = await calendar.setSlotBlocked(req.doctor, req.params.slotId, req.body || {});
  res.json({ success: true, data: { slot } });
});

// DELETE /doctors/me/slots/:slotId
const deleteSlot = handler(async (req, res) => {
  res.json({ success: true, data: await calendar.deleteSlot(req.doctor, req.params.slotId) });
});

// POST /doctors/me/slots/day/block  { date }
const blockDay = handler(async (req, res) => {
  const tz = await zoneFor(req.doctor);
  res.json({ success: true, data: await calendar.blockDay(req.doctor, (req.body || {}).date, tz) });
});

// POST /doctors/me/slots/day/unblock  { date }
const unblockDay = handler(async (req, res) => {
  const tz = await zoneFor(req.doctor);
  res.json({ success: true, data: await calendar.unblockDay(req.doctor, (req.body || {}).date, tz) });
});

/** A removed endpoint answers with what replaced it, rather than a bare 404. */
const removedEndpoint = (replacement) => (req, res) =>
  res.status(410).json({
    success: false,
    error: 'ENDPOINT_REMOVED',
    message: `This endpoint was removed. Use ${replacement}.`,
    data: { use: replacement },
  });

module.exports = {
  getAvailability,
  previewAvailability,
  applyAvailability,
  updateSettings,
  legacySetAvailability,
  listTimeOff,
  previewTimeOff,
  createTimeOff,
  updateTimeOff,
  deleteTimeOff,
  getDay,
  getSummary,
  createSlots,
  patchSlot,
  deleteSlot,
  blockDay,
  unblockDay,
  removedEndpoint,
};
