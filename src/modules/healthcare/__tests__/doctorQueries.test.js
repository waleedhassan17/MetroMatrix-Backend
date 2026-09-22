/**
 * Doctor app read queries: list filters, dashboard and earnings windows. Pure — no DB.
 */
const {
  buildDoctorAppointmentFilter,
  buildDashboardPipeline,
  buildEarningsPipeline,
  computeDashboardWindows,
  mergeStats,
  pickStats,
  resolveEarningsWindow,
  summarizeByType,
  toAppointmentListItem,
  toDashboardItem,
} = require('../services/doctorQueries');

const tz = 'Asia/Karachi';
// 2026-09-17 11:00 in Karachi (a Thursday).
const now = new Date('2026-09-17T06:00:00.000Z');

describe('buildDoctorAppointmentFilter', () => {
  it('a week range filters by dateKey with an indexed instant bound, oldest first', () => {
    const { filter, sort } = buildDoctorAppointmentFilter('doc1', { from: '2026-09-14', to: '2026-09-20' }, { tz, now });
    expect(filter.dateKey).toEqual({ $gte: '2026-09-14', $lte: '2026-09-20' });
    expect(filter.startUtc.$gte).toBeInstanceOf(Date);
    expect(sort).toEqual({ startUtc: 1, _id: 1 });
  });

  it('a single date is a one-day range', () => {
    const { filter } = buildDoctorAppointmentFilter('doc1', { date: '2026-09-17' }, { tz, now });
    expect(filter.dateKey).toEqual({ $gte: '2026-09-17', $lte: '2026-09-17' });
  });

  it('upcoming without a range means active appointments from today on', () => {
    const { filter, sort } = buildDoctorAppointmentFilter('doc1', { status: 'upcoming' }, { tz, now });
    expect(filter.status).toEqual({ $in: ['pending', 'confirmed'] });
    expect(filter.dateKey).toEqual({ $gte: '2026-09-17' });
    expect(sort).toEqual({ startUtc: 1, _id: 1 });
  });

  it('past means completed, or still active on an earlier day', () => {
    const { filter } = buildDoctorAppointmentFilter('doc1', { status: 'past' }, { tz, now });
    expect(filter.$or).toEqual([
      { status: 'completed' },
      { status: { $in: ['pending', 'confirmed'] }, dateKey: { $lt: '2026-09-17' } },
    ]);
  });

  it('rejects malformed and reversed ranges, ignores unknown statuses', () => {
    expect(() => buildDoctorAppointmentFilter('doc1', { from: '17/09/2026' }, { tz, now })).toThrow('YYYY-MM-DD');
    expect(() => buildDoctorAppointmentFilter('doc1', { from: '2026-09-20', to: '2026-09-14' }, { tz, now })).toThrow();
    expect(buildDoctorAppointmentFilter('doc1', { status: 'weird' }, { tz, now }).filter).toEqual({ doctorId: 'doc1' });
  });
});

describe('response shapes', () => {
  const lean = {
    _id: 'a1',
    slotId: 's1',
    patientId: { _id: 'p1', fullName: 'Ayesha Khan' },
    clinicId: { _id: 'c1', name: 'Gulberg' },
    type: 'in-clinic',
    status: 'confirmed',
    dateKey: '2026-09-17',
    startTime: '10:00',
    endTime: '10:30',
    startUtc: new Date('2026-09-17T05:00:00.000Z'),
    endUtc: new Date('2026-09-17T05:30:00.000Z'),
    timezone: tz,
  };

  it('list items carry ids and a compatibility slot built from the copied time', () => {
    const item = toAppointmentListItem(lean);
    expect(item.id).toBe('a1');
    expect(item.patientId.id).toBe('p1');
    expect(item.slotId).toMatchObject({ id: 's1', startTime: '10:00', endTime: '10:30', clinicTimezone: tz });
    expect(item.slotId.date.toISOString()).toBe('2026-09-16T19:00:00.000Z');
  });

  it('dashboard items keep the timeSlot shape the app reads, with the clinic name', () => {
    const item = toDashboardItem(lean);
    expect(item).toMatchObject({ appointmentId: 'a1', timeSlot: { start: '10:00', end: '10:30' }, clinic: { id: 'c1', name: 'Gulberg' } });
  });

  it('pickStats strips _id and fills zeros', () => {
    expect(pickStats([{ _id: null, appointments: 3, cancelled: 1 }])).toMatchObject({ appointments: 3, cancelled: 1, completed: 0 });
    expect(pickStats([])).toMatchObject({ appointments: 0, earnings: 0 });
  });
});

describe('computeDashboardWindows', () => {
  it('uses the Karachi day even when UTC is still on the previous one', () => {
    const w = computeDashboardWindows(new Date('2026-09-14T19:30:00.000Z'), tz);
    expect(w).toEqual({ todayKey: '2026-09-15', weekStartKey: '2026-09-14', monthStartKey: '2026-09-01' });
  });
});

describe('resolveEarningsWindow', () => {
  it('today compares against yesterday', () => {
    const w = resolveEarningsWindow({ range: 'today', tz, now });
    expect([w.fromKey, w.toKey, w.prevFromKey, w.prevToKey]).toEqual(['2026-09-17', '2026-09-17', '2026-09-16', '2026-09-16']);
  });

  it('this week runs from Monday, against the whole previous week', () => {
    const w = resolveEarningsWindow({ range: 'thisWeek', tz, now });
    expect([w.fromKey, w.toKey, w.prevFromKey, w.prevToKey]).toEqual(['2026-09-14', '2026-09-17', '2026-09-07', '2026-09-13']);
  });

  it('this month in January compares against all of December', () => {
    const w = resolveEarningsWindow({ range: 'thisMonth', tz, now: new Date('2026-01-10T06:00:00.000Z') });
    expect([w.fromKey, w.prevFromKey, w.prevToKey]).toEqual(['2026-01-01', '2025-12-01', '2025-12-31']);
    expect(w.previousLabel).toBe('December 2025');
  });

  it('a custom 10-day range compares against the 10 days before it', () => {
    const w = resolveEarningsWindow({ range: 'custom', startDate: '2026-09-01', endDate: '2026-09-10', tz, now });
    expect([w.prevFromKey, w.prevToKey]).toEqual(['2026-08-22', '2026-08-31']);
    expect(w.bucket).toBe('day');
  });

  it('long custom ranges bucket by month; over a year is refused', () => {
    expect(resolveEarningsWindow({ range: 'custom', startDate: '2026-01-01', endDate: '2026-06-30', tz, now }).bucket).toBe('month');
    expect(() => resolveEarningsWindow({ range: 'custom', startDate: '2025-01-01', endDate: '2026-06-30', tz, now })).toThrow('366');
  });

  it('maps the legacy period parameter instead of summing all time', () => {
    expect(resolveEarningsWindow({ period: 'monthly', tz, now }).key).toBe('thisMonth');
    expect(resolveEarningsWindow({ period: 'weekly', tz, now }).key).toBe('thisWeek');
    expect(resolveEarningsWindow({ period: 'daily', tz, now }).key).toBe('today');
    expect(resolveEarningsWindow({ startDate: '2026-09-01', endDate: '2026-09-05', tz, now }).key).toBe('custom');
  });
});

describe('dashboard pipeline', () => {
  const SETTLED = { $ifNull: ['$completedAt', '$startUtc'] };
  const windows = { todayKey: '2026-09-17', weekStartKey: '2026-09-14', monthStartKey: '2026-09-01' };

  it('admits appointments settled in the window even when scheduled before it', () => {
    const [match] = buildDashboardPipeline('doc1', windows, tz);
    const [scheduled, settled] = match.$match.$or;

    // The original bound — still there, so "Today" keeps counting what is
    // booked for today.
    expect(scheduled.dateKey).toEqual({ $gte: '2026-09-01', $lte: '2026-09-17' });
    // ...plus anything completed inside the window, however long ago it was
    // booked. Without this an appointment from July completed today never
    // entered the pipeline and "Seen" read 0 for a day's work.
    expect(settled.status).toBe('completed');
    expect(settled.$expr.$and[0].$gte[0]).toEqual(SETTLED);
  });

  it('counts Seen and earnings on settlement, everything else on the scheduled day', () => {
    const [, facet] = buildDashboardPipeline('doc1', windows, tz);

    expect(facet.$facet.today[0].$match).toEqual({ dateKey: '2026-09-17' });
    expect(facet.$facet.todaySettled[0].$match.status).toBe('completed');
    expect(facet.$facet.todaySettled[1].$group).toEqual({
      _id: null,
      completed: { $sum: 1 },
      earnings: { $sum: '$totalAmount' },
    });
  });

  it('mergeStats takes completed and earnings from the settled facet', () => {
    const scheduled = [{ _id: null, appointments: 4, completed: 1, cancelled: 1, earnings: 500 }];
    const settled = [{ _id: null, completed: 3, earnings: 4500 }];

    expect(mergeStats(scheduled, settled)).toMatchObject({
      appointments: 4,
      cancelled: 1,
      completed: 3,
      earnings: 4500,
    });
    // Nothing settled today: those two read zero rather than falling back to
    // the scheduled-day figures.
    expect(mergeStats(scheduled, [])).toMatchObject({ appointments: 4, completed: 0, earnings: 0 });
  });
});

describe('earnings pipeline', () => {
  // A doctor earns on the day they COMPLETE the consultation, not the day it
  // was booked for. This used to match and bucket on `dateKey`, so an 8 July
  // appointment completed on 23 September was missing from September and
  // retroactively changed July's total.
  const SETTLED = { $ifNull: ['$completedAt', '$startUtc'] };

  it('matches and buckets on the settlement instant, not the scheduled day', () => {
    const w = resolveEarningsWindow({ range: 'thisYear', tz, now });
    const [match, facet] = buildEarningsPipeline('doc1', w, tz);

    expect(match.$match).toMatchObject({ doctorId: 'doc1', status: 'completed' });
    // No scheduled-day bound anywhere in the match.
    expect(match.$match.dateKey).toBeUndefined();
    expect(match.$match.startUtc).toBeUndefined();

    // Bounded by when the work was settled: 2025-01-01 through end of today,
    // as local days in the doctor's zone (Asia/Karachi is UTC+5).
    const [lower, upper] = match.$match.$expr.$and;
    expect(lower.$gte[0]).toEqual(SETTLED);
    expect(lower.$gte[1].toISOString()).toBe('2024-12-31T19:00:00.000Z');
    expect(upper.$lt[1].toISOString()).toBe('2026-09-17T19:00:00.000Z');

    expect(facet.$facet.current[1].$group._id.bucket).toEqual({
      $dateToString: { date: SETTLED, format: '%Y-%m', timezone: tz },
    });
  });

  it('splits current from previous on the settlement instant too', () => {
    const w = resolveEarningsWindow({ range: 'thisMonth', tz, now });
    const [, facet] = buildEarningsPipeline('doc1', w, tz);

    const currentFrom = facet.$facet.current[0].$match.$expr.$gte[1];
    const previousBefore = facet.$facet.previous[0].$match.$expr.$lt[1];
    // The two facets meet exactly at the start of this month; nothing is
    // counted twice and nothing falls between them.
    expect(currentFrom.toISOString()).toBe(previousBefore.toISOString());
    expect(currentFrom.toISOString()).toBe('2026-08-31T19:00:00.000Z');
  });

  it('buckets by day for a short range', () => {
    const w = resolveEarningsWindow({ range: 'thisMonth', tz, now });
    const [, facet] = buildEarningsPipeline('doc1', w, tz);
    expect(facet.$facet.current[1].$group._id.bucket).toEqual({
      $dateToString: { date: SETTLED, format: '%Y-%m-%d', timezone: tz },
    });
  });

  it('summarizes totals per consultation type', () => {
    expect(
      summarizeByType([
        { types: [{ type: 'video', total: 1000, count: 1 }, { type: 'in-clinic', total: 2000, count: 1 }] },
        { types: [{ type: 'video', total: 1500, count: 1 }] },
      ])
    ).toEqual([
      { type: 'video', total: 2500, count: 2 },
      { type: 'in-clinic', total: 2000, count: 1 },
    ]);
  });
});
