const Clinic = require('../models/Clinic');
const {
  HHMM,
  toMinutes,
  fromMinutes,
  localToUtc,
  DEFAULT_TIMEZONE,
  safeZone,
  isValidTimezone,
} = require('../../../utils/time');

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

const SLOT_DURATION_MIN = 5;
const SLOT_DURATION_MAX = 240;
const BUFFER_MAX = 120;
const MAX_RANGES_PER_MODE = 12;

const MODE_LABEL = { online: 'Video', onsite: 'In-clinic' };

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
 * The zone a doctor's calendar days are counted in: their own setting, else
 * their first active clinic's, else the default. Video slots with no clinic
 * are stamped with this.
 */
function resolveDoctorTimezone(doctor, clinics = []) {
  if (doctor && isValidTimezone(doctor.timezone)) return doctor.timezone;
  const zoned = (clinics || []).find((c) => c && c.isActive !== false && isValidTimezone(c.timezone));
  return zoned ? zoned.timezone : DEFAULT_TIMEZONE;
}

/**
 * Validate the doctor's booking settings. Only keys present in `input` are
 * checked and returned, so a partial update stays partial.
 *
 * @returns {{ ok: boolean, errors: Array<{field,code,message}>, value: object }}
 */
function validateSettings(input = {}) {
  const errors = [];
  const value = {};
  const fail = (field, code, message) => errors.push({ field, code, message });

  if (input.slotDuration !== undefined) {
    const n = Number(input.slotDuration);
    if (!Number.isInteger(n) || n < SLOT_DURATION_MIN || n > SLOT_DURATION_MAX) {
      fail(
        'slotDuration',
        'BAD_SLOT_DURATION',
        `Slot length must be a whole number of minutes from ${SLOT_DURATION_MIN} to ${SLOT_DURATION_MAX}`
      );
    } else {
      value.slotDuration = n;
    }
  }

  if (input.bufferMinutes !== undefined) {
    const n = Number(input.bufferMinutes);
    if (!Number.isInteger(n) || n < 0 || n > BUFFER_MAX) {
      fail('bufferMinutes', 'BAD_BUFFER', `Break between slots must be 0 to ${BUFFER_MAX} minutes`);
    } else {
      value.bufferMinutes = n;
    }
  }

  for (const flag of ['videoConsultation', 'autoConfirm']) {
    if (input[flag] === undefined) continue;
    if (typeof input[flag] !== 'boolean') fail(flag, 'BAD_FLAG', `${flag} must be true or false`);
    else value[flag] = input[flag];
  }

  if (input.timezone !== undefined) {
    if (input.timezone !== null && !isValidTimezone(input.timezone)) {
      fail('timezone', 'BAD_TIMEZONE', 'timezone must be an IANA zone such as Asia/Karachi');
    } else {
      value.timezone = input.timezone;
    }
  }

  return { ok: errors.length === 0, errors, value };
}

/**
 * Validate a weeklyAvailability payload.
 *
 * Only ranges that will actually publish slots (a working day, an enabled
 * mode) are checked: a disabled block is inert, and failing a save because of
 * a leftover clinic-less range the doctor switched off is how "Save does
 * nothing" happened.
 *
 * Overlap policy — a doctor is one person:
 *   · two in-clinic ranges overlapping, at ANY clinic   → error
 *   · two video ranges overlapping                       → error
 *   · video overlapping in-clinic                        → warning: that is a
 *     doctor offering two ways to be seen at 10:00, and the booking overlap
 *     lock closes the other the moment one is booked. It is an error only when
 *     the two clinics are in different zones, where "10:00" is not one moment.
 *
 * @param {Array} weekly the client's array
 * @param {Set<string>} ownedClinicIds clinic ids this doctor owns (active)
 * @param {object} [opts]
 * @param {number} [opts.slotDuration] ranges shorter than one slot are rejected
 * @param {Map<string,object>} [opts.clinicsById] enables the zone-mismatch check
 * @returns {{ ok: boolean, errors: string[], issues: Array<{day,mode,index,code,message}>,
 *   warnings: Array<{day,code,message}> }}
 */
function validateWeeklyAvailability(weekly, ownedClinicIds, opts = {}) {
  const { slotDuration, clinicsById } = opts;
  const issues = [];
  const warnings = [];
  const fail = (day, mode, index, code, message) => issues.push({ day, mode, index, code, message });
  const done = () => ({
    ok: issues.length === 0,
    // Kept as strings for callers that still join them into one message.
    errors: issues.map((i) => i.message),
    issues,
    warnings,
  });

  if (!Array.isArray(weekly)) {
    fail(null, null, null, 'BAD_PAYLOAD', 'weeklyAvailability must be an array');
    return done();
  }

  const seenDays = new Set();

  for (const day of weekly) {
    const label = day?.day || '(unnamed day)';
    if (!DAYS.includes(day?.day)) {
      fail(label, null, null, 'UNKNOWN_DAY', `Unknown day "${label}"`);
      continue;
    }
    // Nothing enforced one entry per day, and the consumer silently last-wins,
    // so a duplicate would quietly discard a day's hours.
    if (seenDays.has(day.day)) fail(label, null, null, 'DUPLICATE_DAY', `${label} appears more than once`);
    seenDays.add(day.day);

    if (!day.isWorking) continue;

    const intervals = [];

    for (const mode of ['online', 'onsite']) {
      const block = day[mode];
      if (!block || !block.enabled || !Array.isArray(block.ranges)) continue;

      if (block.ranges.length > MAX_RANGES_PER_MODE) {
        fail(label, mode, null, 'TOO_MANY_RANGES', `${label}: at most ${MAX_RANGES_PER_MODE} ${MODE_LABEL[mode].toLowerCase()} periods per day`);
      }

      block.ranges.forEach((range, index) => {
        const { startTime, endTime } = range || {};
        const where = `${label} ${MODE_LABEL[mode].toLowerCase()}`;
        if (!HHMM.test(startTime || '') || !HHMM.test(endTime || '')) {
          fail(label, mode, index, 'BAD_TIME', `${where}: "${startTime}–${endTime}" is not a valid time`);
          return;
        }
        const start = toMinutes(startTime);
        const end = toMinutes(endTime);
        if (start >= end) {
          fail(label, mode, index, 'START_NOT_BEFORE_END', `${where}: ${startTime} must be before ${endTime}`);
          return;
        }
        if (slotDuration && end - start < slotDuration) {
          fail(
            label,
            mode,
            index,
            'RANGE_SHORTER_THAN_SLOT',
            `${where}: ${startTime}–${endTime} is shorter than one ${slotDuration}-minute slot`
          );
        }

        const clinicId = resolveRangeClinic(range, block);
        // Onsite hours without a clinic produce slots a patient cannot locate.
        if (mode === 'onsite' && !clinicId) {
          fail(label, mode, index, 'CLINIC_REQUIRED', `${where} ${startTime}–${endTime}: choose a clinic`);
          return;
        }
        // THE AUTHORIZATION CHECK. Without it a doctor can point their slots at
        // any clinic id in the database, including another doctor's.
        if (clinicId && !ownedClinicIds.has(String(clinicId))) {
          fail(label, mode, index, 'CLINIC_NOT_OWNED', `${where} ${startTime}–${endTime}: that clinic is not one of your active clinics`);
          return;
        }

        intervals.push({ mode, index, start, end, startTime, endTime, clinicId: clinicId ? String(clinicId) : null });
      });
    }

    intervals.sort((a, b) => a.start - b.start);
    for (let i = 0; i < intervals.length; i += 1) {
      for (let j = i + 1; j < intervals.length && intervals[j].start < intervals[i].end; j += 1) {
        const a = intervals[i];
        const b = intervals[j];
        const span = (x) => `${x.startTime}–${x.endTime}`;

        if (a.mode === b.mode) {
          fail(
            label,
            b.mode,
            b.index,
            'OVERLAP_SAME_MODE',
            `${label}: ${MODE_LABEL[a.mode].toLowerCase()} ${span(a)} overlaps ${span(b)}`
          );
          continue;
        }

        const video = a.mode === 'online' ? a : b;
        const clinic = a.mode === 'online' ? b : a;
        const zoneOf = (x) => safeZone(clinicsById?.get(x.clinicId)?.timezone);
        if (clinicsById && video.clinicId && clinic.clinicId && zoneOf(video) !== zoneOf(clinic)) {
          fail(
            label,
            'online',
            video.index,
            'OVERLAP_TZ_MISMATCH',
            `${label}: video ${span(video)} and in-clinic ${span(clinic)} overlap at clinics in different time zones`
          );
          continue;
        }
        warnings.push({
          day: label,
          code: 'MODE_OVERLAP',
          message: `${label}: video ${span(video)} overlaps in-clinic ${span(clinic)} — booking one closes the other`,
        });
      }
    }
  }

  return done();
}

/** The clinic ids a doctor owns, as a Set of strings. Deleted clinics excluded by default. */
async function ownedClinicIds(doctorId, { activeOnly = true } = {}) {
  const filter = { doctorId };
  if (activeOnly) filter.isActive = { $ne: false };
  const clinics = await Clinic.find(filter).select('_id').lean();
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
 * @param {Map<string,object>} args.clinicsById the doctor's ACTIVE clinics
 * @param {number} args.slotDuration minutes
 * @param {number} args.breakBetween minutes of buffer after each slot
 * @param {string} args.defaultTz zone for ranges with no clinic (the doctor's)
 * @param {boolean} args.includeOnline false when video consultations are off
 * @returns {Array} slot docs (without doctorId)
 */
function expandDay({
  dateKey,
  dayTemplate,
  clinicsById,
  slotDuration = 30,
  breakBetween = 0,
  defaultTz = DEFAULT_TIMEZONE,
  includeOnline = true,
}) {
  const out = [];
  if (!dayTemplate || !dayTemplate.isWorking) return out;
  if (!Number.isFinite(slotDuration) || slotDuration <= 0) return out;
  const buffer = Number.isFinite(breakBetween) && breakBetween > 0 ? breakBetween : 0;

  for (const [mode, slotType] of [
    ['online', 'video'],
    ['onsite', 'in-clinic'],
  ]) {
    if (mode === 'online' && !includeOnline) continue;
    const block = dayTemplate[mode];
    if (!block || !block.enabled || !Array.isArray(block.ranges)) continue;

    for (const range of block.ranges) {
      const start = toMinutes(range?.startTime);
      const end = toMinutes(range?.endTime);
      if (start === null || end === null || start >= end) continue;

      const clinicId = resolveRangeClinic(range, block);
      const clinic = clinicId ? clinicsById.get(String(clinicId)) : null;
      // A range still pointing at a clinic that was deleted or deactivated
      // must stop publishing slots there, not keep sending patients to it.
      if (clinicId && !clinic) continue;
      const tz = safeZone(clinic?.timezone || defaultTz);

      for (let cur = start; cur + slotDuration <= end; cur += slotDuration + buffer) {
        const startTime = fromMinutes(cur);
        const endTime = fromMinutes(cur + slotDuration);
        const startUtc = localToUtc(dateKey, startTime, tz);
        const endUtc = localToUtc(dateKey, endTime, tz);
        // localToUtc returns null rather than guessing; a slot with no instant
        // is unusable, so skip it instead of storing something wrong.
        if (!startUtc || !endUtc) continue;

        out.push({
          clinicId: clinicId || null,
          date: localToUtc(dateKey, '00:00', tz),
          dateKey,
          startTime,
          endTime,
          startUtc,
          endUtc,
          clinicTimezone: tz,
          type: slotType,
          status: 'available',
          source: 'template',
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
  SLOT_DURATION_MIN,
  SLOT_DURATION_MAX,
  resolveRangeClinic,
  resolveDoctorTimezone,
  validateSettings,
  validateWeeklyAvailability,
  ownedClinicIds,
  expandDay,
};
