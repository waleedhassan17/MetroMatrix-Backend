const Clinic = require('../models/Clinic');
const { HHMM, toMinutes, localToUtc, DEFAULT_TIMEZONE, safeZone } = require('../../../utils/time');

// ============================================================================
// Weekly availability: validating it, and turning it into real slots.
//
// This exists because `setAvailability` assigned `doctor.weeklyAvailability`
// straight from the request body with no validation whatsoever — no time
// format check, no start<end check, no overlap check, and (a genuine
// authorization hole) no check that the clinicId belonged to the doctor. A
// doctor could attach another doctor's clinic to their own slots, and malformed
// times only surfaced later as NaN inside slot generation, which silently
// produced zero slots and looked like "the feature does nothing".
// ============================================================================

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The clinic a range is held at.
 *
 * Range first, then the legacy day-level value. Documents written before the
 * clinic moved onto the range only have the day-level field, and must keep
 * resolving to the same clinic they always did.
 */
function resolveRangeClinic(range, mode) {
  return range?.clinicId || mode?.clinicId || null;
}

/**
 * Validate a weeklyAvailability payload.
 *
 * @param {Array} weekly the client's array
 * @param {Set<string>} ownedClinicIds clinic ids this doctor actually owns
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateWeeklyAvailability(weekly, ownedClinicIds) {
  const errors = [];
  if (!Array.isArray(weekly)) return { ok: false, errors: ['weeklyAvailability must be an array'] };

  const seenDays = new Set();

  for (const day of weekly) {
    const label = day?.day || '(unnamed day)';
    if (!DAYS.includes(day?.day)) {
      errors.push(`Unknown day "${label}"`);
      continue;
    }
    // Nothing enforced one entry per day, and the consumer silently last-wins,
    // so a duplicate would quietly discard a day's hours.
    if (seenDays.has(day.day)) errors.push(`${label} appears more than once`);
    seenDays.add(day.day);

    for (const mode of ['online', 'onsite']) {
      const block = day[mode];
      if (!block || !Array.isArray(block.ranges)) continue;

      const intervals = [];

      for (const range of block.ranges) {
        const { startTime, endTime } = range || {};
        if (!HHMM.test(startTime || '') || !HHMM.test(endTime || '')) {
          errors.push(`${label} ${mode}: "${startTime}–${endTime}" is not valid HH:MM`);
          continue;
        }
        const start = toMinutes(startTime);
        const end = toMinutes(endTime);
        if (start >= end) {
          errors.push(`${label} ${mode}: ${startTime} is not before ${endTime}`);
          continue;
        }

        const clinicId = resolveRangeClinic(range, block);
        // Onsite hours without a clinic produce slots a patient cannot locate.
        if (mode === 'onsite' && !clinicId) {
          errors.push(`${label} onsite ${startTime}–${endTime}: choose a clinic`);
        }
        // THE AUTHORIZATION CHECK. Without it a doctor can point their slots at
        // any clinic id in the database, including another doctor's.
        if (clinicId && !ownedClinicIds.has(String(clinicId))) {
          errors.push(`${label} ${mode} ${startTime}–${endTime}: that clinic is not yours`);
          continue;
        }

        intervals.push({ start, end, clinicId: String(clinicId || ''), startTime, endTime });
      }

      // Overlaps are only a conflict WITHIN THE SAME CLINIC — a doctor cannot
      // be in two places at once, but online and onsite at different clinics
      // are separate resources and may legitimately coincide in the template.
      const byClinic = new Map();
      for (const iv of intervals) {
        if (!byClinic.has(iv.clinicId)) byClinic.set(iv.clinicId, []);
        byClinic.get(iv.clinicId).push(iv);
      }
      for (const [, list] of byClinic) {
        list.sort((a, b) => a.start - b.start);
        for (let i = 1; i < list.length; i += 1) {
          if (list[i].start < list[i - 1].end) {
            errors.push(
              `${label} ${mode}: ${list[i - 1].startTime}–${list[i - 1].endTime} overlaps ` +
                `${list[i].startTime}–${list[i].endTime} at the same clinic`
            );
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** The clinic ids a doctor owns, as a Set of strings. */
async function ownedClinicIds(doctorId) {
  const clinics = await Clinic.find({ doctorId }).select('_id').lean();
  return new Set(clinics.map((c) => String(c._id)));
}

/**
 * Expand one day's template into concrete slot documents.
 *
 * Every slot carries its clinic's timezone and a real UTC instant, so it can be
 * compared against "now" and sorted without re-deriving anything.
 *
 * @param {object} args
 * @param {string} args.dateKey `YYYY-MM-DD`
 * @param {object} args.dayTemplate one entry of weeklyAvailability
 * @param {Map<string,object>} args.clinicsById the doctor's clinics
 * @param {number} args.slotDuration minutes
 * @param {number} args.breakBetween minutes
 * @returns {Array} slot docs (without doctorId)
 */
function expandDay({ dateKey, dayTemplate, clinicsById, slotDuration = 30, breakBetween = 0 }) {
  const out = [];
  if (!dayTemplate || !dayTemplate.isWorking) return out;
  if (!Number.isFinite(slotDuration) || slotDuration <= 0) return out;

  for (const [mode, slotType] of [
    ['online', 'video'],
    ['onsite', 'in-clinic'],
  ]) {
    const block = dayTemplate[mode];
    if (!block || !block.enabled || !Array.isArray(block.ranges)) continue;

    for (const range of block.ranges) {
      const start = toMinutes(range?.startTime);
      const end = toMinutes(range?.endTime);
      if (start === null || end === null || start >= end) continue;

      const clinicId = resolveRangeClinic(range, block);
      const clinic = clinicId ? clinicsById.get(String(clinicId)) : null;
      // A video range may legitimately have no clinic; fall back to the default
      // zone rather than dropping the slot.
      const tz = safeZone(clinic?.timezone || DEFAULT_TIMEZONE);

      for (let cur = start; cur + slotDuration <= end; cur += slotDuration + breakBetween) {
        const hhmm = (m) =>
          `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        const startTime = hhmm(cur);
        const endTime = hhmm(cur + slotDuration);
        const startUtc = localToUtc(dateKey, startTime, tz);
        const endUtc = localToUtc(dateKey, endTime, tz);
        // localToUtc returns null rather than guessing; a slot with no instant
        // is unusable, so skip it instead of storing something wrong.
        if (!startUtc || !endUtc) continue;

        out.push({
          clinicId: clinicId || null,
          date: localToUtc(dateKey, '00:00', tz),
          startTime,
          endTime,
          startUtc,
          endUtc,
          clinicTimezone: tz,
          type: slotType,
          status: 'available',
          maxPatients: 1,
          bookedCount: 0,
        });
      }
    }
  }

  return out;
}

module.exports = {
  DAYS,
  resolveRangeClinic,
  validateWeeklyAvailability,
  ownedClinicIds,
  expandDay,
};
