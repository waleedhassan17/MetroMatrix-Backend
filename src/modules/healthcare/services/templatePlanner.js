const { planInserts } = require('./slotGenerationService');
const { toDateKey } = require('../../../utils/time');

// ============================================================================
// What changing a doctor's weekly hours does to the slots already published.
//
// Generation only ever inserted. Turning Monday off left up to 60 days of
// Monday slots bookable; moving 09–13 to 10–14 kept the old 09:00 slots and
// added new ones; changing the slot length stacked two grids on top of each
// other. The doctor had no way to see any of it.
//
// This computes the change as a plan the doctor can preview, then apply:
//   add        — slots the new hours want that do not exist yet
//   remove     — template slots the new hours no longer want, with no booking
//   keep       — template slots that still match exactly (a closed one stays closed)
//   conflicts  — template slots the new hours no longer want, WITH a booking:
//                kept, never cancelled on the doctor's behalf
//   skipped    — wanted slots that cannot be added (they overlap a slot that stays)
//
// Hand-made slots are never touched. Days inside time off are left alone.
// Pure: no database access.
// ============================================================================

/** Identity of a slot: exactly this time, this type, this clinic. */
const slotKey = (s) =>
  `${new Date(s.startUtc).getTime()}|${new Date(s.endUtc).getTime()}|${s.type}|${
    s.clinicId ? String(s.clinicId) : 'none'
  }`;

const dayOf = (s) => s.dateKey || toDateKey(s.startUtc, s.clinicTimezone);

/**
 * @param {object} args
 * @param {object[]} args.existing slots overlapping the window (lean), including in-progress ones
 * @param {object[]} args.desired  candidates from buildTemplateCandidates for the new hours
 * @param {Date} args.now
 * @param {Set<string>} args.excludeDateKeys days in time off
 */
function planTemplateChange({ existing = [], desired = [], now = new Date(), excludeDateKeys = new Set() }) {
  const nowMs = now.getTime();
  const hasTime = (s) => s && s.startUtc && s.endUtc;
  const isFuture = (s) => new Date(s.startUtc).getTime() > nowMs;
  const inScope = (s) => hasTime(s) && !excludeDateKeys.has(dayOf(s));

  const wanted = desired.filter((d) => inScope(d) && isFuture(d));
  const wantedKeys = new Set(wanted.map(slotKey));

  const keep = [];
  const remove = [];
  const conflicts = [];
  for (const s of existing) {
    if (!inScope(s) || !isFuture(s) || s.source !== 'template') continue;
    if (wantedKeys.has(slotKey(s))) keep.push(s);
    else if ((s.bookedCount || 0) > 0) conflicts.push(s);
    else remove.push(s);
  }

  const removedIds = new Set(remove.map((s) => String(s._id)));
  const remaining = existing.filter((s) => hasTime(s) && !removedIds.has(String(s._id)));
  // Exact matches against weekly-hours slots are already covered (kept or in
  // conflict). A hand-made slot at the same time goes through planInserts, so
  // the preview can say why that time was not added.
  const remainingKeys = new Set(remaining.filter((s) => s.source === 'template').map(slotKey));

  const { docs: add, skipped } = planInserts(
    wanted.filter((d) => !remainingKeys.has(slotKey(d))),
    remaining
  );

  return { add, remove, keep, conflicts, skipped };
}

/** Counts for a plan. */
function summarizePlan(plan) {
  return {
    add: plan.add.length,
    remove: plan.remove.length,
    keep: plan.keep.length,
    conflicts: plan.conflicts.length,
    skipped: plan.skipped.length,
  };
}

/** Per-day counts, for the preview's "what changes when" list. */
function planByDate(plan) {
  const byDate = new Map();
  const bump = (slot, field) => {
    const date = dayOf(slot);
    if (!byDate.has(date)) byDate.set(date, { date, add: 0, remove: 0, conflicts: 0 });
    byDate.get(date)[field] += 1;
  };
  plan.add.forEach((s) => bump(s, 'add'));
  plan.remove.forEach((s) => bump(s, 'remove'));
  plan.conflicts.forEach((s) => bump(s, 'conflicts'));
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { slotKey, planTemplateChange, summarizePlan, planByDate };
