const { DateTime } = require('luxon');

// ============================================================================
// The ONLY place in this codebase that does timezone arithmetic.
//
// WHY THIS EXISTS
// ---------------
// Scheduling had no timezone concept at all: not a field on Doctor, Clinic,
// Slot or Appointment, and no date library. Every calculation used raw `Date`
// plus `setHours(0,0,0,0)`, which silently resolves in the SERVER's zone — a
// zone nothing sets and nobody controls. Meanwhile slots are stored with their
// `date` at UTC midnight. Those two only agree when the server happens to run
// in UTC, so a deploy to a machine in another zone shifts every doctor's
// calendar by a day without any error.
//
// The worst instance was `paymentService.slotStartDate`, which extracted the
// day in UTC (`toISOString().slice(0,10)`) and then re-parsed it in local time
// (`new Date('...T18:00:00')`) inside a single three-line function — and that
// function decides refund eligibility.
//
// THE MODEL
// ---------
// A slot is authored as WALL-CLOCK TIME AT A CLINIC: "18:30 on 2026-09-05 at
// the Gulberg clinic". That is what the doctor means and what the patient
// reads on the door. It is NOT an instant until you know the clinic's zone.
//
//   wall clock + IANA zone  ->  a UTC instant   (localToUtc)
//   a UTC instant + IANA zone -> wall clock     (utcToLocal)
//
// Store BOTH: the wall clock (what was authored, stable across DST rule
// changes) and the UTC instant (what you compare, sort and filter on). Never
// compare wall-clock strings across clinics, and never derive an instant
// anywhere but here.
// ============================================================================

/** Fallback when a clinic predates the timezone field. Pakistan has no DST. */
const DEFAULT_TIMEZONE = 'Asia/Karachi';

/** `HH:mm`, 24-hour. */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  return DateTime.local().setZone(tz).isValid;
}

/** Coerce anything to a usable IANA zone rather than producing Invalid DateTime. */
function safeZone(tz) {
  return isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
}

/** `YYYY-MM-DD` for a Date, read in `tz` — NOT via toISOString(). */
function toDateKey(date, tz = DEFAULT_TIMEZONE) {
  if (!date) return null;
  return DateTime.fromJSDate(new Date(date), { zone: 'utc' })
    .setZone(safeZone(tz))
    .toFormat('yyyy-MM-dd');
}

/**
 * Wall clock at a clinic -> the UTC instant it actually happens.
 *
 * @param {string|Date} dateStr `YYYY-MM-DD` (or a Date, read in `tz`)
 * @param {string} hhmm `HH:mm`
 * @param {string} tz IANA zone
 * @returns {Date|null} null when the input cannot be interpreted — callers must
 *   treat that as "no slot" rather than substituting `now`.
 */
function localToUtc(dateStr, hhmm, tz = DEFAULT_TIMEZONE) {
  if (!dateStr || !hhmm || !HHMM.test(hhmm)) return null;
  const day = typeof dateStr === 'string' ? dateStr.slice(0, 10) : toDateKey(dateStr, tz);
  if (!day) return null;

  const dt = DateTime.fromISO(`${day}T${hhmm}`, { zone: safeZone(tz) });
  if (!dt.isValid) return null;
  // A wall-clock time inside a spring-forward gap does not exist. Luxon moves
  // it forward rather than throwing, which is the sane behaviour for a clinic
  // that scheduled through a DST transition. Irrelevant for Asia/Karachi, but
  // this utility is not Pakistan-only.
  return dt.toUTC().toJSDate();
}

/** A UTC instant -> wall clock in `tz`, for display. */
function utcToLocal(utcDate, tz = DEFAULT_TIMEZONE, fmt = 'ccc, dd LLL • HH:mm') {
  if (!utcDate) return '';
  const dt = DateTime.fromJSDate(new Date(utcDate), { zone: 'utc' }).setZone(safeZone(tz));
  return dt.isValid ? dt.toFormat(fmt) : '';
}

/** A UTC instant -> `HH:mm` in `tz`. */
function utcToHHMM(utcDate, tz = DEFAULT_TIMEZONE) {
  return utcToLocal(utcDate, tz, 'HH:mm');
}

/** Today's `YYYY-MM-DD` in `tz` — the correct "what day is it" for a clinic. */
function todayKey(tz = DEFAULT_TIMEZONE) {
  return DateTime.now().setZone(safeZone(tz)).toFormat('yyyy-MM-dd');
}

/** `YYYY-MM-DD` shifted by whole days, staying in `tz`. */
function addDays(dateKey, days, tz = DEFAULT_TIMEZONE) {
  const dt = DateTime.fromISO(dateKey, { zone: safeZone(tz) });
  return dt.isValid ? dt.plus({ days }).toFormat('yyyy-MM-dd') : null;
}

/** Inclusive list of `YYYY-MM-DD` from `fromKey` to `toKey`, capped for safety. */
function eachDay(fromKey, toKey, tz = DEFAULT_TIMEZONE, maxDays = 120) {
  const zone = safeZone(tz);
  let cur = DateTime.fromISO(fromKey, { zone });
  const end = DateTime.fromISO(toKey, { zone });
  if (!cur.isValid || !end.isValid || end < cur) return [];
  const out = [];
  while (cur <= end && out.length < maxDays) {
    out.push(cur.toFormat('yyyy-MM-dd'));
    cur = cur.plus({ days: 1 });
  }
  return out;
}

/** Weekday name matching Doctor.weeklyAvailability's enum ('Monday'…'Sunday'). */
function weekdayName(dateKey, tz = DEFAULT_TIMEZONE) {
  const dt = DateTime.fromISO(dateKey, { zone: safeZone(tz) });
  return dt.isValid ? dt.toFormat('cccc') : null;
}

/** Minutes since midnight for `HH:mm`, or null. Used for overlap checks. */
function toMinutes(hhmm) {
  if (!HHMM.test(hhmm || '')) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

module.exports = {
  DEFAULT_TIMEZONE,
  HHMM,
  isValidTimezone,
  safeZone,
  localToUtc,
  utcToLocal,
  utcToHHMM,
  toDateKey,
  todayKey,
  addDays,
  eachDay,
  weekdayName,
  toMinutes,
};
