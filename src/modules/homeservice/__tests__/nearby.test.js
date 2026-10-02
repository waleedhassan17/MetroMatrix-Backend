jest.mock('../../../sockets', () => ({
  pushToUser: jest.fn().mockResolvedValue(true),
  emitToBooking: jest.fn().mockResolvedValue(true),
}));

const { shouldNotifyNearby } = require('../services/nearbyService');

describe('nearby threshold', () => {
  it.each([
    [800, true], // well inside 1.5 km
    [1500, true],
    [2000, true], // ~5 min at 25 km/h
    [2400, false], // ~6 min
    [9000, false],
    [NaN, false],
    [-5, false],
  ])('%p m → %p', (meters, expected) => {
    expect(shouldNotifyNearby(meters)).toBe(expected);
  });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('nearby alert is sent once (MongoDB)', () => {
  const mongoose = require('mongoose');
  require('../../../models/User');
  require('../../../models/Provider');
  const Booking = require('../models/Booking');
  const { notifyNearbyOnce } = require('../services/nearbyService');
  const { pushToUser, emitToBooking } = require('../../../sockets');

  beforeAll(async () => {
    await mongoose.connect(URI.replace(/\/[^/]*$/, '/mm_nearby_test'));
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  async function booking(status) {
    const id = new mongoose.Types.ObjectId();
    await mongoose.connection.collection('hsbookings').insertOne({
      _id: id,
      customer: new mongoose.Types.ObjectId(),
      provider: new mongoose.Types.ObjectId(),
      status,
      serviceCategory: 'electricians',
      scheduledFor: new Date(),
      address: { line1: 'x', coordinates: { type: 'Point', coordinates: [74.3, 31.5] } },
    });
    return id;
  }

  beforeEach(() => jest.clearAllMocks());

  it('the first call sends, every later one does not', async () => {
    const id = await booking('EN_ROUTE');
    const [a, b] = await Promise.all([
      notifyNearbyOnce(id, { distanceMeters: 900, etaMinutes: 3 }),
      notifyNearbyOnce(id, { distanceMeters: 900, etaMinutes: 3 }),
    ]);
    expect([a.sent, b.sent].sort()).toEqual([false, true]);
    expect((await notifyNearbyOnce(id, {})).sent).toBe(false);
    expect(pushToUser).toHaveBeenCalledTimes(1);
    expect(pushToUser.mock.calls[0][2]).toMatchObject({ type: 'booking_nearby', title: 'Almost there' });
    expect(emitToBooking).toHaveBeenCalledWith(id, 'provider_nearby', expect.objectContaining({ etaMinutes: 3 }));
    const row = await Booking.findById(id).lean();
    expect(row.notifications.nearbyAt).toBeInstanceOf(Date);
  });

  it('never alerts for a booking that is not on the way', async () => {
    const id = await booking('ARRIVED');
    expect((await notifyNearbyOnce(id, {})).sent).toBe(false);
    expect(pushToUser).not.toHaveBeenCalled();
  });
});
