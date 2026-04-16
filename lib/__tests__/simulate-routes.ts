/**
 * Route quality simulation — run against live OSRM + Overpass APIs.
 *
 * Usage:
 *   npx ts-node lib/__tests__/simulate-routes.ts
 *   npx ts-node lib/__tests__/simulate-routes.ts --lat 40.72 --lng -73.95 --dist 5
 *
 * Generates routes for real locations and prints:
 *   - Route name, distance, waypoint count
 *   - Scoring breakdown (green, waterfront, run-path, highway)
 *   - Google Maps link to visualize the route
 */

import { generateOSRMRoutes } from '../osrm';
import type { RoutePoint } from '../route-generator';

const PRESETS: Record<string, { center: RoutePoint; label: string }> = {
  columbus_circle: { center: { lat: 40.768, lng: -73.982 }, label: 'Columbus Circle, NYC' },
  williamsburg: { center: { lat: 40.714, lng: -73.961 }, label: 'Williamsburg, Brooklyn' },
  lower_east_side: { center: { lat: 40.715, lng: -73.985 }, label: 'Lower East Side, NYC' },
  sf_embarcadero: { center: { lat: 37.795, lng: -122.394 }, label: 'Embarcadero, SF' },
  chicago_lakefront: { center: { lat: 41.886, lng: -87.616 }, label: 'Lakefront, Chicago' },
};

function googleMapsUrl(points: RoutePoint[]): string {
  // Sample ~20 points evenly for a viewable polyline
  const step = Math.max(1, Math.floor(points.length / 20));
  const sampled = points.filter((_, i) => i % step === 0);
  // Use Google Maps directions with waypoints
  const origin = `${sampled[0].lat},${sampled[0].lng}`;
  const dest = `${sampled[sampled.length - 1].lat},${sampled[sampled.length - 1].lng}`;
  const waypoints = sampled.slice(1, -1).map(p => `${p.lat},${p.lng}`).join('|');
  return `https://www.google.com/maps/dir/${origin}/${waypoints ? waypoints + '/' : ''}${dest}/@${sampled[0].lat},${sampled[0].lng},14z/data=!4m2!4m1!3e2`;
}

function geojsonIoUrl(points: RoutePoint[]): string {
  const coords = points.map(p => [p.lng, p.lat]);
  const geojson = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: coords },
    }],
  };
  return `https://geojson.io/#data=data:application/json,${encodeURIComponent(JSON.stringify(geojson))}`;
}

async function simulate(center: RoutePoint, label: string, distanceKm: number) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📍 ${label} — ${distanceKm}km loop`);
  console.log('='.repeat(70));

  try {
    const routes = await generateOSRMRoutes(center, distanceKm, 'loop', 1, { lowTraffic: false });

    if (routes.length === 0) {
      console.log('  ❌ No routes generated');
      return;
    }

    for (const route of routes) {
      console.log(`\n  🏃 ${route.name}`);
      console.log(`     Distance: ${route.distance} mi (${(route.distance / 0.621371).toFixed(1)} km)`);
      console.log(`     Time: ${route.estimatedTime} min`);
      console.log(`     Points: ${route.points.length}`);
      console.log(`     Difficulty: ${route.difficulty}`);
      console.log(`     Terrain: ${route.terrain}`);
      console.log(`\n     🗺️  View route:`);
      console.log(`     ${geojsonIoUrl(route.points)}`);
    }
  } catch (err) {
    console.log(`  ❌ Error: ${err}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  let lat: number | null = null;
  let lng: number | null = null;
  let dist = 5;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lat') lat = parseFloat(args[i + 1]);
    if (args[i] === '--lng') lng = parseFloat(args[i + 1]);
    if (args[i] === '--dist') dist = parseFloat(args[i + 1]);
  }

  if (lat !== null && lng !== null) {
    await simulate({ lat, lng }, `Custom (${lat}, ${lng})`, dist);
  } else {
    // Run all presets
    const distances = [3, 5, 8];
    for (const [, preset] of Object.entries(PRESETS)) {
      for (const d of distances) {
        await simulate(preset.center, preset.label, d);
      }
    }
  }
}

main().catch(console.error);
