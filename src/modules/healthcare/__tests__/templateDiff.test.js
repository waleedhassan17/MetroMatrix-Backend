/**
 * Previewing a change of weekly hours against the slots already published. Pure — no DB.
 */
const { planTemplateChange, summarizePlan, planByDate } = require('../services/templatePlanner');

const now = new Date('2026-09-15T00:00:00.000Z');
let seq = 0;
const slot = (start, end, extra = {}) => ({
  _id: `s${(seq += 1)}`,
  startUtc: new Date(`2026-09-16T${start}:00.000Z`),
  endUtc: new Date(`2026-09-16T${end}:00.000Z`),
  dateKey: '2026-09-16',
  type: 'in-clinic',
  clinicId: 'gulberg',
  source: 'template',
  status: 'available',
  bookedCount: 0,
  maxPatients: 1,
  ...extra,
});
// Candidates carry no _id or source, like buildTemplateCandidates output.
const want = (start, end, extra = {}) => {
  const { _id, source, ...rest } = slot(start, end, extra);
  return rest;
};

describe('planTemplateChange', () => {
  it('the same hours change nothing', () => {
    const existing = [slot('04:00', '04:30'), slot('04:30', '05:00')];
    const plan = planTemplateChange({ existing, desired: [want('04:00', '04:30'), want('04:30', '05:00')], now });
    expect(summarizePlan(plan)).toEqual({ add: 0, remove: 0, keep: 2, conflicts: 0, skipped: 0 });
  });

  it('30 → 20 minute slots: removes open slots, keeps the booked one as a conflict, never stacks grids', () => {
    const open = slot('04:00', '04:30');
    const booked = slot('04:30', '05:00', { bookedCount: 1, status: 'booked' });
    const plan = planTemplateChange({
      existing: [open, booked],
      desired: [want('04:00', '04:20'), want('04:20', '04:40'), want('04:40', '05:00')],
      now,
    });
    expect(plan.remove.map((s) => s._id)).toEqual([open._id]);
    expect(plan.conflicts.map((s) => s._id)).toEqual([booked._id]);
    expect(plan.add.map((s) => s.startUtc.toISOString())).toEqual(['2026-09-16T04:00:00.000Z']);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['OVERLAPS_EXISTING', 'OVERLAPS_EXISTING']);
  });

  it('never touches hand-made slots, and does not add over them', () => {
    const manual = slot('04:00', '04:30', { source: 'manual' });
    const plan = planTemplateChange({ existing: [manual], desired: [want('04:00', '04:30')], now });
    expect(plan.remove).toHaveLength(0);
    expect(plan.add).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('OVERLAPS_EXISTING');
  });

  it('a slot the doctor closed stays closed when it still matches', () => {
    const closed = slot('04:00', '04:30', { status: 'blocked', blockedBy: 'doctor' });
    const plan = planTemplateChange({ existing: [closed], desired: [want('04:00', '04:30')], now });
    expect(plan.keep).toEqual([closed]);
    expect(plan.add).toHaveLength(0);
  });

  it('ignores slots that have already started', () => {
    const started = slot('04:00', '04:30', {
      startUtc: new Date('2026-09-14T23:50:00.000Z'),
      endUtc: new Date('2026-09-15T00:20:00.000Z'),
      dateKey: '2026-09-15',
    });
    const plan = planTemplateChange({ existing: [started], desired: [], now });
    expect(plan.remove).toHaveLength(0);
  });

  it('switching video off removes open video slots', () => {
    const video = slot('12:00', '12:30', { type: 'video', clinicId: null });
    const plan = planTemplateChange({ existing: [video], desired: [], now });
    expect(plan.remove.map((s) => s._id)).toEqual([video._id]);
  });

  it('leaves days inside time off alone', () => {
    const onLeave = slot('04:00', '04:30', { status: 'blocked', blockedBy: 'time_off' });
    const plan = planTemplateChange({
      existing: [onLeave],
      desired: [],
      now,
      excludeDateKeys: new Set(['2026-09-16']),
    });
    expect(summarizePlan(plan)).toEqual({ add: 0, remove: 0, keep: 0, conflicts: 0, skipped: 0 });
  });

  it('adds a new video slot next to a booked in-clinic one as held', () => {
    const booked = slot('04:00', '04:30', { bookedCount: 1, status: 'booked' });
    const plan = planTemplateChange({
      existing: [booked],
      desired: [want('04:00', '04:30'), want('04:00', '04:30', { type: 'video', clinicId: null })],
      now,
    });
    expect(plan.add).toHaveLength(1);
    expect(plan.add[0]).toMatchObject({ type: 'video', status: 'held', heldBy: booked._id });
  });

  it('groups changes by date for the preview', () => {
    const plan = planTemplateChange({ existing: [slot('04:00', '04:30')], desired: [want('06:00', '06:30')], now });
    expect(planByDate(plan)).toEqual([{ date: '2026-09-16', add: 1, remove: 1, conflicts: 0 }]);
  });
});
