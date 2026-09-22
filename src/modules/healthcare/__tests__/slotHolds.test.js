/**
 * Holding and releasing the slots that share an instant.
 *
 * A doctor offering 10:00 both in clinic and over video has TWO slot documents
 * at that instant — the unique index is keyed on `type` precisely to allow it.
 * Booking has always taken the twin off the market; CLOSING did not, so a
 * patient could still book the video slot at an hour the doctor had explicitly
 * closed. In-clinic never showed the bug, because it has no same-type twin.
 *
 * No DB: the model is mocked and the queries are what is under test.
 */
jest.mock('../models/Slot', () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  updateOne: jest.fn(),
  updateMany: jest.fn(),
}));
const Slot = require('../models/Slot');
const slotService = require('../services/slotService');

const DOCTOR = '6500000000000000000000a1';
const IN_CLINIC = { _id: 'slot-inclinic', doctorId: DOCTOR, startUtc: new Date('2026-09-20T05:00:00Z'), endUtc: new Date('2026-09-20T05:30:00Z') };

/** `Slot.findOne(...)` with the chain the service uses. */
const findOneResolves = (value) => {
  Slot.findOne.mockReturnValue({
    select: () => ({ session: () => ({ lean: async () => value }) }),
  });
};

beforeEach(() => {
  Slot.findOne.mockReset();
  Slot.find.mockReset();
  Slot.updateOne.mockReset();
  Slot.updateMany.mockReset();
});

describe('holdOverlapping', () => {
  it('takes every open, unbooked overlapping slot off the market', async () => {
    Slot.updateMany.mockResolvedValue({ modifiedCount: 1 });

    const held = await slotService.holdOverlapping(IN_CLINIC);

    expect(held).toBe(1);
    const [filter, update] = Slot.updateMany.mock.calls[0];
    // The twin, not this slot: overlapping in time, excluding itself.
    expect(filter._id).toEqual({ $ne: IN_CLINIC._id });
    expect(filter.doctorId).toBe(DOCTOR);
    expect(filter.startUtc).toEqual({ $lt: IN_CLINIC.endUtc });
    expect(filter.endUtc).toEqual({ $gt: IN_CLINIC.startUtc });
    // Only slots nothing else has a claim on.
    expect(filter.status).toBe('available');
    expect(filter.bookedCount).toBe(0);
    expect(update.$set).toEqual({ status: 'held', heldBy: IN_CLINIC._id });
  });

  it('does nothing for a slot with no instants to compare', async () => {
    expect(await slotService.holdOverlapping({ ...IN_CLINIC, startUtc: null })).toBe(0);
    expect(Slot.updateMany).not.toHaveBeenCalled();
  });
});

describe('hasOverlappingEngagement', () => {
  it('counts a blocked overlapping slot, not just a booked one', async () => {
    findOneResolves({ _id: 'other' });

    const result = await slotService.hasOverlappingEngagement(IN_CLINIC);

    expect(result).toBe('other');
    const [filter] = Slot.findOne.mock.calls[0];
    // Either kind of engagement means the doctor is taken at that instant.
    expect(filter.$or).toEqual([{ bookedCount: { $gt: 0 } }, { status: 'blocked' }]);
  });

  it('is false when nothing overlaps', async () => {
    findOneResolves(null);
    expect(await slotService.hasOverlappingEngagement(IN_CLINIC)).toBe(false);
  });
});

describe('releaseHolds', () => {
  const twin = {
    _id: 'slot-video',
    doctorId: DOCTOR,
    startUtc: IN_CLINIC.startUtc,
    endUtc: IN_CLINIC.endUtc,
  };

  const heldByThisSlot = () => {
    Slot.find.mockReturnValue({
      select: () => ({ session: () => ({ lean: async () => [twin] }) }),
    });
  };

  it('reopens the twin once nothing else is engaged at that instant', async () => {
    heldByThisSlot();
    findOneResolves(null); // no other booking or block overlaps
    Slot.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await slotService.releaseHolds(IN_CLINIC);

    const [filter, update] = Slot.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: twin._id, status: 'held' });
    expect(update.$set).toEqual({ status: 'available', heldBy: null });
  });

  it('keeps the twin held when a SECOND closure still covers that instant', async () => {
    heldByThisSlot();
    findOneResolves({ _id: 'other-blocked-slot' });
    Slot.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await slotService.releaseHolds(IN_CLINIC);

    const [, update] = Slot.updateOne.mock.calls[0];
    // Re-pointed at whatever still holds it, NOT reopened — otherwise two
    // overlapping closures would each reopen the other's twin.
    expect(update.$set).toEqual({ heldBy: 'other-blocked-slot' });
  });
});
