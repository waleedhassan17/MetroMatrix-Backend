/**
 * The server-owned bill (services/money.js), Pakistan-time calendar helpers
 * (services/time.js) and the per-trade catalogue / working hours
 * (services/catalogue.js). Pure functions — no DB.
 */
const {
  billOf,
  parseProviderAmount,
  assertPriceEditable,
  maxAmountFor,
  AmountError,
} = require('../services/money');
const {
  pktDateString,
  pktDayBounds,
  pktDayBoundsFromString,
  pktMonthStart,
  minutesOfDay,
  pktInstant,
  weekdayOf,
} = require('../services/time');
const {
  servicesFor,
  hoursFor,
  weeklyAvailability,
  parseAvailabilityPatch,
  to12h,
} = require('../services/catalogue');

describe('billOf — one answer to "how much is owed"', () => {
  it('prefers what the provider requested', () => {
    expect(billOf({ payment: { requestedAmount: 1800 }, pricing: { finalPrice: 1500, estimatedPrice: 500 } })).toBe(1800);
  });
  it('then the final price entered at completion', () => {
    expect(billOf({ payment: {}, pricing: { finalPrice: 1500, estimatedPrice: 500 } })).toBe(1500);
  });
  it('then the estimate', () => {
    expect(billOf({ payment: { requestedAmount: null }, pricing: { finalPrice: null, estimatedPrice: 500 } })).toBe(500);
  });
});

describe('parseProviderAmount — what a provider may bill', () => {
  const booking = { pricing: { estimatedPrice: 500 } };
  it.each([[-5], [0], ['abc'], [NaN], [Infinity], [''], [null]])('rejects %p', (raw) => {
    expect(() => parseProviderAmount(raw, booking)).toThrow(AmountError);
  });
  it('accepts numeric strings and rounds to whole rupees', () => {
    expect(parseProviderAmount('1499.6', booking)).toBe(1500);
  });
  it('caps at the per-job ceiling (never below Rs. 100,000)', () => {
    expect(maxAmountFor(booking)).toBe(100000);
    expect(() => parseProviderAmount(100001, booking)).toThrow(/can't be more than/);
    expect(parseProviderAmount(100000, booking)).toBe(100000);
  });
  it('a big estimate raises the ceiling, up to the absolute cap', () => {
    expect(maxAmountFor({ pricing: { estimatedPrice: 10000 } })).toBe(200000);
    expect(maxAmountFor({ pricing: { estimatedPrice: 1000000 } })).toBe(500000);
  });
});

describe('assertPriceEditable', () => {
  it('allows changes while unpaid or requested', () => {
    expect(() => assertPriceEditable({ payment: { status: 'unpaid' } })).not.toThrow();
    expect(() => assertPriceEditable({ payment: { status: 'requested' } })).not.toThrow();
  });
  it('locks the price once paid (409)', () => {
    const err = (() => {
      try {
        assertPriceEditable({ payment: { status: 'paid' } });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(AmountError);
    expect(err.statusCode).toBe(409);
  });
});

describe('Pakistan-time calendar', () => {
  it('01:30 PKT on the 27th is still the 26th in UTC — PKT wins', () => {
    expect(pktDateString(new Date('2026-09-26T20:30:00.000Z'))).toBe('2026-09-27');
  });
  it('day bounds run PKT midnight to PKT midnight', () => {
    const { start, end } = pktDayBounds(new Date('2026-09-27T10:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-09-26T19:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-27T19:00:00.000Z');
    expect(pktDayBoundsFromString('2026-09-27').start.toISOString()).toBe('2026-09-26T19:00:00.000Z');
    expect(pktDayBoundsFromString('27/09/2026')).toBeNull();
  });
  it('month start is PKT midnight on the 1st', () => {
    expect(pktMonthStart(new Date('2026-09-15T00:00:00.000Z')).toISOString()).toBe('2026-08-31T19:00:00.000Z');
    expect(pktMonthStart(new Date('2026-09-15T00:00:00.000Z'), -1).toISOString()).toBe('2026-07-31T19:00:00.000Z');
  });
  it('reads slot labels and 24-hour times', () => {
    expect(minutesOfDay('09:00 AM')).toBe(540);
    expect(minutesOfDay('12:00 PM')).toBe(720);
    expect(minutesOfDay('12:30 AM')).toBe(30);
    expect(minutesOfDay('07:00 PM')).toBe(1140);
    expect(minutesOfDay('19:30')).toBe(1170);
    expect(minutesOfDay('25:00')).toBeNull();
    expect(minutesOfDay('noon')).toBeNull();
  });
  it('a PKT date + slot is the right instant (2 PM PKT = 09:00 UTC, same day)', () => {
    expect(pktInstant('2026-09-17', '02:00 PM').toISOString()).toBe('2026-09-17T09:00:00.000Z');
  });
  it('knows the weekday of a PKT date', () => {
    expect(weekdayOf('2026-09-27')).toBe('sunday');
    expect(weekdayOf('2026-09-28')).toBe('monday');
  });
});

describe('per-trade service menu', () => {
  it('each trade has its own services, priced from the visit charge', () => {
    const plumber = servicesFor({ providerSubType: 'plumber', basePrice: 450 });
    const ac = servicesFor({ providerSubType: 'ac_repairer', basePrice: 600 });
    expect(plumber.map((s) => s.name)).toContain('Leak repair');
    expect(ac.map((s) => s.name)).toContain('Gas refill & leak check');
    expect(plumber[0].price).toBe(450);
    expect(plumber.every((s) => s.price % 50 === 0)).toBe(true);
  });
  it('an unknown trade offers nothing rather than an invented menu', () => {
    expect(servicesFor({ providerSubType: undefined, basePrice: 500 })).toEqual([]);
  });
});

describe('working hours', () => {
  it('a provider who never set hours keeps the default 9-8', () => {
    expect(hoursFor({}, 'monday')).toEqual({ working: true, start: '09:00', end: '20:00' });
  });
  it('a day switched off is a day off', () => {
    expect(hoursFor({ availability: { sunday: { isAvailable: false } } }, 'sunday').working).toBe(false);
  });
  it('the weekly view renders 12-hour ranges and hides days off', () => {
    const week = weeklyAvailability({ availability: { sunday: { isAvailable: false }, monday: { start: '10:00', end: '18:30', isAvailable: true } } });
    expect(week[0]).toMatchObject({ day: 'Monday', available: true, timeSlots: ['10:00 AM - 06:30 PM'] });
    expect(week[6]).toMatchObject({ day: 'Sunday', available: false, timeSlots: [] });
  });
  it('validates a weekly-hours patch', () => {
    expect(parseAvailabilityPatch({ monday: { isAvailable: true, start: '08:00', end: '17:00' } })).toEqual({
      monday: { isAvailable: true, start: '08:00', end: '17:00' },
    });
    expect(parseAvailabilityPatch({ sunday: { isAvailable: false } })).toEqual({
      sunday: { isAvailable: false, start: null, end: null },
    });
    expect(() => parseAvailabilityPatch({ funday: {} })).toThrow(/Unknown day/);
    expect(() => parseAvailabilityPatch({ monday: { start: '18:00', end: '09:00' } })).toThrow(/before the end/);
    expect(() => parseAvailabilityPatch({ monday: { start: '9am', end: '5pm' } })).toThrow(/HH:mm/);
    expect(() => parseAvailabilityPatch([])).toThrow();
  });
  it('to12h', () => {
    expect(to12h('00:15')).toBe('12:15 AM');
    expect(to12h('12:00')).toBe('12:00 PM');
    expect(to12h('20:00')).toBe('08:00 PM');
  });
});
