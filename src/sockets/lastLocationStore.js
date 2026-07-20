/**
 * In-memory last-known provider positions, keyed by bookingId.
 *
 * NFR-08: location data is NOT retained after job completion — nothing here
 * ever touches the database, entries are overwritten in place and cleared
 * when the booking reaches a terminal status (see trackingHandler). A process
 * restart loses them by design.
 */
const lastLocations = new Map();

function setLastLocation(bookingId, loc) {
  lastLocations.set(String(bookingId), { ...loc, at: Date.now() });
}

function getLastLocation(bookingId) {
  return lastLocations.get(String(bookingId)) || null;
}

function clearLocation(bookingId) {
  lastLocations.delete(String(bookingId));
}

module.exports = { setLastLocation, getLastLocation, clearLocation };
