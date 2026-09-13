const { DEFAULT_TIMEZONE, safeZone, localToUtc, toDateKey } = require('../../../utils/time');

// ============================================================================
// When an appointment happens, copied onto the appointment.
//
// The date used to live only on the Slot. Every doctor screen asks a date
// question ("today", "this week"), so every one of them loaded the doctor's
// entire appointment history, joined slots and filtered in JavaScript — and an
// appointment whose slot was removed from the calendar lost its date entirely.
//
// Pure: no database access, so the model hook, the booking path, reschedule and
// the backfill script all derive the same fields the same way.
// ============================================================================

/**
 * The instants for a slot that predates `startUtc`.
 *
 * Legacy slots stored `date` in one of two encodings: UTC midnight (hand-made
 * slots) or clinic-local midnight (the generator, e.g. 19:00Z for Karachi). A
 * value that is exactly UTC midnight is read as a UTC calendar date; anything
 * else is read in the clinic's zone. That is correct for both encodings in
 * every zone.
 *
 * @returns {{ dateKey: string|null, startUtc: Date|null, endUtc: Date|null }}
 */
function inferSlotInstants(slot, tz) {
  const zone = safeZone(tz || slot?.clinicTimezone || DEFAULT_TIMEZONE);
  if (!slot || !slot.date) return { dateKey: null, startUtc: null, endUtc: null };

  const d = new Date(slot.date);
  if (Number.isNaN(d.getTime())) return { dateKey: null, startUtc: null, endUtc: null };
  const utcMidnight =
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  const dateKey = utcMidnight ? d.toISOString().slice(0, 10) : toDateKey(d, zone);

  const startUtc = localToUtc(dateKey, slot.startTime, zone);
  const endUtc = localToUtc(dateKey, slot.endTime, zone);
  if (!startUtc || !endUtc || endUtc <= startUtc) return { dateKey, startUtc: null, endUtc: null };
  return { dateKey, startUtc, endUtc };
}

/**
 * The time fields an appointment copies from its slot. Empty object when the
 * slot's time cannot be determined — callers must not invent one.
 */
function appointmentTimeFields(slot) {
  if (!slot) return {};
  const timezone = safeZone(slot.clinicTimezone || DEFAULT_TIMEZONE);

  let { startUtc, endUtc } = slot;
  let dateKey = slot.dateKey || null;
  if (!startUtc || !endUtc) {
    const inferred = inferSlotInstants(slot, timezone);
    startUtc = inferred.startUtc;
    endUtc = inferred.endUtc;
    dateKey = dateKey || inferred.dateKey;
  }
  if (!startUtc || !endUtc) return {};

  return {
    startUtc: new Date(startUtc),
    endUtc: new Date(endUtc),
    startTime: slot.startTime || '',
    endTime: slot.endTime || '',
    timezone,
    dateKey: dateKey || toDateKey(startUtc, timezone),
  };
}

module.exports = { inferSlotInstants, appointmentTimeFields };
