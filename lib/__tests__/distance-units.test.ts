/**
 * Tests documenting distance unit bugs and slider behavior.
 *
 * Key bugs identified:
 * 1. GeneratedRoute.distance type says "in km" but osrm.ts stores miles
 * 2. Math.round on miles causes precision loss for short distances
 * 3. Distance slider functions (fractionToValueFn, valueToFractionFn) in index.tsx
 */

// Re-implement the slider functions here since they are not exported from a module
// (they live inside a React component file). These mirror the exact code in app/index.tsx.
function valueToFractionFn(v: number) {
  if (v <= 5) return ((v - 1) / 4) * 0.5;
  return 0.5 + ((v - 5) / 25) * 0.5;
}

function fractionToValueFn(f: number) {
  if (f <= 0.5) return 1 + (f / 0.5) * 4;
  return 5 + ((f - 0.5) / 0.5) * 25;
}

describe('distance unit mismatch bug', () => {
  it('route-generator.ts interface says "in km" but osrm.ts stores miles', () => {
    // In route-generator.ts, GeneratedRoute.distance is annotated: "in km"
    // In osrm.ts line 1014: distanceMiles = Math.round(candidate.distKm * 0.621371)
    // This means the distance field actually contains MILES, not km.
    // This test documents the bug by verifying the conversion factor used.
    const distKm = 10;
    const distanceMiles = Math.round(distKm * 0.621371);
    expect(distanceMiles).toBe(6); // 10 km = 6.21371 mi, rounded to 6
    // BUG: The interface comment says "in km" but the value is in miles
  });

  it('Math.round causes precision loss for short runs', () => {
    // A 2.4 km route:
    const distKm = 2.4;
    const distanceMiles = Math.round(distKm * 0.621371);
    // 2.4 * 0.621371 = 1.4913 → Math.round → 1
    expect(distanceMiles).toBe(1);
    // A more precise value would be 1.5 mi, but Math.round loses that.
    // For very short runs (< 0.8 km = 0.5 mi), distance becomes 0:
    const shortDistKm = 0.7;
    const shortMiles = Math.round(shortDistKm * 0.621371);
    expect(shortMiles).toBe(0); // BUG: displays as "0 mi" for short runs
  });
});

describe('distance slider: valueToFractionFn', () => {
  it('maps 1 to 0', () => {
    expect(valueToFractionFn(1)).toBeCloseTo(0, 10);
  });

  it('maps 5 to 0.5', () => {
    expect(valueToFractionFn(5)).toBeCloseTo(0.5, 10);
  });

  it('maps 30 to 1.0', () => {
    expect(valueToFractionFn(30)).toBeCloseTo(1.0, 10);
  });

  it('maps 3 to 0.25 (midpoint of lower range)', () => {
    expect(valueToFractionFn(3)).toBeCloseTo(0.25, 10);
  });

  it('maps 17.5 to 0.75 (midpoint of upper range)', () => {
    expect(valueToFractionFn(17.5)).toBeCloseTo(0.75, 10);
  });
});

describe('distance slider: fractionToValueFn', () => {
  it('maps 0 to 1', () => {
    expect(fractionToValueFn(0)).toBeCloseTo(1, 10);
  });

  it('maps 0.5 to 5', () => {
    expect(fractionToValueFn(0.5)).toBeCloseTo(5, 10);
  });

  it('maps 1.0 to 30', () => {
    expect(fractionToValueFn(1.0)).toBeCloseTo(30, 10);
  });
});

describe('distance slider round-trip', () => {
  it('fractionToValueFn(valueToFractionFn(x)) ≈ x for all valid integer values', () => {
    for (let v = 1; v <= 30; v++) {
      const fraction = valueToFractionFn(v);
      const roundTrip = fractionToValueFn(fraction);
      expect(roundTrip).toBeCloseTo(v, 8);
    }
  });

  it('valueToFractionFn(fractionToValueFn(f)) ≈ f for sampled fractions', () => {
    for (let f = 0; f <= 1.0; f += 0.05) {
      const value = fractionToValueFn(f);
      const roundTrip = valueToFractionFn(value);
      expect(roundTrip).toBeCloseTo(f, 8);
    }
  });
});
