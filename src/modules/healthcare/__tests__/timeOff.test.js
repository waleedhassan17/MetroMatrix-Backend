/**
 * Time-off input rules. Pure — no DB.
 */
const {
  validateTimeOffInput,
  rangesOverlap,
  mergeConsecutiveDays,
  sameIdSet,
  MAX_SPAN_DAYS,
} = require('../services/timeOffService');

const today = '2026-09-14';

describe('validateTimeOffInput', () => {
  it('accepts a future range and trims the reason', () => {
    expect(validateTimeOffInput({ from: '2026-09-20', to: '2026-09-22', reason: '  Conference ' }, today)).toEqual({
      from: '2026-09-20',
      to: '2026-09-22',
      reason: 'Conference',
    });
  });

  it('treats a missing end date as a single day', () => {
    expect(validateTimeOffInput({ from: '2026-09-20' }, today).to).toBe('2026-09-20');
  });

  it.each([
    [{ from: '2026-09-13', to: '2026-09-15' }, 'past'],
    [{ from: '2026-09-22', to: '2026-09-20' }, 'on or after'],
    [{ from: '2026-09-20', to: '2027-12-01' }, 'days ahead'],
    [{ from: '2026-09-20', to: '2027-01-01' }, `${MAX_SPAN_DAYS} days`],
    [{ from: 'soon', to: '2026-09-20' }, 'start and an end'],
    [{ from: '2026-09-20', reason: 'x'.repeat(201) }, 'reason'],
  ])('rejects %j', (input, message) => {
    expect(() => validateTimeOffInput(input, today)).toThrow(message);
  });
});

describe('helpers', () => {
  it('rangesOverlap compares inclusive date keys', () => {
    expect(rangesOverlap({ from: '2026-09-20', to: '2026-09-22' }, { from: '2026-09-22', to: '2026-09-25' })).toBe(true);
    expect(rangesOverlap({ from: '2026-09-20', to: '2026-09-21' }, { from: '2026-09-22', to: '2026-09-25' })).toBe(false);
  });

  it('mergeConsecutiveDays collapses runs, across a month boundary', () => {
    expect(mergeConsecutiveDays(['2026-09-30', '2026-10-01', '2026-10-03', '2026-09-30', 'bad'])).toEqual([
      { from: '2026-09-30', to: '2026-10-01' },
      { from: '2026-10-03', to: '2026-10-03' },
    ]);
  });

  it('sameIdSet ignores order and type, but not membership', () => {
    expect(sameIdSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameIdSet(['a'], ['a', 'b'])).toBe(false);
    expect(sameIdSet([], [])).toBe(true);
  });
});
