/**
 * HS4 review guards (customer-only, completed-only, once) and payout
 * balance rule. Controllers exercised with mock req/res, models mocked.
 */
jest.mock('../models/Booking', () => ({ findById: jest.fn() }));
jest.mock('../models/ProviderReview', () => ({ create: jest.fn() }));
jest.mock('../models/PayoutRequest', () => ({
  create: jest.fn(),
  aggregate: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../models/Provider', () => ({ updateOne: jest.fn() }));
jest.mock('../../../services/walletService', () => ({
  getOrCreateWallet: jest.fn(),
}));
jest.mock('../../../models/WalletTransaction', () => ({
  aggregate: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/settingsService', () => ({
  getHomeserviceSettings: jest.fn().mockResolvedValue({
    commissionPercent: 10,
    minPayoutAmount: 500,
  }),
}));
jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return actual;
});

const Booking = require('../models/Booking');
const ProviderReview = require('../models/ProviderReview');
const PayoutRequest = require('../models/PayoutRequest');
const WalletService = require('../../../services/walletService');
const { submitReview } = require('../controllers/reviewController');
const { requestPayout } = require('../controllers/earningsController');
const { STATUS } = require('../services/statusMap');

function mockRes() {
  const res = { statusCode: 200 };
  res.status = jest.fn((c) => {
    res.statusCode = c;
    return res;
  });
  res.json = jest.fn(() => res);
  return res;
}

const next = jest.fn();
// asyncHandler forwards rejections to next(err) — run and inspect
async function run(handler, req, res) {
  next.mockClear();
  await handler(req, res, next);
  return next.mock.calls[0] ? next.mock.calls[0][0] : null;
}

// Valid ObjectId string for earnings controller
const PROVIDER_OID = '64b000000000000000000001';

beforeEach(() => jest.clearAllMocks());

describe('review guards', () => {
  const baseReq = {
    user: { _id: 'cust-1' },
    body: { bookingId: 'bk-1', rating: 5, feedback: 'great', tags: [] },
  };

  it('rejects a review before the booking is COMPLETED', async () => {
    Booking.findById.mockResolvedValue({
      _id: 'bk-1',
      customer: 'cust-1',
      provider: 'prov-1',
      status: STATUS.IN_PROGRESS,
    });
    const res = mockRes();
    const err = await run(submitReview, { ...baseReq }, res);
    expect(res.statusCode).toBe(400);
    expect(String(err && err.message)).toMatch(/completed/i);
    expect(ProviderReview.create).not.toHaveBeenCalled();
  });

  it('rejects a review from someone other than the customer', async () => {
    Booking.findById.mockResolvedValue({
      _id: 'bk-1',
      customer: 'someone-else',
      provider: 'prov-1',
      status: STATUS.COMPLETED,
    });
    const res = mockRes();
    const err = await run(submitReview, { ...baseReq }, res);
    expect(res.statusCode).toBe(403);
    expect(String(err && err.message)).toMatch(/customer/i);
  });

  it('rejects a duplicate review (unique index → 11000)', async () => {
    Booking.findById.mockResolvedValue({
      _id: 'bk-1',
      customer: 'cust-1',
      provider: 'prov-1',
      status: STATUS.COMPLETED,
    });
    const dup = new Error('E11000 duplicate key');
    dup.code = 11000;
    ProviderReview.create.mockRejectedValue(dup);
    const res = mockRes();
    const err = await run(submitReview, { ...baseReq }, res);
    expect(res.statusCode).toBe(400);
    expect(String(err && err.message)).toMatch(/already been reviewed/i);
  });

  it('rejects a non-integer rating', async () => {
    const res = mockRes();
    const err = await run(
      submitReview,
      { user: { _id: 'cust-1' }, body: { bookingId: 'bk-1', rating: 4.5 } },
      res
    );
    expect(res.statusCode).toBe(400);
    expect(String(err && err.message)).toMatch(/integer/i);
  });
});

describe('payout balance rule', () => {
  it('rejects a payout exceeding the available balance', async () => {
    WalletService.getOrCreateWallet.mockResolvedValue({ balance: 1000 });
    const res = mockRes();
    const err = await run(
      requestPayout,
      { user: { _id: PROVIDER_OID }, body: { amount: 5000, method: 'bank' } },
      res
    );
    expect(res.statusCode).toBe(400);
    expect(String(err && err.message)).toMatch(/exceeds available balance/i);
    expect(PayoutRequest.create).not.toHaveBeenCalled();
  });

  it('rejects a payout below the minimum', async () => {
    WalletService.getOrCreateWallet.mockResolvedValue({ balance: 10000 });
    const res = mockRes();
    const err = await run(
      requestPayout,
      { user: { _id: PROVIDER_OID }, body: { amount: 100, method: 'bank' } },
      res
    );
    expect(res.statusCode).toBe(400);
    expect(String(err && err.message)).toMatch(/minimum payout/i);
  });

  it('creates the payout when the balance covers it', async () => {
    WalletService.getOrCreateWallet.mockResolvedValue({ balance: 10000 });
    PayoutRequest.create.mockResolvedValue({ _id: 'po-1' });
    const res = mockRes();
    const err = await run(
      requestPayout,
      { user: { _id: PROVIDER_OID }, body: { amount: 2000, method: 'bank' } },
      res
    );
    expect(err).toBeNull();
    expect(PayoutRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2000 })
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
  });
});
