/**
 * What the weekly-hours generator inserts. Pure — no DB.
 */
const {
  buildTemplateCandidates,
  planInserts,
  slotMinutesFor,
  awayDayKeys,
  MAX_CANDIDATES,
} = require('../services/slotGenerationService');

const at = (iso) => new Date(iso);
const slot = (start, end, extra = {}) => ({
  startUtc: at(start),
  endUtc: at(end),
  type: 'in-clinic',
  clinicId: 'gulberg',
  dateKey: '2026-09-15',
  bookedCount: 0,
  ...extra,
});

describe('planInserts', () => {
  it('skips a 20-minute candidate that overlaps an existing 30-minute slot', () => {
    const existing = [slot('2026-09-15T04:00:00Z', '2026-09-15T04:30:00Z')];
    const candidates = [
      slot('2026-09-15T04:00:00Z', '2026-09-15T04:20:00Z'),
      slot('2026-09-15T04:20:00Z', '2026-09-15T04:40:00Z'),
      slot('2026-09-15T04:40:00Z', '2026-09-15T05:00:00Z'),
    ];
    const { docs, skipped } = planInserts(candidates, existing);
    expect(skipped.map((s) => s.reason)).toEqual(['OVERLAPS_EXISTING', 'OVERLAPS_EXISTING']);
    expect(docs).toHaveLength(1);
    expect(docs[0].startUtc.toISOString()).toBe('2026-09-15T04:40:00.000Z');
  });

  it('keeps video and in-clinic at the same time as separate offerings', () => {
    const existing = [slot('2026-09-15T04:00:00Z', '2026-09-15T04:30:00Z')];
    const { docs } = planInserts([slot('2026-09-15T04:00:00Z', '2026-09-15T04:30:00Z', { type: 'video' })], existing);
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBeUndefined();
  });

  it('refuses in-clinic at another clinic at the same time', () => {
    const existing = [slot('2026-09-15T04:00:00Z', '2026-09-15T04:30:00Z')];
    const { skipped } = planInserts([slot('2026-09-15T04:15:00Z', '2026-09-15T04:45:00Z', { clinicId: 'dha' })], existing);
    expect(skipped[0].reason).toBe('OVERLAPS_OTHER_CLINIC');
  });

  it('inserts a slot that overlaps a booking as held', () => {
    const existing = [slot('2026-09-15T04:00:00Z', '2026-09-15T04:30:00Z', { _id: 'booked1', bookedCount: 1 })];
    const { docs } = planInserts([slot('2026-09-15T04:00:00Z', '2026-09-15T04:30:00Z', { type: 'video' })], existing);
    expect(docs[0]).toMatchObject({ status: 'held', heldBy: 'booked1' });
  });

  it('is idempotent: a second run over its own output inserts nothing', () => {
    const candidates = [slot('2026-09-15T04:00:00Z', '2026-09-15T04:30:00Z')];
    const first = planInserts(candidates, []);
    const second = planInserts(candidates, first.docs);
    expect(second.docs).toHaveLength(0);
  });
});

describe('buildTemplateCandidates', () => {
  const doctor = {
    _id: 'doc1',
    slotDuration: 30,
    weeklyAvailability: [
      {
        day: 'Tuesday',
        isWorking: true,
        online: { enabled: true, ranges: [{ startTime: '17:00', endTime: '18:00' }] },
        onsite: { enabled: true, ranges: [{ startTime: '09:00', endTime: '10:00', clinicId: 'gulberg' }] },
      },
    ],
    timeOff: [],
  };
  const clinics = [{ _id: 'gulberg', timezone: 'Asia/Karachi' }];

  it('expands each matching weekday (2026-09-15 is a Tuesday)', () => {
    const c = buildTemplateCandidates({ doctor, clinics, fromKey: '2026-09-14', toKey: '2026-09-20', slotDuration: 30 });
    expect(c).toHaveLength(4);
    expect(new Set(c.map((s) => s.dateKey))).toEqual(new Set(['2026-09-15']));
  });

  it('skips time off and switched-off video', () => {
    const c = buildTemplateCandidates({
      doctor: { ...doctor, videoConsultation: false, timeOff: [{ from: '2026-09-22', to: '2026-09-22' }] },
      clinics,
      fromKey: '2026-09-14',
      toKey: '2026-09-23',
      slotDuration: 30,
    });
    expect(c.every((s) => s.type === 'in-clinic' && s.dateKey === '2026-09-15')).toBe(true);
    expect(c).toHaveLength(2);
  });

  it('refuses a template that would explode into too many slots', () => {
    // Video and in-clinic around the clock in 5-minute slots: ~574 a day.
    const everyDay = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => ({
      day,
      isWorking: true,
      online: { enabled: true, ranges: [{ startTime: '00:00', endTime: '23:55' }] },
      onsite: { enabled: true, ranges: [{ startTime: '00:00', endTime: '23:55', clinicId: 'c1' }] },
    }));
    expect(() =>
      buildTemplateCandidates({
        doctor: { _id: 'doc1', weeklyAvailability: everyDay },
        clinics: [{ _id: 'c1', timezone: 'Asia/Karachi' }],
        fromKey: '2026-09-14',
        toKey: '2026-11-13',
        slotDuration: 5,
      })
    ).toThrow(`more than ${MAX_CANDIDATES} slots`);
  });
});

describe('helpers', () => {
  it('slotMinutesFor prefers a valid override, then the doctor, then the default', () => {
    expect(slotMinutesFor({ slotDuration: 20 }, 15)).toBe(15);
    expect(slotMinutesFor({ slotDuration: 20 }, 1)).toBe(20);
    expect(slotMinutesFor({}, undefined)).toBe(30);
  });

  it('awayDayKeys unions time-off ranges with legacy absent dates', () => {
    const keys = awayDayKeys(
      { timeOff: [{ from: '2026-09-20', to: '2026-09-21' }], absentDates: [new Date('2026-09-24T19:00:00Z')] },
      'Asia/Karachi'
    );
    expect([...keys].sort()).toEqual(['2026-09-20', '2026-09-21', '2026-09-25']);
  });
});
