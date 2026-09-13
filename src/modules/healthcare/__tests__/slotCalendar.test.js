/**
 * Slot states the doctor sees, and one-off extra hours. Pure — no DB.
 */
const { deriveSlotState, planOneOffSlots } = require('../services/slotCalendarService');

const now = new Date('2026-09-15T00:00:00.000Z');
const future = { startUtc: new Date('2026-09-16T04:00:00.000Z'), status: 'available', bookedCount: 0, maxPatients: 1 };

describe('deriveSlotState', () => {
  it('an open manual slot can be closed, edited and deleted', () => {
    expect(deriveSlotState({ ...future, source: 'manual' }, [], now)).toEqual({
      state: 'open',
      isPast: false,
      canBlock: true,
      canUnblock: false,
      canDelete: true,
      canEdit: true,
    });
  });

  it('a weekly-hours slot can be closed but not deleted', () => {
    const r = deriveSlotState({ ...future, source: 'template' }, [], now);
    expect(r).toMatchObject({ canBlock: true, canDelete: false, canEdit: false });
  });

  it('a pending request outranks everything but a confirmation', () => {
    expect(deriveSlotState(future, [{ status: 'pending' }], now).state).toBe('requested');
    expect(deriveSlotState(future, [{ status: 'pending' }, { status: 'confirmed' }], now).state).toBe('booked');
    expect(deriveSlotState(future, [{ status: 'pending' }], now).canDelete).toBe(false);
  });

  it('past beats held and blocked, and nothing can be done', () => {
    const past = { ...future, startUtc: new Date('2026-09-14T04:00:00.000Z'), status: 'blocked', source: 'manual' };
    expect(deriveSlotState(past, [], now)).toMatchObject({ state: 'past', canBlock: false, canUnblock: false, canDelete: false });
  });

  it('only a slot the doctor closed can be reopened here', () => {
    const byDoctor = deriveSlotState({ ...future, status: 'blocked', blockedBy: 'doctor' }, [], now);
    const byLeave = deriveSlotState({ ...future, status: 'blocked', blockedBy: 'time_off' }, [], now);
    expect(byDoctor).toMatchObject({ state: 'blocked', canUnblock: true });
    expect(byLeave.canUnblock).toBe(false);
  });

  it('a full group slot with no appointment rows still reads booked and cannot be closed', () => {
    const r = deriveSlotState({ ...future, bookedCount: 3, maxPatients: 3 }, [], now);
    expect(r).toMatchObject({ state: 'booked', canBlock: false, canDelete: false });
  });
});

describe('planOneOffSlots', () => {
  const clinicsById = new Map([['gulberg', { _id: 'gulberg', timezone: 'Asia/Karachi' }]]);
  const ctx = {
    doctorId: 'doc1',
    clinicsById,
    doctorTz: 'Asia/Dubai',
    slotDuration: 30,
    bookableFrom: now,
  };

  it('splits a range into slots and reports the leftover minutes', () => {
    const r = planOneOffSlots(
      { date: '2026-09-16', startTime: '19:10', endTime: '20:50', type: 'in-clinic', clinicId: 'gulberg' },
      ctx
    );
    expect(r.candidates.map((c) => c.startTime)).toEqual(['19:10', '19:40', '20:10']);
    expect(r.unusedMinutes).toBe(10);
    expect(r.candidates[0]).toMatchObject({ source: 'manual', dateKey: '2026-09-16', clinicTimezone: 'Asia/Karachi' });
  });

  it('"both" makes a video and an in-clinic slot at the same moment', () => {
    const r = planOneOffSlots(
      { date: '2026-09-16', startTime: '10:00', endTime: '10:30', type: 'both', clinicId: 'gulberg' },
      ctx
    );
    expect(r.candidates.map((c) => c.type)).toEqual(['video', 'in-clinic']);
    expect(r.candidates[0].startUtc).toEqual(r.candidates[1].startUtc);
    expect(r.candidates[0].clinicId).toBeNull();
  });

  it('a clinic-less video slot uses the doctor zone', () => {
    const r = planOneOffSlots({ date: '2026-09-16', startTime: '10:00', endTime: '10:30', type: 'video' }, ctx);
    expect(r.candidates[0].clinicTimezone).toBe('Asia/Dubai');
  });

  it('can keep the whole range as one slot', () => {
    const r = planOneOffSlots(
      { date: '2026-09-16', startTime: '10:00', endTime: '12:00', type: 'video', split: false },
      ctx
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].endTime).toBe('12:00');
  });

  it('skips pieces that are too soon instead of failing the request', () => {
    const r = planOneOffSlots(
      { date: '2026-09-15', startTime: '04:30', endTime: '06:00', type: 'video' },
      { ...ctx, doctorTz: 'Asia/Karachi', bookableFrom: new Date('2026-09-15T00:10:00.000Z') }
    );
    // 04:30 and 05:00 in Karachi are 23:30Z and 00:00Z — both before 00:10Z.
    expect(r.skipped.map((s) => s.startTime)).toEqual(['04:30', '05:00']);
    expect(r.candidates.map((c) => c.startTime)).toEqual(['05:30']);
  });

  it.each([
    [{ date: '2026-09-16', startTime: '10:00', endTime: '09:00', type: 'video' }, 'after the start'],
    [{ date: '2026-09-16', startTime: '10:00', endTime: '10:20', type: 'video' }, 'shorter than one'],
    [{ date: '2026-09-16', startTime: '10:00', endTime: '11:00', type: 'in-clinic' }, 'need one of your clinics'],
    [{ date: '2026-09-16', startTime: '10:00', endTime: '11:00', type: 'video', clinicId: 'other' }, 'not one of your'],
    [{ date: '2026-09-16', startTime: '10:00', endTime: '11:00', type: 'video', maxPatients: 11 }, 'Patients per slot'],
    [{ date: '2026-09-16', startTime: '00:00', endTime: '23:55', type: 'both', slotDuration: 5, clinicId: 'gulberg' }, 'more than 200'],
  ])('rejects %j', (input, message) => {
    expect(() => planOneOffSlots(input, ctx)).toThrow(message);
  });
});
