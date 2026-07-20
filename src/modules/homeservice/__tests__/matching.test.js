/**
 * HS2 matching score — concrete evidence the documented algorithm
 * (report §5.4.5) is implemented with the documented weights.
 */
const {
  MATCHING_WEIGHTS,
  matchingScore,
  estimatedTravelMinutes,
} = require('../services/matchingService');

const RADIUS = 15000; // 15 km in metres

describe('weighted matching score', () => {
  it('uses the documented weights (0.4 / 0.4 / 0.2)', () => {
    expect(MATCHING_WEIGHTS).toEqual({ distance: 0.4, rating: 0.4, availability: 0.2 });
  });

  it('a provider 1km away rated 4.0 outranks one 12km away rated 5.0', () => {
    const near = matchingScore({
      distanceMeters: 1000,
      radiusMeters: RADIUS,
      rating: 4.0,
      isOnline: false,
    });
    const far = matchingScore({
      distanceMeters: 12000,
      radiusMeters: RADIUS,
      rating: 5.0,
      isOnline: false,
    });
    // near: 0.4*(1-1/15) + 0.4*0.8 = 0.3733 + 0.32 = 0.6933
    // far:  0.4*(1-12/15) + 0.4*1.0 = 0.08 + 0.40 = 0.48
    expect(near).toBeGreaterThan(far);
    expect(near).toBeCloseTo(0.6933, 3);
    expect(far).toBeCloseTo(0.48, 3);
  });

  it('online availability adds exactly the availability weight', () => {
    const base = { distanceMeters: 5000, radiusMeters: RADIUS, rating: 3 };
    expect(
      matchingScore({ ...base, isOnline: true }) - matchingScore({ ...base, isOnline: false })
    ).toBeCloseTo(MATCHING_WEIGHTS.availability, 6);
  });

  it('distance beyond the radius clamps to zero distance score', () => {
    const outside = matchingScore({
      distanceMeters: 40000,
      radiusMeters: RADIUS,
      rating: 0,
      isOnline: false,
    });
    expect(outside).toBe(0);
  });
});

describe('ETA from the average urban speed constant', () => {
  it('5 km at 25 km/h ≈ 12 minutes', () => {
    expect(estimatedTravelMinutes(5000)).toBe(12);
  });
  it('never returns less than 1 minute', () => {
    expect(estimatedTravelMinutes(50)).toBe(1);
  });
});
