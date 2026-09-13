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

/** `HH:mm` for minutes since midnight (0–1439). */
function fromMinutes(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** A strict `YYYY-MM-DD` that is a real calendar day ('2026-02-30' is not). */
function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return DateTime.fromISO(value, { zone: 'utc' }).isValid;
}

/**
 * The half-open UTC window `[from, to)` that is calendar day `dateKey` in `tz`.
 *
 * This replaces `new Date(date).setHours(0,0,0,0)`, which asks the SERVER what
 * midnight is. On Vercel that is UTC, while a Karachi clinic's day starts at
 * 19:00Z the evening before — so "the 15th" returned the 16th's slots.
 */
function dayWindow(dateKey, tz = DEFAULT_TIMEZONE) {
  if (!isDateKey(dateKey)) return null;
  const start = DateTime.fromISO(dateKey, { zone: safeZone(tz) }).startOf('day');
  return {
    from: start.toUTC().toJSDate(),
    to: start.plus({ days: 1 }).toUTC().toJSDate(),
  };
}

// Every UTC offset in use lies within ±14h.
const RANGE_PAD_MS = 14 * 60 * 60 * 1000;

/**
 * A Mongo filter fragment for "documents on local days fromKey..toKey".
 *
 * Documents in one query can belong to clinics in different zones, so no single
 * UTC window is exact. The padded `startUtc` bound is what lets the
 * `{doctorId, startUtc}` index do the work; the `dateKey` bound (the day in the
 * document's OWN zone) is what makes the result exact. `tz` only widens the
 * pad around the caller's days. Returns null for invalid keys.
 */
function paddedRange(fromKey, toKey = fromKey, tz = DEFAULT_TIMEZONE) {
  const first = dayWindow(fromKey, tz);
  const last = dayWindow(toKey, tz);
  if (!first || !last || toKey < fromKey) return null;
  return {
    startUtc: {
      $gte: new Date(first.from.getTime() - RANGE_PAD_MS),
      $lt: new Date(last.to.getTime() + RANGE_PAD_MS),
    },
    dateKey: { $gte: fromKey, $lte: toKey },
  };
}

/**
 * First day of the week containing `dateKey`.
 * @param {number} weekStartsOn 0 = Sunday, 1 = Monday (the app's calendars).
 */
function startOfWeekKey(dateKey, tz = DEFAULT_TIMEZONE, weekStartsOn = 1) {
  if (!isDateKey(dateKey)) return null;
  const dt = DateTime.fromISO(dateKey, { zone: safeZone(tz) });
  // Luxon: 1 = Monday … 7 = Sunday. `% 7` maps Sunday to 0.
  const back = ((dt.weekday % 7) - weekStartsOn + 7) % 7;
  return dt.minus({ days: back }).toFormat('yyyy-MM-dd');
}

/** First day of the month containing `dateKey`. */
function startOfMonthKey(dateKey) {
  return isDateKey(dateKey) ? `${dateKey.slice(0, 8)}01` : null;
}

/** `dateKey` shifted by whole months (clamped to the month's length). */
function addMonthsKey(dateKey, months, tz = DEFAULT_TIMEZONE) {
  if (!isDateKey(dateKey)) return null;
  return DateTime.fromISO(dateKey, { zone: safeZone(tz) }).plus({ months }).toFormat('yyyy-MM-dd');
}

/** Whole days from `fromKey` to `toKey` (negative when `toKey` is earlier). */
function daysBetween(fromKey, toKey) {
  if (!isDateKey(fromKey) || !isDateKey(toKey)) return null;
  const a = DateTime.fromISO(fromKey, { zone: 'utc' });
  const b = DateTime.fromISO(toKey, { zone: 'utc' });
  return Math.round(b.diff(a, 'days').days);
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
  fromMinutes,
  isDateKey,
  dayWindow,
  paddedRange,
  startOfWeekKey,
  startOfMonthKey,
  addMonthsKey,
  daysBetween,
};
