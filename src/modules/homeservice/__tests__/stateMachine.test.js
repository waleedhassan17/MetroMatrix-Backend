/**
 * HS1 booking state machine — every legal transition, illegal moves, and
 * actor-rule violations (no DB; bookings are stubs with a save() spy).
 */
const { transition, StatusError } = require('../services/bookingService');
const { STATUS, ALLOWED_TRANSITIONS, toJobBucket, toBookingStatus } = require('../services/statusMap');

const PROVIDER_ID = 'prov-1';
const OTHER_PROVIDER = 'prov-2';
const CUSTOMER_ID = 'cust-1';
const ADMIN_ID = 'admin-1';

const provider = { id: PROVIDER_ID, role: 'provider' };
const customer = { id: CUSTOMER_ID, role: 'customer' };
const admin = { id: ADMIN_ID, role: 'admin' };

function makeBooking(status) {
  return {
    _id: 'bk-1',
    status,
    provider: PROVIDER_ID,
    customer: CUSTOMER_ID,
    statusHistory: [],
    work: {},
    cancellation: {},
    save: jest.fn().mockResolvedValue(undefined),
  };
}

function actorFor(next) {
  return next === STATUS.CANCELLED ? customer : provider;
}

describe('every legal transition succeeds', () => {
  Object.entries(ALLOWED_TRANSITIONS).forEach(([from, tos]) => {
    tos.forEach((to) => {
      it(`${from} → ${to}`, async () => {
        const b = makeBooking(from);
        await transition(b, to, actorFor(to));
        expect(b.status).toBe(to);
        expect(b.statusHistory).toHaveLength(1);
        expect(b.statusHistory[0].status).toBe(to);
        expect(b.save).toHaveBeenCalled();
      });
    });
  });
});

describe('illegal transitions throw 400', () => {
  const illegal = [
    [STATUS.PENDING, STATUS.IN_PROGRESS],
    [STATUS.PENDING, STATUS.COMPLETED],
    [STATUS.ACCEPTED, STATUS.ARRIVED],
    [STATUS.ACCEPTED, STATUS.COMPLETED],
    [STATUS.EN_ROUTE, STATUS.IN_PROGRESS],
    [STATUS.ARRIVED, STATUS.COMPLETED],
    [STATUS.IN_PROGRESS, STATUS.CANCELLED],
    [STATUS.COMPLETED, STATUS.IN_PROGRESS],
    [STATUS.CANCELLED, STATUS.ACCEPTED],
    [STATUS.REJECTED, STATUS.ACCEPTED],
    [STATUS.COMPLETED, STATUS.CANCELLED],
  ];
  illegal.forEach(([from, to]) => {
    it(`${from} → ${to} rejected`, async () => {
      const b = makeBooking(from);
      await expect(transition(b, to, actorFor(to))).rejects.toThrow(StatusError);
      expect(b.status).toBe(from);
      expect(b.save).not.toHaveBeenCalled();
    });
  });
});

describe('actor rules', () => {
  it('customer cannot ACCEPT', async () => {
    const b = makeBooking(STATUS.PENDING);
    await expect(transition(b, STATUS.ACCEPTED, customer)).rejects.toThrow(/provider/i);
  });

  // The customer MAY confirm completion of their own job once a provider has
  // committed to it (commit a56f1b1) — this used to assert the opposite and
  // had been failing ever since.
  it('the booking\'s own customer CAN confirm completion once work is under way', async () => {
    const b = makeBooking(STATUS.IN_PROGRESS);
    await transition(b, STATUS.COMPLETED, customer);
    expect(b.status).toBe(STATUS.COMPLETED);
    expect(b.statusHistory[0].changedBy.role).toBe('customer');
  });

  it('a DIFFERENT customer cannot complete someone else\'s booking', async () => {
    const b = makeBooking(STATUS.IN_PROGRESS);
    const err = await transition(b, STATUS.COMPLETED, { id: 'cust-2', role: 'customer' }).catch((e) => e);
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(403);
  });

  it('nobody can complete a job no provider has accepted', async () => {
    const b = makeBooking(STATUS.PENDING);
    await expect(transition(b, STATUS.COMPLETED, customer)).rejects.toThrow(StatusError);
    expect(b.save).not.toHaveBeenCalled();
  });

  it('provider cannot CANCEL', async () => {
    const b = makeBooking(STATUS.ACCEPTED);
    await expect(transition(b, STATUS.CANCELLED, provider)).rejects.toThrow(/customer/i);
  });

  it('a DIFFERENT provider gets 403 on another provider\'s job', async () => {
    const b = makeBooking(STATUS.PENDING);
    const err = await transition(b, STATUS.ACCEPTED, { id: OTHER_PROVIDER, role: 'provider' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/not the assigned provider/i);
  });

  it('the ASSIGNED provider succeeds even when booking.provider is a populated doc (regression: loadBookingWithAccess populates it, String(doc) !== the id string)', async () => {
    const b = makeBooking(STATUS.PENDING);
    b.provider = { _id: PROVIDER_ID, fullName: 'Populated Provider Doc' };
    await transition(b, STATUS.ACCEPTED, provider);
    expect(b.status).toBe(STATUS.ACCEPTED);
  });

  it('a different provider still gets 403 when booking.provider is a populated doc', async () => {
    const b = makeBooking(STATUS.PENDING);
    b.provider = { _id: PROVIDER_ID, fullName: 'Populated Provider Doc' };
    const err = await transition(b, STATUS.ACCEPTED, { id: OTHER_PROVIDER, role: 'provider' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(403);
  });

  it('customer cannot cancel once IN_PROGRESS', async () => {
    const b = makeBooking(STATUS.IN_PROGRESS);
    // IN_PROGRESS → CANCELLED is not in ALLOWED_TRANSITIONS at all, so the
    // generic illegal-transition guard fires first — same outcome, 400.
    await expect(transition(b, STATUS.CANCELLED, customer)).rejects.toThrow(
      /Illegal transition IN_PROGRESS/
    );
  });

  it('customer CAN cancel while EN_ROUTE', async () => {
    const b = makeBooking(STATUS.EN_ROUTE);
    await transition(b, STATUS.CANCELLED, customer, { reason: 'changed my mind' });
    expect(b.status).toBe(STATUS.CANCELLED);
    expect(b.cancellation.by).toBe('customer');
  });
});

describe('admin force-transitions', () => {
  it('admin may force an otherwise-illegal move, recorded with id + reason', async () => {
    const b = makeBooking(STATUS.COMPLETED);
    await transition(b, STATUS.CANCELLED, admin, { reason: 'dispute upheld' });
    expect(b.status).toBe(STATUS.CANCELLED);
    const h = b.statusHistory[0];
    expect(h.changedBy.id).toBe(ADMIN_ID);
    expect(h.changedBy.role).toBe('admin');
    expect(h.note).toMatch(/FORCED: dispute upheld/);
  });

  it('admin force without a reason is rejected', async () => {
    const b = makeBooking(STATUS.COMPLETED);
    await expect(transition(b, STATUS.CANCELLED, admin)).rejects.toThrow(/reason/i);
  });
});

describe('work timestamps', () => {
  it('IN_PROGRESS stamps work.startedAt; COMPLETED stamps endedAt + duration', async () => {
    const b = makeBooking(STATUS.ARRIVED);
    await transition(b, STATUS.IN_PROGRESS, provider);
    expect(b.work.startedAt).toBeInstanceOf(Date);
    b.work.startedAt = new Date(Date.now() - 45 * 60000);
    await transition(b, STATUS.COMPLETED, provider);
    expect(b.work.endedAt).toBeInstanceOf(Date);
    expect(b.work.actualDurationMinutes).toBeGreaterThanOrEqual(44);
  });
});

describe('display mappings derive from the canonical status', () => {
  it('job buckets', () => {
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86400000);
    expect(toJobBucket(STATUS.PENDING, today)).toBe('available');
    expect(toJobBucket(STATUS.ACCEPTED, today)).toBe('today');
    expect(toJobBucket(STATUS.ACCEPTED, tomorrow)).toBe('upcoming');
    expect(toJobBucket(STATUS.EN_ROUTE, today)).toBe('active');
    expect(toJobBucket(STATUS.IN_PROGRESS, today)).toBe('active');
    expect(toJobBucket(STATUS.COMPLETED, today)).toBe('completed');
    expect(toJobBucket(STATUS.REJECTED, today)).toBe('cancelled');
  });

  it('customer booking statuses', () => {
    expect(toBookingStatus(STATUS.PENDING)).toBe('pending');
    expect(toBookingStatus(STATUS.EN_ROUTE)).toBe('confirmed');
    expect(toBookingStatus(STATUS.ARRIVED)).toBe('confirmed');
    expect(toBookingStatus(STATUS.IN_PROGRESS)).toBe('in_progress');
    expect(toBookingStatus(STATUS.COMPLETED)).toBe('completed');
    expect(toBookingStatus(STATUS.CANCELLED)).toBe('cancelled');
  });
});

describe('concurrent writers — the second one loses cleanly', () => {
  it('saves with the status it read as a precondition', async () => {
    const b = makeBooking(STATUS.PENDING);
    let whereAtSave;
    b.save = jest.fn().mockImplementation(async () => {
      whereAtSave = { ...b.$where };
    });
    await transition(b, STATUS.ACCEPTED, provider);
    expect(whereAtSave).toEqual({ status: STATUS.PENDING });
    // cleared afterwards, so a later save of the same document is not pinned
    expect(b.$where.status).toBeUndefined();
  });

  it('a booking that moved on meanwhile (no document matched) is a 409, not a success', async () => {
    const b = makeBooking(STATUS.PENDING);
    const notFound = Object.assign(new Error('No document found'), { name: 'DocumentNotFoundError' });
    b.save = jest.fn().mockRejectedValue(notFound);
    const err = await transition(b, STATUS.ACCEPTED, provider).catch((e) => e);
    expect(err).toBeInstanceOf(StatusError);
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/just updated/i);
  });

  it('other save errors are not disguised as conflicts', async () => {
    const b = makeBooking(STATUS.PENDING);
    b.save = jest.fn().mockRejectedValue(new Error('connection reset'));
    await expect(transition(b, STATUS.ACCEPTED, provider)).rejects.toThrow('connection reset');
  });
});

describe('repeating a move that already happened', () => {
  it('the same provider tapping Accept twice is a no-op, not an error', async () => {
    const b = makeBooking(STATUS.ACCEPTED);
    await transition(b, STATUS.ACCEPTED, provider);
    expect(b.status).toBe(STATUS.ACCEPTED);
    expect(b.save).not.toHaveBeenCalled();
    expect(b.statusHistory).toHaveLength(0);
  });

  it('a different provider repeating it still gets 403', async () => {
    const b = makeBooking(STATUS.ACCEPTED);
    const err = await transition(b, STATUS.ACCEPTED, { id: OTHER_PROVIDER, role: 'provider' }).catch((e) => e);
    expect(err.statusCode).toBe(403);
  });

  it('cancelling an already-cancelled booking is a no-op for its customer', async () => {
    const b = makeBooking(STATUS.CANCELLED);
    await transition(b, STATUS.CANCELLED, customer);
    expect(b.save).not.toHaveBeenCalled();
  });
});

describe('moves on a booking that has already ended', () => {
  it('explains an expired request in words, with 409', async () => {
    const b = makeBooking(STATUS.CANCELLED);
    b.cancellation = { by: 'system', code: 'expired_pending' };
    const err = await transition(b, STATUS.ACCEPTED, provider).catch((e) => e);
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('This request expired before it was accepted.');
  });

  it('explains a request released to another provider', async () => {
    const b = makeBooking(STATUS.CANCELLED);
    b.cancellation = { by: 'system', code: 'released' };
    const err = await transition(b, STATUS.ACCEPTED, provider).catch((e) => e);
    expect(err.message).toMatch(/already booked another provider/i);
  });

  it('a completed job says so', async () => {
    const b = makeBooking(STATUS.COMPLETED);
    const err = await transition(b, STATUS.IN_PROGRESS, provider).catch((e) => e);
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('This job is already completed.');
  });
});

describe('cancellation records its cause', () => {
  it('a system release carries its code', async () => {
    const b = makeBooking(STATUS.PENDING);
    await transition(b, STATUS.CANCELLED, { id: null, role: 'system' }, { reason: 'x', code: 'released' });
    expect(b.cancellation.by).toBe('system');
    expect(b.cancellation.code).toBe('released');
  });
});

describe('job buckets use Pakistan days, not the server\'s UTC day', () => {
  it('01:30 PKT: a 9 AM PKT job the same morning is TODAY (UTC still says yesterday)', () => {
    const now = new Date('2026-09-26T20:30:00.000Z'); // 27 Sep 01:30 PKT
    const nineAm = new Date('2026-09-27T04:00:00.000Z'); // 27 Sep 09:00 PKT
    expect(toJobBucket(STATUS.ACCEPTED, nineAm, now)).toBe('today');
  });

  it('a job tomorrow in PKT is upcoming', () => {
    const now = new Date('2026-09-27T06:00:00.000Z'); // 27 Sep 11:00 PKT
    const tomorrow = new Date('2026-09-28T04:00:00.000Z');
    expect(toJobBucket(STATUS.ACCEPTED, tomorrow, now)).toBe('upcoming');
  });

  it('an accepted job whose day has passed (not yet expired) is due now, not upcoming', () => {
    const now = new Date('2026-09-27T06:00:00.000Z');
    const yesterday = new Date('2026-09-26T13:00:00.000Z');
    expect(toJobBucket(STATUS.ACCEPTED, yesterday, now)).toBe('today');
  });
});
