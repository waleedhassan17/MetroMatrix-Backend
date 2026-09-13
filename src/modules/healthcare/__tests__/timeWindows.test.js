/**
 * Calendar-day windows in a clinic's zone. Pure — no DB.
 */
const {
  isDateKey,
  dayWindow,
  paddedRange,
  startOfWeekKey,
  startOfMonthKey,
  addMonthsKey,
  daysBetween,
  fromMinutes,
} = require('../../../utils/time');

describe('isDateKey', () => {
  it('accepts a real calendar day', () => {
    expect(isDateKey('2026-09-01')).toBe(true);
  });
  it('rejects impossible and loosely formatted dates', () => {
    expect(isDateKey('2026-02-30')).toBe(false);
    expect(isDateKey('2026-9-1')).toBe(false);
    expect(isDateKey('abc')).toBe(false);
    expect(isDateKey(null)).toBe(false);
  });
});

describe('dayWindow', () => {
  it('is the Karachi day, not the server day', () => {
    const w = dayWindow('2026-09-15', 'Asia/Karachi');
    expect(w.from.toISOString()).toBe('2026-09-14T19:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-09-15T19:00:00.000Z');
  });
  it('returns null for an invalid key', () => {
    expect(dayWindow('2026-13-01')).toBeNull();
  });
});

describe('paddedRange', () => {
  it('pads the instant range by 14h and bounds dateKey exactly', () => {
    const r = paddedRange('2026-09-15', '2026-09-17', 'Asia/Karachi');
    expect(r.dateKey).toEqual({ $gte: '2026-09-15', $lte: '2026-09-17' });
    expect(r.startUtc.$gte.toISOString()).toBe('2026-09-14T05:00:00.000Z');
    expect(r.startUtc.$lt.toISOString()).toBe('2026-09-18T09:00:00.000Z');
  });
  it('defaults to a single day', () => {
    expect(paddedRange('2026-09-15').dateKey).toEqual({ $gte: '2026-09-15', $lte: '2026-09-15' });
  });
  it('rejects a reversed or invalid range', () => {
    expect(paddedRange('2026-09-17', '2026-09-15')).toBeNull();
    expect(paddedRange('nope', '2026-09-15')).toBeNull();
  });
});

describe('week and month keys', () => {
  it('Monday-start week (2026-09-17 is a Thursday)', () => {
    expect(startOfWeekKey('2026-09-17')).toBe('2026-09-14');
    expect(startOfWeekKey('2026-09-20')).toBe('2026-09-14'); // Sunday belongs to the week before
    expect(startOfWeekKey('2026-09-14')).toBe('2026-09-14');
  });
  it('Sunday-start week', () => {
    expect(startOfWeekKey('2026-09-17', 'Asia/Karachi', 0)).toBe('2026-09-13');
  });
  it('month start and month arithmetic', () => {
    expect(startOfMonthKey('2026-09-17')).toBe('2026-09-01');
    expect(addMonthsKey('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsKey('2026-01-15', -1)).toBe('2025-12-15');
  });
  it('days between keys', () => {
    expect(daysBetween('2026-09-01', '2026-09-15')).toBe(14);
    expect(daysBetween('2026-09-15', '2026-09-01')).toBe(-14);
  });
});

describe('fromMinutes', () => {
  it('formats minutes as HH:mm', () => {
    expect(fromMinutes(0)).toBe('00:00');
    expect(fromMinutes(9 * 60 + 7)).toBe('09:07');
    expect(fromMinutes(23 * 60 + 59)).toBe('23:59');
  });
});
