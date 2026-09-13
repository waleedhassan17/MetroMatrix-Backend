/**
 * The time an appointment copies from its slot. Pure — no DB.
 */
const { inferSlotInstants, appointmentTimeFields } = require('../services/appointmentTime');

describe('appointmentTimeFields', () => {
  it('copies a modern slot as-is', () => {
    const slot = {
      startUtc: new Date('2026-09-15T05:00:00.000Z'),
      endUtc: new Date('2026-09-15T05:30:00.000Z'),
      startTime: '10:00',
      endTime: '10:30',
      clinicTimezone: 'Asia/Karachi',
      dateKey: '2026-09-15',
    };
    expect(appointmentTimeFields(slot)).toEqual({
      startUtc: slot.startUtc,
      endUtc: slot.endUtc,
      startTime: '10:00',
      endTime: '10:30',
      timezone: 'Asia/Karachi',
      dateKey: '2026-09-15',
    });
  });

  it('derives dateKey in the clinic zone when the slot has none', () => {
    // 21:00 in Karachi on the 15th is 16:00Z — still the 15th locally.
    const fields = appointmentTimeFields({
      startUtc: new Date('2026-09-15T16:00:00.000Z'),
      endUtc: new Date('2026-09-15T16:30:00.000Z'),
      startTime: '21:00',
      endTime: '21:30',
      clinicTimezone: 'Asia/Karachi',
    });
    expect(fields.dateKey).toBe('2026-09-15');
  });

  it('returns nothing rather than guessing when the time is unknowable', () => {
    expect(appointmentTimeFields({ startTime: 'nope', endTime: '10:00', date: null })).toEqual({});
    expect(appointmentTimeFields(null)).toEqual({});
  });
});

describe('inferSlotInstants (legacy slots without startUtc)', () => {
  it('reads a UTC-midnight date as that calendar day', () => {
    const r = inferSlotInstants(
      { date: new Date('2026-09-15T00:00:00.000Z'), startTime: '09:00', endTime: '09:30' },
      'Asia/Karachi'
    );
    expect(r.dateKey).toBe('2026-09-15');
    expect(r.startUtc.toISOString()).toBe('2026-09-15T04:00:00.000Z');
  });

  it('reads a clinic-midnight date (19:00Z the evening before) as the next day', () => {
    const r = inferSlotInstants(
      { date: new Date('2026-09-14T19:00:00.000Z'), startTime: '09:00', endTime: '09:30' },
      'Asia/Karachi'
    );
    expect(r.dateKey).toBe('2026-09-15');
  });

  it('refuses a reversed range', () => {
    const r = inferSlotInstants(
      { date: new Date('2026-09-15T00:00:00.000Z'), startTime: '10:00', endTime: '09:00' },
      'Asia/Karachi'
    );
    expect(r.startUtc).toBeNull();
  });
});
