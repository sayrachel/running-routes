import type { RoutePoint } from './route-generator';

const OPEN_ELEVATION_URL = 'https://api.open-elevation.com/api/v1/lookup';
const TIMEOUT_MS = 5000;
const SAMPLE_COUNT = 25;

interface ElevationResult {
  latitude: number;
  longitude: number;
  elevation: number;
}

interface ElevationAPIResponse {
  results: ElevationResult[];
}

export interface ElevationProfile {
  elevations: number[];
  totalGain: number;
  totalLoss: number;
}

/**
 * Sample points evenly along a polyline of route points.
 * Returns ~SAMPLE_COUNT points spaced evenly by index.
 */
function samplePoints(points: RoutePoint[], count: number): RoutePoint[] {
  if (points.length <= count) return points;
  const step = (points.length - 1) / (count - 1);
  const sampled: RoutePoint[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.min(Math.round(i * step), points.length - 1);
    sampled.push(points[idx]);
  }
  return sampled;
}

/**
 * Calculate total elevation gain and loss from an array of elevations.
 */
function computeGainLoss(elevations: number[]): { totalGain: number; totalLoss: number } {
  let totalGain = 0;
  let totalLoss = 0;
  for (let i = 1; i < elevations.length; i++) {
    const diff = elevations[i] - elevations[i - 1];
    if (diff > 0) totalGain += diff;
    else totalLoss += Math.abs(diff);
  }
  return { totalGain: Math.round(totalGain), totalLoss: Math.round(totalLoss) };
}

/**
 * Fetch real elevation profile for a set of route points using the Open-Elevation API.
 * Samples ~25 points evenly along the route, queries the API, and computes gain/loss.
 *
 * Falls back to null if the API fails or times out, so the caller can use fabricated data.
 */
export async function fetchElevationProfile(
  points: RoutePoint[]
): Promise<ElevationProfile | null> {
  if (points.length < 2) return null;

  const sampled = samplePoints(points, SAMPLE_COUNT);
  const locations = sampled.map((p) => ({ latitude: p.lat, longitude: p.lng }));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(OPEN_ELEVATION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`Open-Elevation API returned ${res.status}`);
      return null;
    }

    const data: ElevationAPIResponse = await res.json();

    if (!data.results || data.results.length === 0) {
      console.warn('Open-Elevation API returned empty results');
      return null;
    }

    const elevations = data.results.map((r) => r.elevation);
    const { totalGain, totalLoss } = computeGainLoss(elevations);

    return { elevations, totalGain, totalLoss };
  } catch (err) {
    console.warn('Elevation fetch failed:', err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
