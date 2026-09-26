/**
 * What each trade offers, and when a provider works.
 *
 * Every provider profile used to list the same two rows — "Standard Visit"
 * and "Installation" — whatever the trade, so a plumber's profile offered the
 * same "Installation" as an AC technician's. The menu is now per trade, priced
 * from the provider's own visit charge, so each profile reads like the trade
 * it belongs to.
 */

// [id, name, description, multiplier of basePrice, duration, icon]
const SERVICES_BY_SUBTYPE = {
  electrician: [
    ['inspection', 'Inspection & fault finding', 'Diagnose tripping breakers, dead sockets and wiring faults', 1, '30-60 min', 'search'],
    ['switchboard', 'Switchboard & socket repair', 'Repair or replace switches, sockets and distribution boards', 1.5, '1 hour', 'flash'],
    ['fitting', 'Fan & light installation', 'Fit ceiling fans, lights and fixtures, including wiring', 2, '1-2 hours', 'bulb'],
    ['backup', 'UPS & inverter wiring', 'Install or rewire a UPS or inverter backup circuit', 3, '2-3 hours', 'battery-charging'],
  ],
  plumber: [
    ['leak', 'Leak repair', 'Fix leaking taps, pipes, joints and flush tanks', 1, '30-60 min', 'water'],
    ['drain', 'Drain unblocking', 'Clear blocked sinks, floor drains and toilets', 1.5, '1 hour', 'funnel'],
    ['fixture', 'Fixture installation', 'Fit taps, showers, basins, geysers and water filters', 2, '1-2 hours', 'construct'],
    ['tank', 'Water tank & pump service', 'Clean tanks and repair or install water pumps', 3, '2-3 hours', 'speedometer'],
  ],
  ac_repairer: [
    ['service', 'AC service', 'Clean filters, coils and drain; check cooling performance', 1, '1 hour', 'snow'],
    ['gas', 'Gas refill & leak check', 'Find and seal leaks, then top up refrigerant', 2, '1-2 hours', 'thermometer'],
    ['repair', 'Fault repair', 'Repair PCB, capacitor, fan motor and compressor faults', 2.5, '1-3 hours', 'build'],
    ['install', 'Installation & shifting', 'Install a new split unit or move an existing one', 4, '3-4 hours', 'swap-horizontal'],
  ],
};

/** Round to a price a person would quote: the nearest Rs. 50. */
const quote = (n) => Math.max(50, Math.round(n / 50) * 50);

function servicesFor(provider) {
  const base = Number(provider.basePrice) || 500;
  const menu = SERVICES_BY_SUBTYPE[provider.providerSubType] || [];
  return menu.map(([id, name, description, multiplier, duration, icon]) => ({
    id,
    name,
    description,
    price: quote(base * multiplier),
    duration,
    icon,
  }));
}

// ---------------------------------------------------------------------------
// Working hours
// ---------------------------------------------------------------------------

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/**
 * Hours a provider who has never set any is assumed to keep. Ends at 20:00 so
 * the last bookable slot (07:00 PM, an hour's visit) still fits inside it.
 */
const DEFAULT_HOURS = { start: '09:00', end: '20:00' };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** '14:30' → '02:30 PM' */
function to12h(hhmm) {
  const m = HHMM.exec(hhmm || '');
  if (!m) return hhmm || '';
  let h = parseInt(m[1], 10);
  const suffix = h >= 12 ? 'PM' : 'AM';
  h %= 12;
  if (h === 0) h = 12;
  return `${String(h).padStart(2, '0')}:${m[2]} ${suffix}`;
}

/**
 * A provider's hours for one weekday: { working, start, end } in 24-hour
 * 'HH:mm'. A day never configured falls back to the default hours; a day
 * explicitly switched off is a day off.
 */
function hoursFor(provider, day) {
  const d = provider && provider.availability ? provider.availability[day] : null;
  if (d && d.isAvailable === false) return { working: false, start: null, end: null };
  const start = d && HHMM.test(d.start || '') ? d.start : DEFAULT_HOURS.start;
  const end = d && HHMM.test(d.end || '') ? d.end : DEFAULT_HOURS.end;
  return { working: true, start, end };
}

/** The whole week in the shape the app's profile screens render. */
function weeklyAvailability(provider) {
  return DAYS.map((day, i) => {
    const h = hoursFor(provider, day);
    return {
      id: String(i + 1),
      day: day[0].toUpperCase() + day.slice(1),
      key: day,
      available: h.working,
      start: h.start,
      end: h.end,
      timeSlots: h.working ? [`${to12h(h.start)} - ${to12h(h.end)}`] : [],
    };
  });
}

/**
 * Validate a weekly-hours patch from the provider app:
 * { monday: { isAvailable, start: 'HH:mm', end: 'HH:mm' }, ... }.
 * Returns the cleaned object, or throws Error with a message fit to show.
 */
function parseAvailabilityPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Working hours must be given per day');
  }
  const out = {};
  for (const [day, value] of Object.entries(input)) {
    if (!DAYS.includes(day)) throw new Error(`Unknown day '${day}'`);
    if (!value || typeof value !== 'object') throw new Error(`Hours for ${day} are missing`);
    const isAvailable = value.isAvailable !== false;
    if (!isAvailable) {
      out[day] = { isAvailable: false, start: null, end: null };
      continue;
    }
    if (!HHMM.test(value.start || '') || !HHMM.test(value.end || '')) {
      throw new Error(`Hours for ${day} must be in HH:mm`);
    }
    if (value.start >= value.end) {
      throw new Error(`On ${day[0].toUpperCase() + day.slice(1)}, the start time must be before the end time`);
    }
    out[day] = { isAvailable: true, start: value.start, end: value.end };
  }
  return out;
}

module.exports = {
  SERVICES_BY_SUBTYPE,
  DAYS,
  DEFAULT_HOURS,
  servicesFor,
  hoursFor,
  weeklyAvailability,
  parseAvailabilityPatch,
  to12h,
};
