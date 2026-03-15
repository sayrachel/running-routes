import type { RoutePoint } from './route-generator';

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const TIMEOUT_MS = 4000;
const BBOX_BUFFER_DEG = 0.002; // ~200m buffer in degrees

/** Enriched green space with metadata for waypoint selection */
export interface GreenSpace {
  point: RoutePoint;
  tier: 1 | 2;
  kind: 'park' | 'garden' | 'nature' | 'path' | 'cycleway' | 'footway' | 'route' | 'other';
  name: string | null;
  areaSize: number; // estimated area in km², 0 for linear features
}

/**
 * In-memory caches keyed by rounded keys.
 * Prevents redundant API calls for overlapping route candidates.
 */
const scenicCache = new Map<string, number>();
const quietCache = new Map<string, number>();
const greenSpaceCache = new Map<string, RoutePoint[]>();
const enrichedGreenSpaceCache = new Map<string, GreenSpace[]>();

/**
 * Compute bounding box from route points with a small buffer.
 * Returns [south, west, north, east] for Overpass bbox format.
 */
export function getBbox(points: RoutePoint[]): [number, number, number, number] {
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
export function bboxKey(bbox: [number, number, number, number]): string {
  return bbox.map((v) => v.toFixed(3)).join(',');
}

/**
 * Parse the count from an Overpass `out count;` response.
 * The response format is:
 *   { "elements": [{ "type": "count", "tags": { "total": "42", ... } }] }
 */
export function parseOverpassCount(data: any): number {
  if (!data.elements || data.elements.length === 0) return 0;
  const el = data.elements[0];
  if (el.type === 'count' && el.tags && el.tags.total) {
    return parseInt(el.tags.total, 10) || 0;
  }
  // Fallback for non-count responses (if `out;` was used instead)
  return data.elements.length;
}

/**
 * Race a request against multiple Overpass servers.
 * Returns the first successful response, aborting the rest.
 */
async function fetchOverpassRace(
  query: string,
  timeoutMs: number = TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const body = `data=${encodeURIComponent(query)}`;

  try {
    const response = await Promise.any(
      OVERPASS_URLS.map((url) =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: controller.signal,
        }).then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res;
        })
      )
    );
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Query Overpass API and return the count of elements matched.
 */
async function queryOverpass(query: string): Promise<number> {
  try {
    const res = await fetchOverpassRace(query);
    const data = await res.json();
    return parseOverpassCount(data);
  } catch (err) {
    console.warn('Overpass query failed:', err);
    return -1;
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

  try {
    const res = await fetchOverpassRace(allRoadsQuery);
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
 * Fetch enriched green space data (parks, trails, greenways, car-free paths)
 * near a center point within a given radius.
 *
 * Returns GreenSpace objects with tier, kind, name, and estimated area.
 * Uses `out center bb tags;` to get bounding box data for area estimation.
 *
 * Returns [] on failure — callers skip biasing.
 */
export async function fetchGreenSpacesEnriched(
  center: RoutePoint,
  radiusKm: number
): Promise<GreenSpace[]> {
  const cacheKey = `enriched:${center.lat.toFixed(3)},${center.lng.toFixed(3)},${radiusKm.toFixed(3)}`;
  const cached = enrichedGreenSpaceCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const radiusMeters = Math.round(radiusKm * 1000);
  const lat = center.lat;
  const lng = center.lng;

  // Streamlined query: focus on parks/gardens/reserves (waypoint selection)
  // and named cycleways/routes (scoring). Skip unnamed footways/paths/tracks
  // which return huge result sets and slow the query considerably.
  const query = `[out:json][timeout:4];(
    way["leisure"="park"](around:${radiusMeters},${lat},${lng});
    way["leisure"="nature_reserve"](around:${radiusMeters},${lat},${lng});
    way["leisure"="garden"](around:${radiusMeters},${lat},${lng});
    node["leisure"="park"](around:${radiusMeters},${lat},${lng});
    node["leisure"="nature_reserve"](around:${radiusMeters},${lat},${lng});
    way["highway"="cycleway"]["name"](around:${radiusMeters},${lat},${lng});
    way["highway"="pedestrian"](around:${radiusMeters},${lat},${lng});
    relation["route"="foot"](around:${radiusMeters},${lat},${lng});
    relation["route"="bicycle"](around:${radiusMeters},${lat},${lng});
    relation["route"="running"](around:${radiusMeters},${lat},${lng});
    way["foot"="designated"]["name"](around:${radiusMeters},${lat},${lng});
  );out center bb tags;`;

  try {
    const res = await fetchOverpassRace(query);
    const data = await res.json();
    if (!data.elements || data.elements.length === 0) {
      enrichedGreenSpaceCache.set(cacheKey, []);
      return [];
    }

    const leisureTypes = new Set(['park', 'nature_reserve', 'garden']);
    const results: GreenSpace[] = [];

    for (const el of data.elements) {
      let point: RoutePoint | null = null;

      if (el.type === 'node' && el.lat != null && el.lon != null) {
        point = { lat: el.lat, lng: el.lon };
      } else if (el.type === 'way' && el.center?.lat != null && el.center?.lon != null) {
        point = { lat: el.center.lat, lng: el.center.lon };
      } else if (el.type === 'relation' && el.center?.lat != null && el.center?.lon != null) {
        point = { lat: el.center.lat, lng: el.center.lon };
      }

      if (!point) continue;

      const tags = el.tags || {};
      const leisure = tags.leisure;
      const highway = tags.highway;
      const hasName = !!tags.name;
      const footDesignated = tags.foot === 'designated';
      const bicycleDesignated = tags.bicycle === 'designated';
      const isRoute = el.type === 'relation' && (tags.route === 'foot' || tags.route === 'bicycle' || tags.route === 'running');

      // Classify kind
      let kind: GreenSpace['kind'];
      if (leisure === 'park') kind = 'park';
      else if (leisure === 'garden') kind = 'garden';
      else if (leisure === 'nature_reserve') kind = 'nature';
      else if (highway === 'cycleway') kind = 'cycleway';
      else if (highway === 'footway') kind = 'footway';
      else if (highway === 'path' || highway === 'pedestrian' || highway === 'track') kind = 'path';
      else if (isRoute) kind = 'route';
      else kind = 'other';

      // Classify tier
      const tier: 1 | 2 =
        leisureTypes.has(leisure) || (highway && hasName) || footDesignated || bicycleDesignated || isRoute
          ? 1
          : 2;

      // Estimate area from bounding box (ways only)
      let areaSize = 0;
      if (el.bounds && el.bounds.minlat != null) {
        const latSpan = Math.abs(el.bounds.maxlat - el.bounds.minlat);
        const lngSpan = Math.abs(el.bounds.maxlon - el.bounds.minlon);
        // Convert degrees to approximate km (1° lat ≈ 111km, 1° lng ≈ 111*cos(lat) km)
        const latKm = latSpan * 111;
        const lngKm = lngSpan * 111 * Math.cos((point.lat * Math.PI) / 180);
        areaSize = latKm * lngKm;
      }

      results.push({
        point,
        tier,
        kind,
        name: tags.name || null,
        areaSize,
      });
    }

    // Deduplicate within 50m
    const dedupThreshold = 0.05;
    const deduped: GreenSpace[] = [];
    for (const gs of results) {
      if (!deduped.some((r) => haversineDistance(r.point, gs.point) < dedupThreshold)) {
        deduped.push(gs);
      }
    }

    // Sort: tier 1 first, then by area descending
    deduped.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return b.areaSize - a.areaSize;
    });

    // Cap at 50 results
    const capped = deduped.slice(0, 50);
    enrichedGreenSpaceCache.set(cacheKey, capped);
    return capped;
  } catch (err) {
    console.warn('Overpass enriched green space query failed:', err);
    enrichedGreenSpaceCache.set(cacheKey, []);
    return [];
  }
}

/**
 * Fetch green space locations (parks, trails, greenways, car-free paths)
 * near a center point within a given radius.
 *
 * Wraps fetchGreenSpacesEnriched and returns just the points for backward compatibility.
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

  const enriched = await fetchGreenSpacesEnriched(center, radiusKm);
  const result = enriched.map((gs) => gs.point);
  greenSpaceCache.set(cacheKey, result);
  return result;
}
