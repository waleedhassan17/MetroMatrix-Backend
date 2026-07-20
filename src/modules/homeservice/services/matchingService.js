/**
 * Provider matching score (FYP report §5.4.5):
 *
 *   score = W.distance * distanceScore + W.rating * ratingScore + W.availability * availabilityBonus
 *
 *   distanceScore     = 1 - min(distance / radius, 1)
 *   ratingScore       = rating / 5
 *   availabilityBonus = 1 if provider is online (and within working hours), else 0
 *
 * The weights are hardcoded for FYP-I and intended to be LEARNED from booking
 * outcomes in FYP-II. Admin can tune them via /api/admin/homeservice/settings
 * (settingsService) — matchingWeights there overrides these defaults.
 */
const MATCHING_WEIGHTS = {
  distance: 0.4,
  rating: 0.4,
  availability: 0.2,
};

// Average urban driving speed for ETA estimates. 25 km/h reflects dense
// Lahore traffic; documented in the report alongside the matching score.
const AVG_URBAN_SPEED_KMH = 25;

/**
 * Pure scoring function — used both by the aggregation pipeline builder and
 * by unit tests that prove the documented algorithm is implemented.
 */
function matchingScore({ distanceMeters, radiusMeters, rating, isOnline }, weights = MATCHING_WEIGHTS) {
  const distanceScore = 1 - Math.min(distanceMeters / radiusMeters, 1);
  const ratingScore = (rating || 0) / 5;
  const availabilityBonus = isOnline ? 1 : 0;
  return (
    weights.distance * distanceScore +
    weights.rating * ratingScore +
    weights.availability * availabilityBonus
  );
}

function estimatedTravelMinutes(distanceMeters, speedKmh = AVG_URBAN_SPEED_KMH) {
  const km = distanceMeters / 1000;
  return Math.max(1, Math.round((km / speedKmh) * 60));
}

module.exports = { MATCHING_WEIGHTS, AVG_URBAN_SPEED_KMH, matchingScore, estimatedTravelMinutes };
