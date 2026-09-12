/**
 * "First accept wins" — a customer may send one job to several providers, and
 * the first provider to accept keeps it while the rest are released.
 *
 * No DB: the Booking model is mocked, and bookings are stubs with a save()
 * spy, exactly as in stateMachine.test.js.
 */
jest.mock('../models/Booking', () => ({ find: jest.fn() }));

const Booking = require('../models/Booking');
const { transition, releaseCompetingRequests } = require('../services/bookingService');
const { STATUS, ACTIVE_STATUSES, TERMINAL_STATUSES } = require('../services/statusMap');

const CUSTOMER_ID = 'cust-1';

function makeBooking(overrides = {}) {
  return {
    _id: 'bk-rival',
    status: STATUS.PENDING,
    customer: CUSTOMER_ID,
    provider: { _id: 'prov-2', fullName: 'Ahmad Khan' },
    serviceCategory: 'electricians',
    statusHistory: [],
    work: {},
    cancellation: {},
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// find().populate().populate() — the chain releaseCompetingRequests uses.
function mockRivals(rivals) {
  const chain = {
    populate: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(rivals).then(resolve, reject),
  };
  Booking.find.mockReturnValue(chain);
  return chain;
}

const winner = () =>
  makeBooking({
    _id: 'bk-winner',
    status: STATUS.ACCEPTED,
    provider: { _id: 'prov-1', fullName: 'Usman Tariq' },
  });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ACTIVE_STATUSES', () => {
  it('is every non-terminal status', () => {
    expect(ACTIVE_STATUSES).toEqual(
      expect.arrayContaining([
        STATUS.PENDING,
        STATUS.ACCEPTED,
        STATUS.EN_ROUTE,
        STATUS.ARRIVED,
        STATUS.IN_PROGRESS,
      ])
    );
    TERMINAL_STATUSES.forEach((s) => expect(ACTIVE_STATUSES).not.toContain(s));
  });
});

describe('releaseCompetingRequests', () => {
  it('cancels the customer\'s other PENDING requests for the same job', async () => {
    const rival = makeBooking();
    mockRivals([rival]);

    const released = await releaseCompetingRequests(winner());

    expect(released).toEqual(['bk-rival']);
    expect(rival.status).toBe(STATUS.CANCELLED);
    expect(rival.save).toHaveBeenCalled();
  });

  it('scopes the query to this customer, this category, PENDING only', async () => {
    mockRivals([]);

    await releaseCompetingRequests(winner());

    expect(Booking.find).toHaveBeenCalledWith({
      _id: { $ne: 'bk-winner' },
      customer: CUSTOMER_ID,
      serviceCategory: 'electricians',
      status: STATUS.PENDING,
    });
  });

  it('records the cancellation as the system\'s, with a reason', async () => {
    const rival = makeBooking();
    mockRivals([rival]);

    await releaseCompetingRequests(winner());

    expect(rival.cancellation.by).toBe('system');
    expect(rival.cancellation.reason).toMatch(/Usman Tariq/);
    expect(rival.statusHistory[0].changedBy.role).toBe('system');
  });

  it('releases every rival even when one of them fails', async () => {
    const broken = makeBooking({ _id: 'bk-broken', status: STATUS.COMPLETED });
    const fine = makeBooking({ _id: 'bk-fine' });
    mockRivals([broken, fine]);

    const released = await releaseCompetingRequests(winner());

    expect(released).toEqual(['bk-fine']);
    expect(fine.status).toBe(STATUS.CANCELLED);
  });
});

describe('system cancellation rules', () => {
  it('is refused without a reason', async () => {
    const b = makeBooking();
    await expect(
      transition(b, STATUS.CANCELLED, { id: null, role: 'system' })
    ).rejects.toThrow(/reason/i);
    expect(b.status).toBe(STATUS.PENDING);
  });

  it('cannot reach past the customer cancellation window', async () => {
    const b = makeBooking({ status: STATUS.IN_PROGRESS });
    await expect(
      transition(b, STATUS.CANCELLED, { id: null, role: 'system' }, { reason: 'superseded' })
    ).rejects.toThrow();
    expect(b.status).toBe(STATUS.IN_PROGRESS);
  });

  it('still refuses a provider cancelling', async () => {
    const b = makeBooking();
    await expect(
      transition(b, STATUS.CANCELLED, { id: 'prov-2', role: 'provider' }, { reason: 'busy' })
    ).rejects.toThrow(/customer/i);
  });
});
