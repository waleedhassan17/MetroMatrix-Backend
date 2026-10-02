/**
 * Who gets pushed for every booking transition (bookingService.pushFor), and
 * who gets the in-app notice (notificationService). Pure — no DB.
 */
jest.mock('../models/HSNotification', () => ({ create: jest.fn(async (doc) => doc) }));

const HSNotification = require('../models/HSNotification');
const { pushFor } = require('../services/bookingService');
const notify = require('../services/notificationService');
const { STATUS } = require('../services/statusMap');

const booking = {
  _id: 'b1',
  customer: { _id: 'c1', fullName: 'Sarah Malik' },
  provider: { _id: 'p1', fullName: 'Ahmad Khan' },
  serviceSubCategory: 'Electrician',
  scheduledFor: new Date('2026-10-02T09:00:00Z'),
  scheduledTime: '02:00 PM',
};
const ctx = { customerName: 'Sarah Malik', providerName: 'Ahmad Khan', service: 'Electrician' };
const actor = (role) => ({ id: role === 'customer' ? 'c1' : role === 'provider' ? 'p1' : role === 'admin' ? 'a1' : null, role });
const recipients = (pushes) => pushes.map((p) => `${p.role}:${p.userId}:${p.type}`);

describe('push matrix', () => {
  it.each([
    [STATUS.ACCEPTED, 'provider', ['user:c1:booking_update']],
    [STATUS.REJECTED, 'provider', ['user:c1:booking_update']],
    [STATUS.EN_ROUTE, 'provider', ['user:c1:booking_update']],
    [STATUS.ARRIVED, 'provider', ['user:c1:booking_update']],
    // Used to send nothing.
    [STATUS.IN_PROGRESS, 'provider', ['user:c1:booking_update']],
    [STATUS.COMPLETED, 'provider', ['user:c1:booking_update']],
    [STATUS.COMPLETED, 'customer', ['provider:p1:booking_update']],
    [STATUS.CANCELLED, 'customer', ['provider:p1:booking_cancelled']],
    // Used to send nothing:
    [STATUS.CANCELLED, 'provider', ['user:c1:booking_cancelled']],
    [STATUS.CANCELLED, 'admin', ['user:c1:booking_cancelled', 'provider:p1:booking_cancelled']],
    [STATUS.CANCELLED, 'system', ['provider:p1:booking_cancelled']],
  ])('%s by %s → %j', (status, role, expected) => {
    expect(recipients(pushFor(booking, status, actor(role), ctx))).toEqual(expected);
  });

  it('never pushes the person who caused the change', () => {
    // Only transitions each side can actually perform (statusMap / bookingService).
    const legal = {
      provider: [STATUS.ACCEPTED, STATUS.REJECTED, STATUS.EN_ROUTE, STATUS.ARRIVED, STATUS.IN_PROGRESS, STATUS.COMPLETED, STATUS.CANCELLED],
      customer: [STATUS.COMPLETED, STATUS.CANCELLED],
    };
    for (const [role, statuses] of Object.entries(legal)) {
      const self = role === 'customer' ? 'c1' : 'p1';
      for (const status of statuses) {
        for (const p of pushFor(booking, status, actor(role), ctx)) expect(p.userId).not.toBe(self);
      }
    }
  });

  it('every push has words a person can read', () => {
    for (const status of Object.values(STATUS)) {
      for (const role of ['customer', 'provider', 'admin', 'system']) {
        for (const p of pushFor(booking, status, actor(role), ctx)) {
          expect(p.title).toBeTruthy();
          expect(p.body).toBeTruthy();
          expect(p.body).not.toMatch(/undefined|null/);
        }
      }
    }
  });

  it('says "work started" with the trade', () => {
    const [p] = pushFor(booking, STATUS.IN_PROGRESS, actor('provider'), ctx);
    expect(p.title).toBe('Work started');
    expect(p.body).toMatch(/Ahmad Khan has started on your electrician job/);
  });
});

describe('in-app notices', () => {
  beforeEach(() => HSNotification.create.mockClear());

  it('a job the customer confirmed is news for the provider', async () => {
    await notify.notifyBookingStatus(booking, STATUS.COMPLETED, ctx, actor('customer'));
    expect(HSNotification.create).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: 'p1', recipientRole: 'provider', title: 'Job confirmed' })
    );
  });

  it('a job the provider completed is news for the customer', async () => {
    await notify.notifyBookingStatus(booking, STATUS.COMPLETED, ctx, actor('provider'));
    expect(HSNotification.create).toHaveBeenCalledWith(expect.objectContaining({ recipient: 'c1', recipientRole: 'user' }));
  });

  it('support\'s cancellation reaches both, blaming neither', async () => {
    await notify.notifyBookingCancelled(booking, 'a1', { ...ctx, byRole: 'admin', reason: 'Duplicate booking' });
    const rows = HSNotification.create.mock.calls.map((c) => c[0]);
    expect(rows.map((r) => r.recipient).sort()).toEqual(['c1', 'p1']);
    for (const r of rows) {
      expect(r.message).toMatch(/MetroMatrix support cancelled this booking: Duplicate booking/);
      expect(r.message).not.toMatch(/provider cancelled|customer cancelled/i);
    }
  });

  it('a review reaches the provider', async () => {
    await notify.notifyReviewReceived(booking, { rating: 5, customerName: 'Sarah', service: 'electrician' });
    expect(HSNotification.create).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: 'p1', type: 'review_received', title: 'New 5-star review' })
    );
  });
});
