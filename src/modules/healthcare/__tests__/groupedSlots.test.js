/**
 * The day window patient slot discovery uses.
 *
 * `getGroupedSlots` used to bound the `date` field with
 * `new Date(date).setHours(0,0,0,0)`, which asks the SERVER what midnight is.
 * On Vercel that is UTC, while a Karachi clinic's day starts at 19:00Z the
 * evening before and generated slots store `date` at clinic midnight — so a day
 * that availability-summary correctly reported as bookable came back empty,
 * and the patient saw "No Slots Available" on a date the strip had just marked
 * as available.
 *
 * These assertions pin the window to the clinic's calendar day. No DB: the
 * model is mocked and the query itself is the thing under test.
 */
const mongoose = require('mongoose');

jest.mock('../models/Slot', () => ({ find: jest.fn() }));
const Slot = require('../models/Slot');
const slotService = require('../services/slotService');

const DOCTOR_ID = '6500000000000000000000a1';

/** Run getGroupedSlots against an empty result and return the query it built. */
async function queryFor(filters) {
  Slot.find.mockReturnValue({
    populate: () => ({ sort: () => ({ lean: async () => [] }) }),
  });
  await slotService.getGroupedSlots(DOCTOR_ID, filters);
  return Slot.find.mock.calls[Slot.find.mock.calls.length - 1][0];
}

beforeEach(() => {
  Slot.find.mockReset();
});

describe('getGroupedSlots day window', () => {
  it('bounds the clinic calendar day, not the server day', async () => {
    const query = await queryFor({ date: '2026-09-15', tz: 'Asia/Karachi' });

    // The naive window filtered on `date` directly. Nothing should any more.
    expect(query.date).toBeUndefined();

    const [dayWindow] = query.$and;
    const [backfilled, legacy] = dayWindow.$or;

    // Backfilled rows are found by their own clinic-zone day...
    expect(backfilled.dateKey).toEqual({ $gte: '2026-09-15', $lte: '2026-09-15' });
    // ...with a padded instant bound so the {doctorId, startUtc} index is usable.
    expect(backfilled.startUtc.$gte.toISOString()).toBe('2026-09-14T05:00:00.000Z');
    expect(backfilled.startUtc.$lt.toISOString()).toBe('2026-09-16T09:00:00.000Z');

    // Rows predating `dateKey` fall back to the exact Karachi day: 19:00Z the
    // evening before, through 19:00Z on the day itself.
    expect(legacy.dateKey).toBeNull();
    expect(legacy.startUtc.$gte.toISOString()).toBe('2026-09-14T19:00:00.000Z');
    expect(legacy.startUtc.$lt.toISOString()).toBe('2026-09-15T19:00:00.000Z');
  });

  it('does not reach into the neighbouring days', async () => {
    const before = await queryFor({ date: '2026-09-14', tz: 'Asia/Karachi' });
    const after = await queryFor({ date: '2026-09-16', tz: 'Asia/Karachi' });

    expect(before.$and[0].$or[0].dateKey).toEqual({ $gte: '2026-09-14', $lte: '2026-09-14' });
    expect(after.$and[0].$or[0].dateKey).toEqual({ $gte: '2026-09-16', $lte: '2026-09-16' });
  });

  it('still excludes slots that have already started', async () => {
    const query = await queryFor({ date: '2026-09-15', tz: 'Asia/Karachi' });
    const [, futureOnly] = query.$and;

    expect(futureOnly.$or[0].startUtc.$gt).toBeInstanceOf(Date);
    // Pre-backfill rows have no instant to compare and stay visible.
    expect(futureOnly.$or[1]).toEqual({ startUtc: null });
  });

  it('filters by type and clinic when asked', async () => {
    const clinicId = '6500000000000000000000b2';
    const query = await queryFor({
      date: '2026-09-15',
      tz: 'Asia/Karachi',
      type: 'in-clinic',
      clinicId,
    });

    expect(query.type).toBe('in-clinic');
    expect(String(query.clinicId)).toBe(clinicId);
    expect(String(query.doctorId)).toBe(DOCTOR_ID);
    expect(query.status).toBe('available');
  });

  it('answers a date that is not a real day without querying', async () => {
    // The route validates YYYY-MM-DD, which '2026-02-30' satisfies.
    Slot.find.mockReturnValue({
      populate: () => ({ sort: () => ({ lean: async () => [] }) }),
    });
    await expect(
      slotService.getGroupedSlots(DOCTOR_ID, { date: '2026-02-30' })
    ).resolves.toEqual([]);
    expect(Slot.find).not.toHaveBeenCalled();
  });
});

afterAll(async () => {
  await mongoose.disconnect().catch(() => {});
});
