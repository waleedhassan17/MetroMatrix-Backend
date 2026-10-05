/**
 * Validates readings before they are stored. A Bluetooth monitor can send a
 * garbage frame and a person can mistype; either way a reading outside what a
 * living adult produces is refused with a reason, never silently clamped.
 */
const MAX_BATCH = 50;
const FUTURE_SLACK_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
const round1 = (v) => Math.round(v * 10) / 10;

/** → { doc } or { error } */
function normaliseReading(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return { error: 'Not a reading' };
  const measuredAt = new Date(raw.measuredAt);
  if (Number.isNaN(measuredAt.getTime())) return { error: 'measuredAt must be a date' };
  if (measuredAt.getTime() > now + FUTURE_SLACK_MS) return { error: 'measuredAt is in the future' };
  if (measuredAt.getTime() < now - MAX_AGE_MS) return { error: 'measuredAt is more than a year ago' };

  const kind = raw.source && raw.source.kind === 'ble' ? 'ble' : 'manual';
  const deviceName = kind === 'ble' ? String((raw.source && raw.source.deviceName) || '').slice(0, 60) : '';
  const clientId = typeof raw.clientId === 'string' && raw.clientId.length <= 64 ? raw.clientId : undefined;
  const base = { measuredAt, source: { kind, deviceName }, ...(clientId ? { clientId } : {}) };

  if (raw.type === 'heart_rate') {
    const bpm = num(raw.bpm ?? (raw.heartRate && raw.heartRate.bpm));
    if (!inRange(bpm, 25, 250)) return { error: 'Heart rate must be 25–250 bpm' };
    return { doc: { ...base, type: 'heart_rate', heartRate: { bpm: Math.round(bpm) } } };
  }
  if (raw.type === 'blood_pressure') {
    const bp = raw.bloodPressure || raw;
    const systolic = num(bp.systolic);
    const diastolic = num(bp.diastolic);
    if (!inRange(systolic, 60, 260)) return { error: 'Systolic must be 60–260 mmHg' };
    if (!inRange(diastolic, 30, 160)) return { error: 'Diastolic must be 30–160 mmHg' };
    if (systolic <= diastolic) return { error: 'Systolic must be higher than diastolic' };
    const pulseRaw = num(bp.pulse);
    const mapRaw = num(bp.meanArterial);
    const out = {
      systolic: round1(systolic),
      diastolic: round1(diastolic),
      // Monitors report MAP; when one does not, the standard estimate.
      meanArterial: round1(inRange(mapRaw, diastolic, systolic) ? mapRaw : (systolic + 2 * diastolic) / 3),
    };
    if (bp.pulse !== undefined && bp.pulse !== null) {
      if (!inRange(pulseRaw, 25, 250)) return { error: 'Pulse must be 25–250 bpm' };
      out.pulse = Math.round(pulseRaw);
    }
    return { doc: { ...base, type: 'blood_pressure', bloodPressure: out } };
  }
  return { error: 'type must be heart_rate or blood_pressure' };
}

module.exports = { normaliseReading, MAX_BATCH };
