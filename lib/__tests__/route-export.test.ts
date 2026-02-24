import { buildGoogleMapsUrl, generateGpx } from '../route-export';
import type { GeneratedRoute, RoutePoint } from '../route-generator';

function makeRoute(pointCount: number, overrides: Partial<GeneratedRoute> = {}): GeneratedRoute {
  const points: RoutePoint[] = Array.from({ length: pointCount }, (_, i) => ({
    lat: 40.0 + i * 0.01,
    lng: -74.0 + i * 0.005,
  }));
  return {
    id: 'test-route',
    name: 'Test Route',
    points,
    distance: 5.0,
    estimatedTime: 30,
    elevationGain: 50,
    terrain: 'Loop',
    difficulty: 'easy',
    ...overrides,
  };
}

describe('buildGoogleMapsUrl', () => {
  it('includes origin, destination, and walking mode', () => {
    const route = makeRoute(5);
    const url = buildGoogleMapsUrl(route);
    expect(url).toContain('origin=40');
    expect(url).toContain('destination=40');
    expect(url).toContain('travelmode=walking');
  });

  it('samples max 9 intermediate waypoints', () => {
    const route = makeRoute(20); // 20 points → 18 intermediates
    const url = buildGoogleMapsUrl(route);
    // Count pipes in waypoints param (max 9 waypoints → max 8 pipes)
    const waypointsMatch = url.match(/waypoints=([^&]*)/);
    expect(waypointsMatch).not.toBeNull();
    const waypoints = waypointsMatch![1].split('%7C'); // URL-encoded pipe
    // Could also be literal pipe depending on encoding
    const waypointCount = waypoints.length > 1
      ? waypoints.length
      : waypointsMatch![1].split('|').length;
    expect(waypointCount).toBeLessThanOrEqual(9);
  });

  it('returns empty string for < 2 points', () => {
    const route = makeRoute(1);
    expect(buildGoogleMapsUrl(route)).toBe('');

    const emptyRoute = makeRoute(0, { points: [] });
    expect(buildGoogleMapsUrl(emptyRoute)).toBe('');
  });

  it('works with exactly 2 points (no intermediates)', () => {
    const route = makeRoute(2);
    const url = buildGoogleMapsUrl(route);
    expect(url).toContain('origin=');
    expect(url).toContain('destination=');
    expect(url).not.toContain('waypoints=');
  });
});

describe('generateGpx', () => {
  it('produces valid XML with XML declaration', () => {
    const route = makeRoute(3);
    const gpx = generateGpx(route);
    expect(gpx).toContain('<?xml version="1.0"');
    expect(gpx).toContain('<gpx version="1.1"');
    expect(gpx).toContain('</gpx>');
  });

  it('includes correct lat/lon attributes', () => {
    const route = makeRoute(3);
    const gpx = generateGpx(route);
    for (const p of route.points) {
      expect(gpx).toContain(`lat="${p.lat}"`);
      expect(gpx).toContain(`lon="${p.lng}"`);
    }
  });

  it('includes route name and metadata', () => {
    const route = makeRoute(3, { name: 'Central Park Loop' });
    const gpx = generateGpx(route);
    expect(gpx).toContain('<name>Central Park Loop</name>');
    expect(gpx).toContain('<type>running</type>');
  });

  it('includes track segment with all trackpoints', () => {
    const route = makeRoute(5);
    const gpx = generateGpx(route);
    expect(gpx).toContain('<trkseg>');
    expect(gpx).toContain('</trkseg>');
    // Count trkpt elements
    const trkptCount = (gpx.match(/<trkpt /g) || []).length;
    expect(trkptCount).toBe(5);
  });

  it('includes elevation elements', () => {
    const route = makeRoute(2);
    const gpx = generateGpx(route);
    expect(gpx).toContain('<ele>0</ele>');
  });
});
