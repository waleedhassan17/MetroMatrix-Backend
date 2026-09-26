/**
 * Pakistan-time calendar helpers for home services.
 *
 * The API runs on Vercel in UTC while every customer and provider is in
 * Pakistan (UTC+05:00, no DST). Anything that asks "which day is this?" —
 * the provider's Today bucket, the dashboard's today list, earnings months,
 * the date a booking card shows — must answer in PKT. Server-local getDate()
 * put the first five hours after midnight on the previous day.
 *
 * A fixed offset is exact here: Pakistan has not observed DST since 2009.
 */

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** The PKT wall-clock of an instant, expressed as a UTC-based Date for reading fields. */
function pktWall(date) {
  return new Date(new Date(date).getTime() + PKT_OFFSET_MS);
}

/** 'YYYY-MM-DD' of an instant, in Pakistan time. */
function pktDateString(date = new Date()) {
  return pktWall(date).toISOString().slice(0, 10);
}

/** [start, end) of the PKT calendar day containing `date`, as real instants. */
function pktDayBounds(date = new Date()) {
  const wall = pktWall(date);
  const startWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  const start = new Date(startWall - PKT_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** [start, end) of a PKT calendar day given as 'YYYY-MM-DD', or null if malformed. */
function pktDayBoundsFromString(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return null;
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - PKT_OFFSET_MS);
  if (Number.isNaN(start.getTime())) return null;
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** First instant of the PKT month containing `date`, shifted by `monthDelta` months. */
function pktMonthStart(date = new Date(), monthDelta = 0) {
  const wall = pktWall(date);
  return new Date(
    Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + monthDelta, 1) - PKT_OFFSET_MS
  );
}

/** First instant of the PKT year containing `date`. */
function pktYearStart(date = new Date()) {
  const wall = pktWall(date);
  return new Date(Date.UTC(wall.getUTCFullYear(), 0, 1) - PKT_OFFSET_MS);
}

/** Lower-case weekday name ('monday') of a 'YYYY-MM-DD' PKT date. */
function weekdayOf(dateStr) {
  const bounds = pktDayBoundsFromString(dateStr);
  if (!bounds) return null;
  return WEEKDAYS[pktWall(bounds.start).getUTCDay()];
}

/**
 * Minutes after PKT midnight for a slot label: '02:00 PM' → 840. Accepts
 * 'h:mm AM', 'hh:mm PM' and 24-hour 'HH:mm' (what provider working hours are
 * stored as). Returns null when the label cannot be read.
 */
function minutesOfDay(label) {
  const s = String(label || '').trim();
  const ampm = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(s);
  if (ampm) {
    let h = parseInt(ampm[1], 10) % 12;
    if (/pm/i.test(ampm[3])) h += 12;
    const min = parseInt(ampm[2], 10);
    return min < 60 ? h * 60 + min : null;
  }
  const h24 = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (h24) {
    const h = parseInt(h24[1], 10);
    const min = parseInt(h24[2], 10);
    return h < 24 && min < 60 ? h * 60 + min : null;
  }
  return null;
}

/** The instant a PKT date + slot label denotes, or null. */
function pktInstant(dateStr, label) {
  const bounds = pktDayBoundsFromString(dateStr);
  const mins = minutesOfDay(label);
  if (!bounds || mins === null) return null;
  return new Date(bounds.start.getTime() + mins * 60 * 1000);
}

module.exports = {
  PKT_OFFSET_MS,
  DAY_MS,
  WEEKDAYS,
  pktDateString,
  pktDayBounds,
  pktDayBoundsFromString,
  pktMonthStart,
  pktYearStart,
  weekdayOf,
  minutesOfDay,
  pktInstant,
};
