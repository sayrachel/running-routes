import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { GeneratedRoute, RoutePoint } from './route-generator';

/**
 * Sample evenly-spaced waypoints from a route.
 */
function sampleWaypoints(points: RoutePoint[], maxWaypoints: number): RoutePoint[] {
  if (points.length <= maxWaypoints) return points;
  const step = (points.length - 1) / (maxWaypoints - 1);
  const sampled: RoutePoint[] = [];
  for (let i = 0; i < maxWaypoints; i++) {
    sampled.push(points[Math.round(i * step)]);
  }
  return sampled;
}

/**
 * Build a Google Maps Directions URL from a route.
 *
 * Mapbox routes (CLAUDE.md #64) hand Google the route's own waypoints — the
 * inputs we sent Mapbox — instead of points sampled from Mapbox's polyline,
 * which its terms don't let us export.
 */
export function buildGoogleMapsUrl(route: GeneratedRoute): string {
  const pts = route.source === 'mapbox' ? route.waypoints ?? [] : route.points;
  if (pts.length < 2) return '';

  const origin = `${pts[0].lat},${pts[0].lng}`;
  const destination = `${pts[pts.length - 1].lat},${pts[pts.length - 1].lng}`;

  const intermediates = pts.slice(1, -1);
  const sampled = sampleWaypoints(intermediates, 9);
  const waypointsStr = sampled.map((p) => `${p.lat},${p.lng}`).join('|');

  const params = new URLSearchParams({
    api: '1',
    origin,
    destination,
    travelmode: 'walking',
  });

  if (waypointsStr) {
    params.set('waypoints', waypointsStr);
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** GPX export is off for Mapbox routes: Mapbox's terms bar exporting its
 *  results (CLAUDE.md #64). */
export function canExportGpx(route: GeneratedRoute): boolean {
  return route.source !== 'mapbox';
}

/**
 * Generate a GPX XML string from a route.
 */
export function generateGpx(route: GeneratedRoute): string {
  if (!canExportGpx(route)) throw new Error('GPX export is not available for Mapbox routes');
  const timestamp = new Date().toISOString();

  const trackpoints = route.points
    .map(
      (p) =>
        `      <trkpt lat="${p.lat}" lon="${p.lng}">\n        <ele>0</ele>\n      </trkpt>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Run Routes"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${route.name}</name>
    <desc>${route.terrain} route - ${route.distance.toFixed(1)} km - ${route.difficulty}</desc>
    <time>${timestamp}</time>
  </metadata>
  <trk>
    <name>${route.name}</name>
    <type>running</type>
    <trkseg>
${trackpoints}
    </trkseg>
  </trk>
</gpx>`;
}

/**
 * Share a GPX file via the native share sheet.
 */
export async function shareGpx(route: GeneratedRoute): Promise<void> {
  const gpxContent = generateGpx(route);
  const filename = `${route.name.toLowerCase().replace(/\s+/g, '-')}.gpx`;
  const fileUri = FileSystem.cacheDirectory + filename;

  await FileSystem.writeAsStringAsync(fileUri, gpxContent, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(fileUri, {
      mimeType: 'application/gpx+xml',
      dialogTitle: `Share ${route.name} GPX`,
    });
  }
}
