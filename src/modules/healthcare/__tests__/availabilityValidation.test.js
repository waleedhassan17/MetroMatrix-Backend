/**
 * Weekly-hours validation, settings validation and day expansion. Pure — no DB.
 */
const {
  validateWeeklyAvailability,
  validateSettings,
  resolveDoctorTimezone,
  expandDay,
} = require('../services/availabilityService');

const owned = new Set(['gulberg', 'dha']);
const clinicsById = new Map([
  ['gulberg', { _id: 'gulberg', timezone: 'Asia/Karachi' }],
  ['dha', { _id: 'dha', timezone: 'Asia/Karachi' }],
  ['dubai', { _id: 'dubai', timezone: 'Asia/Dubai' }],
]);

const day = (overrides) => ({
  day: 'Monday',
  isWorking: true,
  online: { enabled: false, ranges: [] },
  onsite: { enabled: false, ranges: [] },
  ...overrides,
});

const codes = (result) => result.issues.map((i) => i.code);

describe('validateWeeklyAvailability', () => {
  it('accepts minute-precision ranges', () => {
    const r = validateWeeklyAvailability(
      [day({ onsite: { enabled: true, ranges: [{ startTime: '09:07', endTime: '09:52', clinicId: 'gulberg' }] } })],
      owned,
      { slotDuration: 15 }
    );
    expect(r.ok).toBe(true);
  });

  it('rejects in-clinic periods overlapping at two different clinics', () => {
    const r = validateWeeklyAvailability(
      [
        day({
          onsite: {
            enabled: true,
            ranges: [
              { startTime: '09:00', endTime: '12:00', clinicId: 'gulberg' },
              { startTime: '11:00', endTime: '13:00', clinicId: 'dha' },
            ],
          },
        }),
      ],
      owned
    );
    expect(codes(r)).toContain('OVERLAP_SAME_MODE');
  });

  it('allows video overlapping in-clinic, with a warning', () => {
    const r = validateWeeklyAvailability(
      [
        day({
          online: { enabled: true, ranges: [{ startTime: '10:00', endTime: '11:00' }] },
          onsite: { enabled: true, ranges: [{ startTime: '10:00', endTime: '12:00', clinicId: 'gulberg' }] },
        }),
      ],
      owned,
      { clinicsById }
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['MODE_OVERLAP']);
  });

  it('rejects video and in-clinic overlap at clinics in different zones', () => {
    const r = validateWeeklyAvailability(
      [
        day({
          online: { enabled: true, ranges: [{ startTime: '10:00', endTime: '11:00', clinicId: 'dubai' }] },
          onsite: { enabled: true, ranges: [{ startTime: '10:00', endTime: '12:00', clinicId: 'gulberg' }] },
        }),
      ],
      new Set(['gulberg', 'dubai']),
      { clinicsById }
    );
    expect(codes(r)).toContain('OVERLAP_TZ_MISMATCH');
  });

  it('rejects a clinic the doctor does not own and in-clinic hours with no clinic', () => {
    const r = validateWeeklyAvailability(
      [
        day({
          onsite: {
            enabled: true,
            ranges: [
              { startTime: '09:00', endTime: '10:00', clinicId: 'someone-elses' },
              { startTime: '14:00', endTime: '15:00' },
            ],
          },
        }),
      ],
      owned
    );
    expect(codes(r)).toEqual(expect.arrayContaining(['CLINIC_NOT_OWNED', 'CLINIC_REQUIRED']));
  });

  it('rejects a period shorter than one slot and a reversed period', () => {
    const r = validateWeeklyAvailability(
      [
        day({
          online: {
            enabled: true,
            ranges: [
              { startTime: '09:00', endTime: '09:20' },
              { startTime: '18:00', endTime: '17:00' },
            ],
          },
        }),
      ],
      owned,
      { slotDuration: 30 }
    );
    expect(codes(r)).toEqual(expect.arrayContaining(['RANGE_SHORTER_THAN_SLOT', 'START_NOT_BEFORE_END']));
  });

  it('ignores switched-off modes and non-working days', () => {
    const r = validateWeeklyAvailability(
      [
        day({ onsite: { enabled: false, ranges: [{ startTime: '09:00', endTime: '10:00' }] } }),
        day({ day: 'Tuesday', isWorking: false, onsite: { enabled: true, ranges: [{ startTime: 'x', endTime: 'y' }] } }),
      ],
      owned
    );
    expect(r.ok).toBe(true);
  });

  it('keeps string errors for legacy callers', () => {
    const r = validateWeeklyAvailability([day({ day: 'Funday' })], owned);
    expect(r.errors).toEqual(['Unknown day "Funday"']);
  });
});

describe('validateSettings', () => {
  it.each([1, 241, 7.5, 'abc'])('rejects slotDuration %p', (slotDuration) => {
    expect(validateSettings({ slotDuration }).ok).toBe(false);
  });
  it('accepts valid settings and returns only the keys given', () => {
    const r = validateSettings({ slotDuration: 5, autoConfirm: true });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ slotDuration: 5, autoConfirm: true });
  });
  it('rejects a bad buffer, a non-boolean flag and an unknown zone', () => {
    const r = validateSettings({ bufferMinutes: -1, videoConsultation: 'yes', timezone: 'Mars/Base' });
    expect(r.errors.map((e) => e.field)).toEqual(['bufferMinutes', 'videoConsultation', 'timezone']);
  });
});

describe('resolveDoctorTimezone', () => {
  it('prefers the doctor, then an active clinic, then Karachi', () => {
    expect(resolveDoctorTimezone({ timezone: 'Asia/Dubai' }, [])).toBe('Asia/Dubai');
    expect(resolveDoctorTimezone({}, [{ isActive: false, timezone: 'Europe/London' }, { timezone: 'Asia/Dubai' }])).toBe('Asia/Dubai');
    expect(resolveDoctorTimezone(null, [])).toBe('Asia/Karachi');
  });
});

describe('expandDay', () => {
  const template = day({
    online: { enabled: true, ranges: [{ startTime: '17:00', endTime: '18:00' }] },
    onsite: { enabled: true, ranges: [{ startTime: '09:00', endTime: '10:00', clinicId: 'gulberg' }] },
  });

  it('stamps dateKey and honours the buffer', () => {
    const slots = expandDay({
      dateKey: '2026-09-14',
      dayTemplate: template,
      clinicsById,
      slotDuration: 20,
      breakBetween: 10,
    });
    const onsite = slots.filter((s) => s.type === 'in-clinic').map((s) => s.startTime);
    expect(onsite).toEqual(['09:00', '09:30']);
    expect(slots.every((s) => s.dateKey === '2026-09-14')).toBe(true);
  });

  it('uses the doctor zone for clinic-less video and can skip video entirely', () => {
    const withVideo = expandDay({ dateKey: '2026-09-14', dayTemplate: template, clinicsById, defaultTz: 'Asia/Dubai' });
    expect(withVideo.find((s) => s.type === 'video').clinicTimezone).toBe('Asia/Dubai');

    const noVideo = expandDay({ dateKey: '2026-09-14', dayTemplate: template, clinicsById, includeOnline: false });
    expect(noVideo.some((s) => s.type === 'video')).toBe(false);
  });

  it('stops publishing at a clinic that is no longer active', () => {
    const slots = expandDay({ dateKey: '2026-09-14', dayTemplate: template, clinicsById: new Map() });
    expect(slots.some((s) => s.type === 'in-clinic')).toBe(false);
  });
});
