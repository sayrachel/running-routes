/**
 * Tests for UI formatting functions from app/run.tsx and app/index.tsx.
 * These functions are copied here since they're defined inline in component files.
 */

// Copied from app/run.tsx
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Copied from app/index.tsx
function haversineDistanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

describe('formatTime', () => {
  it('formats 0 seconds as "00:00"', () => {
    expect(formatTime(0)).toBe('00:00');
  });

  it('formats 61 seconds as "01:01"', () => {
    expect(formatTime(61)).toBe('01:01');
  });

  it('formats 3661 seconds as "1:01:01"', () => {
    expect(formatTime(3661)).toBe('1:01:01');
  });

  it('formats 59 seconds as "00:59"', () => {
    expect(formatTime(59)).toBe('00:59');
  });

  it('formats 60 seconds as "01:00"', () => {
    expect(formatTime(60)).toBe('01:00');
  });

  it('formats 3600 seconds as "1:00:00"', () => {
    expect(formatTime(3600)).toBe('1:00:00');
  });

  it('formats 7261 seconds (2h1m1s) as "2:01:01"', () => {
    expect(formatTime(7261)).toBe('2:01:01');
  });
});

describe('haversineDistanceMiles', () => {
  it('returns 0 for the same point', () => {
    expect(haversineDistanceMiles(40.7128, -74.006, 40.7128, -74.006)).toBe(0);
  });

  it('uses miles (R=3958.8), not km', () => {
    // NYC to LA known distance ~2451 miles
    const dist = haversineDistanceMiles(40.7128, -74.006, 34.0522, -118.2437);
    expect(dist).toBeGreaterThan(2400);
    expect(dist).toBeLessThan(2500);
  });

  it('returns reasonable distance for nearby points', () => {
    // Two points about 1 mile apart
    const dist = haversineDistanceMiles(40.7128, -74.006, 40.7273, -74.006);
    expect(dist).toBeGreaterThan(0.5);
    expect(dist).toBeLessThan(2.0);
  });
});
