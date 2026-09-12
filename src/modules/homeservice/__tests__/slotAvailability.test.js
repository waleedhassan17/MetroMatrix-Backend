/**
 * Booking-form slot availability (Bug fix: a booked date+time must show as
 * unavailable when the same provider's "Book a visit" screen is reopened).
 *
 * No DB: Booking.find is mocked, exactly as in competingRequests.test.js.
 */
jest.mock('../models/Booking', () => ({ find: jest.fn() }));

const Booking = require('../models/Booking');
const { buildTimeSlots, bookedSlotTimes } = require('../controllers/bookingController');
const { STATUS } = require('../services/statusMap');

function mockFind(bookings) {
  Booking.find.mockReturnValue({
    select: jest.fn().mockResolvedValue(bookings),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('buildTimeSlots', () => {
  it('marks every slot available with no booked times', () => {
    const slots = buildTimeSlots();
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((s) => s.available)).toBe(true);
  });

  it('marks only the booked slot unavailable', () => {
    const slots = buildTimeSlots(new Set(['02:00 PM']));
    const booked = slots.find((s) => s.time === '02:00 PM');
    const free = slots.find((s) => s.time === '09:00 AM');
    expect(booked.available).toBe(false);
    expect(free.available).toBe(true);
  });
});

describe('bookedSlotTimes', () => {
  it('returns an empty set when no date is given', async () => {
    const result = await bookedSlotTimes('prov-1', undefined);
    expect(result).toEqual(new Set());
    expect(Booking.find).not.toHaveBeenCalled();
  });

  it('collects the scheduledTime of every live booking on that date', async () => {
    mockFind([{ scheduledTime: '02:00 PM' }, { scheduledTime: '05:00 PM' }]);

    const result = await bookedSlotTimes('prov-1', '2026-03-05');

    expect(result).toEqual(new Set(['02:00 PM', '05:00 PM']));
  });

  it('scopes the query to this provider, active statuses, and the calendar day', async () => {
    mockFind([]);

    await bookedSlotTimes('prov-1', '2026-03-05');

    expect(Booking.find).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'prov-1',
        status: {
          $in: expect.arrayContaining([STATUS.PENDING, STATUS.ACCEPTED]),
        },
      })
    );
    const query = Booking.find.mock.calls[0][0];
    expect(query.status.$in).not.toContain(STATUS.CANCELLED);
    expect(query.status.$in).not.toContain(STATUS.REJECTED);
    expect(query.status.$in).not.toContain(STATUS.COMPLETED);

    // PKT midnight to PKT midnight the next day, as a UTC instant.
    expect(query.scheduledFor.$gte.toISOString()).toBe('2026-03-04T19:00:00.000Z');
    expect(query.scheduledFor.$lt.toISOString()).toBe('2026-03-05T19:00:00.000Z');
  });
});
