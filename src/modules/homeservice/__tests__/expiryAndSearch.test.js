/**
 * Request expiry (services/expiryService.js) and provider-search input
 * handling (controllers/providerSearchController.js). Models and realtime
 * mocked — no DB.
 */
jest.mock('../models/Booking', () => ({ find: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/HSNotification', () => ({ insertMany: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../sockets', () => ({ emitToBooking: jest.fn().mockResolvedValue(true) }));

const Booking = require('../models/Booking');
const HSNotification = require('../models/HSNotification');
const { emitToBooking } = require('../../../sockets');
const { expireStale, RULES } = require('../services/expiryService');
const { escapeRegex, buildPipeline } = require('../controllers/providerSearchController');
const { STATUS } = require('../services/statusMap');

/** A chainable query stub resolving to `value` on .lean(). */
function query(value) {
  const q = {
    select: () => q,
    populate: () => q,
    limit: () => q,
    sort: () => q,
    lean: () => Promise.resolve(value),
  };
  return q;
}

const NOW = new Date('2026-09-27T06:00:00.000Z');
const stalePending = {
  _id: 'b1',
  customer: { _id: 'c1', fullName: 'Sarah Malik' },
  provider: { _id: 'p1', fullName: 'Ahmad Khan' },
  serviceSubCategory: 'Electrician',
  scheduledFor: new Date('2026-07-20T09:00:00.000Z'),
  scheduledTime: '02:00 PM',
};

beforeEach(() => {
  jest.clearAllMocks();
  Booking.updateMany.mockResolvedValue({ modifiedCount: 1 });
});

describe('expireStale', () => {
  function queue(...results) {
    results.forEach((r) => Booking.find.mockReturnValueOnce(query(r)));
  }

  it('closes a PENDING request past its time, conditionally, with a machine-readable cause', async () => {
    // rule 1 candidates, rule 1 closed rows, rule 2 candidates
    queue([stalePending], [{ _id: 'b1' }], []);
    const closed = await expireStale({ provider: 'p1' }, NOW);
    expect(closed).toBe(1);

    const [filter, update] = Booking.updateMany.mock.calls[0];
    // Only if it is STILL pending — an accept in the same instant wins.
    expect(filter).toEqual({ _id: { $in: ['b1'] }, status: STATUS.PENDING });
    expect(update.$set.status).toBe(STATUS.CANCELLED);
    expect(update.$set.cancellation).toMatchObject({ by: 'system', code: 'expired_pending' });
    expect(update.$push.statusHistory).toMatchObject({ status: STATUS.CANCELLED, changedBy: { role: 'system' } });
    expect(update.$inc).toEqual({ __v: 1 });
  });

  it('the candidate query is scoped and uses the rule\'s grace period', async () => {
    queue([], []);
    await expireStale({ customer: 'c1' }, NOW);
    const pendingQuery = Booking.find.mock.calls[0][0];
    expect(pendingQuery.customer).toBe('c1');
    expect(pendingQuery.status).toBe(STATUS.PENDING);
    expect(pendingQuery.scheduledFor.$lt.getTime()).toBe(NOW.getTime() - RULES[0].graceMs);
    const acceptedQuery = Booking.find.mock.calls[1][0];
    expect(acceptedQuery.status).toBe(STATUS.ACCEPTED);
    expect(acceptedQuery.scheduledFor.$lt.getTime()).toBe(NOW.getTime() - 24 * 60 * 60 * 1000);
  });

  it('tells both people, in words, and updates anyone watching the booking', async () => {
    queue([stalePending], [{ _id: 'b1' }], []);
    await expireStale({}, NOW);
    const rows = HSNotification.insertMany.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    const toCustomer = rows.find((r) => r.recipientRole === 'user');
    const toProvider = rows.find((r) => r.recipientRole === 'provider');
    expect(toCustomer.title).toBe('Request expired');
    expect(toCustomer.message).toMatch(/Ahmad Khan didn't respond/);
    expect(toProvider.message).toMatch(/expired before you responded/);
    expect(emitToBooking).toHaveBeenCalledWith('b1', 'booking_status_changed', expect.objectContaining({ status: STATUS.CANCELLED }));
  });

  it('notifies only about rows it actually closed (a row accepted meanwhile is left alone)', async () => {
    queue([stalePending, { ...stalePending, _id: 'b2' }], [{ _id: 'b1' }], []);
    const closed = await expireStale({}, NOW);
    expect(closed).toBe(1);
    expect(HSNotification.insertMany.mock.calls[0][0].every((r) => r.data.bookingId === 'b1')).toBe(true);
  });

  it('announce:false closes quietly — for clearing an old backlog', async () => {
    queue([stalePending], [{ _id: 'b1' }], []);
    const closed = await expireStale({}, NOW, { announce: false });
    expect(closed).toBe(1);
    expect(HSNotification.insertMany).not.toHaveBeenCalled();
    expect(emitToBooking).not.toHaveBeenCalled();
  });

  it('never throws — a list request must not fail because tidying up did', async () => {
    Booking.find.mockImplementationOnce(() => {
      throw new Error('db down');
    });
    await expect(expireStale({}, NOW)).resolves.toBe(0);
  });
});

describe('provider search input', () => {
  it('escapes regex syntax typed by a customer', () => {
    expect(escapeRegex('(a+b)*')).toBe('\\(a\\+b\\)\\*');
    expect(() => new RegExp(escapeRegex('('))).not.toThrow();
    expect(new RegExp(escapeRegex('c++'), 'i').test('C++ wiring')).toBe(true);
  });

  const base = {
    centre: [74.35, 31.52],
    radiusMeters: 15000,
    match: { providerType: 'home_service' },
    weights: { distance: 0.4, rating: 0.4, availability: 0.2 },
    sortBy: undefined,
    pageN: 1,
    limitN: 15,
  };

  it('with a real customer location, each provider\'s own service radius applies', () => {
    const pipeline = buildPipeline({ ...base, hasLocation: true });
    expect(pipeline[0].$geoNear.near.coordinates).toEqual([74.35, 31.52]);
    expect(JSON.stringify(pipeline[1])).toMatch(/serviceRadius/);
  });

  it('without a location, distance neither filters nor ranks', () => {
    const pipeline = buildPipeline({ ...base, hasLocation: false, sortBy: 'distance' });
    expect(JSON.stringify(pipeline)).not.toMatch(/serviceRadius/);
    const sortStage = pipeline.find((s) => s.$sort);
    expect(sortStage.$sort.distanceMeters).toBeUndefined();
  });
});
