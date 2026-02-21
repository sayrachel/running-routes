import type { RoutePoint } from './route-generator';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const TIMEOUT_MS = 5000;
const BBOX_BUFFER_DEG = 0.002; // ~200m buffer in degrees

/**
 * In-memory caches keyed by rounded keys.
 * Prevents redundant API calls for overlapping route candidates.
 */
const scenicCache = new Map<string, number>();
const quietCache = new Map<string, number>();
const greenSpaceCache = new Map<string, RoutePoint[]>();

/**
 * Compute bounding box from route points with a small buffer.
 * Returns [south, west, north, east] for Overpass bbox format.
 */
function getBbox(points: RoutePoint[]): [number, number, number, number] {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return [
    minLat - BBOX_BUFFER_DEG,
    minLng - BBOX_BUFFER_DEG,
    maxLat + BBOX_BUFFER_DEG,
    maxLng + BBOX_BUFFER_DEG,
  ];
}

/**
 * Round bbox to 3 decimal places for cache key stability.
 */
function bboxKey(bbox: [number, number, number, number]): string {
  return bbox.map((v) => v.toFixed(3)).join(',');
}

/**
 * Parse the count from an Overpass `out count;` response.
 * The response format is:
 *   { "elements": [{ "type": "count", "tags": { "total": "42", ... } }] }
 */
function parseOverpassCount(data: any): number {
  if (!data.elements || data.elements.length === 0) return 0;
  const el = data.elements[0];
  if (el.type === 'count' && el.tags && el.tags.total) {
    return parseInt(el.tags.total, 10) || 0;
  }
  // Fallback for non-count responses (if `out;` was used instead)
  return data.elements.length;
}

/**
 * Query Overpass API and return the count of elements matched.
 */
async function queryOverpass(query: string): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`Overpass API returned ${res.status}`);
      return -1;
    }

    const data = await res.json();
    return parseOverpassCount(data);
  } catch (err) {
    console.warn('Overpass query failed:', err);
    return -1;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch a scenic score (0–1) for route points.
 *
 * Queries Overpass for parks, gardens, nature reserves, water features,
 * and viewpoints within the route's bounding box. A higher density of
 * scenic features yields a higher score.
 *
 * Returns 0.5 (neutral) if the API fails.
 */
export async function fetchScenicScore(points: RoutePoint[]): Promise<number> {
  if (points.length < 2) return 0.5;

  const bbox = getBbox(points);
  const key = bboxKey(bbox);

  const cached = scenicCache.get(key);
  if (cached !== undefined) return cached;

  const bboxStr = bbox.join(',');
  const query = `[out:json][timeout:5];(
    node["leisure"="park"](${bboxStr});
    node["leisure"="garden"](${bboxStr});
    node["leisure"="nature_reserve"](${bboxStr});
    node["natural"="water"](${bboxStr});
    node["waterway"="river"](${bboxStr});
    node["waterway"="stream"](${bboxStr});
    node["natural"="coastline"](${bboxStr});
    node["tourism"="viewpoint"](${bboxStr});
    way["leisure"="park"](${bboxStr});
    way["natural"="water"](${bboxStr});
    way["waterway"="river"](${bboxStr});
  );out count;`;

  const count = await queryOverpass(query);

  if (count < 0) {
    scenicCache.set(key, 0.5);
    return 0.5;
  }

  // Normalize: 0 features → 0, 30+ features → 1.0
  const score = Math.min(count / 30, 1.0);
  scenicCache.set(key, score);
  return score;
}

/**
 * Fetch a quiet-street score (0–1) for route points.
 *
 * Queries Overpass for both major roads and quiet roads in a single request,
 * then computes the ratio. A higher fraction of quiet roads yields a higher score.
 *
 * Returns 0.5 (neutral) if the API fails.
 */
export async function fetchQuietScore(points: RoutePoint[]): Promise<number> {
  if (points.length < 2) return 0.5;

  const bbox = getBbox(points);
  const key = bboxKey(bbox);

  const cached = quietCache.get(key);
  if (cached !== undefined) return cached;

  const bboxStr = bbox.join(',');

  // Single query that fetches both major and quiet roads, then counts all
  const allRoadsQuery = `[out:json][timeout:5];(
    way["highway"="primary"](${bboxStr});
    way["highway"="secondary"](${bboxStr});
    way["highway"="trunk"](${bboxStr});
    way["highway"="primary_link"](${bboxStr});
    way["highway"="trunk_link"](${bboxStr});
    way["highway"="residential"](${bboxStr});
    way["highway"="living_street"](${bboxStr});
    way["highway"="path"](${bboxStr});
    way["highway"="footway"](${bboxStr});
    way["highway"="cycleway"](${bboxStr});
    way["highway"="pedestrian"](${bboxStr});
  );out tags;`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(allRoadsQuery)}`,
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`Overpass API returned ${res.status}`);
      quietCache.set(key, 0.5);
      return 0.5;
    }

    const data = await res.json();
    if (!data.elements || data.elements.length === 0) {
      quietCache.set(key, 0.5);
      return 0.5;
    }

    const majorTypes = new Set(['primary', 'secondary', 'trunk', 'primary_link', 'trunk_link']);
    let majorCount = 0;
    let quietCount = 0;

    for (const el of data.elements) {
      const hw = el.tags?.highway;
      if (majorTypes.has(hw)) majorCount++;
      else quietCount++;
    }

    const total = majorCount + quietCount;
    if (total === 0) {
      quietCache.set(key, 0.5);
      return 0.5;
    }

    const score = quietCount / total;
    quietCache.set(key, score);
    return score;
  } catch (err) {
    console.warn('Overpass quiet query failed:', err);
    quietCache.set(key, 0.5);
    return 0.5;
  } finally {
    clearTimeout(timeout);
  }
}

/** Haversine distance in km between two points (local helper for dedup) */
function haversineDistance(p1: RoutePoint, p2: RoutePoint): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(p2.lat - p1.lat);
  const dLng = toRad(p2.lng - p1.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Fetch green space locations (parks, trails, greenways, car-free paths)
 * near a center point within a given radius.
 *
 * Results are tiered and deduplicated:
 * - Tier 1 (high value): Parks + named paths/cycleways
 * - Tier 2 (lower value): Unnamed footways, paths, cycleways
 * Returns all Tier 1 + fills to 15 total from Tier 2 (nearest first).
 *
 * Returns [] on failure — callers skip biasing.
 */
export async function fetchGreenSpaceLocations(
  center: RoutePoint,
  radiusKm: number
): Promise<RoutePoint[]> {
  const cacheKey = `${center.lat.toFixed(3)},${center.lng.toFixed(3)},${radiusKm.toFixed(3)}`;
  const cached = greenSpaceCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const radiusMeters = Math.round(radiusKm * 1000);
  const lat = center.lat;
  const lng = center.lng;

  const query = `[out:json][timeout:5];(
    way["leisure"="park"](around:${radiusMeters},${lat},${lng});
    way["leisure"="nature_reserve"](around:${radiusMeters},${lat},${lng});
    way["leisure"="garden"](around:${radiusMeters},${lat},${lng});
    node["leisure"="park"](around:${radiusMeters},${lat},${lng});
    node["leisure"="nature_reserve"](around:${radiusMeters},${lat},${lng});
    node["leisure"="garden"](around:${radiusMeters},${lat},${lng});
    way["highway"="cycleway"](around:${radiusMeters},${lat},${lng});
    way["highway"="footway"](around:${radiusMeters},${lat},${lng});
    way["highway"="path"](around:${radiusMeters},${lat},${lng});
    way["highway"="pedestrian"](around:${radiusMeters},${lat},${lng});
    way["highway"="track"](around:${radiusMeters},${lat},${lng});
  );out center tags;`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`Overpass green space API returned ${res.status}`);
      greenSpaceCache.set(cacheKey, []);
      return [];
    }

    const data = await res.json();
    if (!data.elements || data.elements.length === 0) {
      greenSpaceCache.set(cacheKey, []);
      return [];
    }

    // Parse elements into points with tier info
    const tier1: RoutePoint[] = [];
    const tier2: RoutePoint[] = [];

    const leisureTypes = new Set(['park', 'nature_reserve', 'garden']);

    for (const el of data.elements) {
      let point: RoutePoint | null = null;

      if (el.type === 'node' && el.lat != null && el.lon != null) {
        point = { lat: el.lat, lng: el.lon };
      } else if (el.type === 'way' && el.center?.lat != null && el.center?.lon != null) {
        point = { lat: el.center.lat, lng: el.center.lon };
      }

      if (!point) continue;

      const tags = el.tags || {};
      const leisure = tags.leisure;
      const highway = tags.highway;
      const hasName = !!tags.name;

      // Tier 1: Parks or named paths/cycleways
      if (leisureTypes.has(leisure) || (highway && hasName)) {
        tier1.push(point);
      } else {
        tier2.push(point);
      }
    }

    // Deduplicate within 50m (0.05 km)
    const dedupThreshold = 0.05;
    const dedup = (points: RoutePoint[]): RoutePoint[] => {
      const result: RoutePoint[] = [];
      for (const p of points) {
        if (!result.some((r) => haversineDistance(r, p) < dedupThreshold)) {
          result.push(p);
        }
      }
      return result;
    };

    const dedupedTier1 = dedup(tier1);
    const dedupedTier2 = dedup(tier2);

    // Sort tier 2 by distance from center (nearest first)
    dedupedTier2.sort(
      (a, b) => haversineDistance(center, a) - haversineDistance(center, b)
    );

    // All tier 1 + fill to 15 from tier 2
    const maxTotal = 15;
    const remaining = Math.max(0, maxTotal - dedupedTier1.length);
    const result = [...dedupedTier1, ...dedupedTier2.slice(0, remaining)];

    greenSpaceCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.warn('Overpass green space query failed:', err);
    greenSpaceCache.set(cacheKey, []);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
