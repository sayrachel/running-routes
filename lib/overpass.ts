import type { RoutePoint } from './route-generator';

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const TIMEOUT_MS = 3000;
const BBOX_BUFFER_DEG = 0.002; // ~200m buffer in degrees

/** Enriched green space with metadata for waypoint selection */
export interface GreenSpace {
  point: RoutePoint;
  tier: 1 | 2;
  kind: 'park' | 'garden' | 'nature' | 'path' | 'cycleway' | 'footway' | 'route' | 'waterfront' | 'other';
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
const highwayCache = new Map<string, RoutePoint[]>();

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
/** Set of `highway=*` values considered "major" (unsafe for runners). */
const MAJOR_HIGHWAY_TYPES = new Set([
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
]);

/** Overpass sub-queries shared by the green-space and combined fetchers. */
function greenSpaceSubQuery(a: string): string {
  return [
    `nwr["leisure"~"^(park|nature_reserve|garden)$"](${a});`,
    `way["highway"="cycleway"]["name"](${a});`,
    `way["highway"="pedestrian"](${a});`,
    `relation["route"~"^(foot|bicycle|running)$"](${a});`,
    `way["foot"="designated"]["name"](${a});`,
    `way["man_made"="pier"]["foot"!="no"](${a});`,
    `way["waterway"="riverbank"](${a});`,
    `way["natural"~"^(coastline|water)$"]["name"](${a});`,
    `way["name"~"[Bb]oardwalk|[Pp]romenade|[Ee]splanade|[Ww]aterfront|[Rr]iverwalk|[Ss]eawall"](${a});`,
  ].join('');
}

function highwaySubQuery(a: string): string {
  return `way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link)$"](${a});`;
}

/** Convert one Overpass element to a coordinate, or null if it has no usable position. */
function elementPoint(el: any): RoutePoint | null {
  if (el.type === 'node' && el.lat != null && el.lon != null) {
    return { lat: el.lat, lng: el.lon };
  }
  if ((el.type === 'way' || el.type === 'relation') && el.center?.lat != null && el.center?.lon != null) {
    return { lat: el.center.lat, lng: el.center.lon };
  }
  return null;
}

/** Build GreenSpace[] from the green-space subset of an Overpass response. */
function parseGreenSpaceElements(elements: any[]): GreenSpace[] {
  const leisureTypes = new Set(['park', 'nature_reserve', 'garden']);
  const results: GreenSpace[] = [];

  for (const el of elements) {
    const point = elementPoint(el);
    if (!point) continue;

    const tags = el.tags || {};
    const leisure = tags.leisure;
    const highway = tags.highway;
    const hasName = !!tags.name;
    const footDesignated = tags.foot === 'designated';
    const bicycleDesignated = tags.bicycle === 'designated';
    const isRoute = el.type === 'relation' && (tags.route === 'foot' || tags.route === 'bicycle' || tags.route === 'running');
    const isWaterfront = !!(
      tags.natural === 'coastline' ||
      tags.natural === 'water' ||
      tags.waterway === 'riverbank' ||
      tags.waterway ||
      tags.man_made === 'pier' ||
      leisure === 'promenade' ||
      (tags.name && /boardwalk|promenade|esplanade|waterfront|riverwalk|seawall|beach walk/i.test(tags.name))
    );

    let kind: GreenSpace['kind'];
    if (isWaterfront) kind = 'waterfront';
    else if (leisure === 'park') kind = 'park';
    else if (leisure === 'garden') kind = 'garden';
    else if (leisure === 'nature_reserve') kind = 'nature';
    else if (highway === 'cycleway') kind = 'cycleway';
    else if (highway === 'footway') kind = 'footway';
    else if (highway === 'path' || highway === 'pedestrian' || highway === 'track') kind = 'path';
    else if (isRoute) kind = 'route';
    else kind = 'other';

    const tier: 1 | 2 =
      leisureTypes.has(leisure) || (highway && hasName) || footDesignated || bicycleDesignated || isRoute || isWaterfront
        ? 1
        : 2;

    let areaSize = 0;
    if (el.bounds && el.bounds.minlat != null) {
      const latSpan = Math.abs(el.bounds.maxlat - el.bounds.minlat);
      const lngSpan = Math.abs(el.bounds.maxlon - el.bounds.minlon);
      const latKm = latSpan * 111;
      const lngKm = lngSpan * 111 * Math.cos((point.lat * Math.PI) / 180);
      areaSize = latKm * lngKm;
    }

    results.push({ point, tier, kind, name: tags.name || null, areaSize });
  }

  // Deduplicate within 50m
  const deduped: GreenSpace[] = [];
  for (const gs of results) {
    if (!deduped.some((r) => haversineDistance(r.point, gs.point) < 0.05)) {
      deduped.push(gs);
    }
  }

  // Sort: tier 1 first, then by area descending. Cap at 50.
  deduped.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : b.areaSize - a.areaSize));
  return deduped.slice(0, 50);
}

/** Build deduplicated highway centers from the highway subset of an Overpass response. */
function parseHighwayElements(elements: any[]): RoutePoint[] {
  const points: RoutePoint[] = [];
  for (const el of elements) {
    if (el.center?.lat != null && el.center?.lon != null) {
      points.push({ lat: el.center.lat, lng: el.center.lon });
    }
  }
  // Deduplicate within 100m
  const deduped: RoutePoint[] = [];
  for (const p of points) {
    if (!deduped.some((d) => haversineDistance(d, p) < 0.1)) deduped.push(p);
  }
  return deduped;
}

/** Cache key for a (center, radiusKm) tuple. Rounded to ~111m so nearby starts share hits. */
function locationKey(prefix: string, center: RoutePoint, radiusKm: number): string {
  return `${prefix}:${center.lat.toFixed(3)},${center.lng.toFixed(3)},${radiusKm.toFixed(3)}`;
}

export async function fetchGreenSpacesEnriched(
  center: RoutePoint,
  radiusKm: number
): Promise<GreenSpace[]> {
  const cacheKey = locationKey('enriched', center, radiusKm);
  const cached = enrichedGreenSpaceCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const radiusMeters = Math.round(radiusKm * 1000);
  const a = `around:${radiusMeters},${center.lat},${center.lng}`;
  const query = `[out:json][timeout:4];(${greenSpaceSubQuery(a)});out center bb tags;`;

  try {
    const res = await fetchOverpassRace(query);
    const data = await res.json();
    const elements = data.elements || [];
    const result = parseGreenSpaceElements(elements);
    enrichedGreenSpaceCache.set(cacheKey, result);
    return result;
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

/**
 * Fetch major highway/road center points near a location.
 *
 * Queries Overpass for motorways, trunk roads, and primary roads —
 * roads that are unsafe or illegal for runners. Returns center points
 * of matched way segments so route candidates can be checked for
 * highway proximity.
 *
 * Returns [] on failure — callers treat the route as safe.
 */
export async function fetchHighwaySegments(
  center: RoutePoint,
  radiusKm: number
): Promise<RoutePoint[]> {
  const cacheKey = locationKey('highway', center, radiusKm);
  const cached = highwayCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const radiusMeters = Math.round(radiusKm * 1000);
  const a = `around:${radiusMeters},${center.lat},${center.lng}`;
  const query = `[out:json][timeout:4];(${highwaySubQuery(a)});out center;`;

  try {
    const res = await fetchOverpassRace(query);
    const data = await res.json();
    const result = parseHighwayElements(data.elements || []);
    highwayCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.warn('Overpass highway query failed:', err);
    highwayCache.set(cacheKey, []);
    return [];
  }
}

/**
 * Fetch enriched green spaces and major-highway centers in a single Overpass
 * round trip. The two queries hit the same bbox and return disjoint tag sets
 * (`leisure`/cycleway/etc. vs `highway=motorway|trunk|primary`), so they can
 * be unioned and split client-side. Halves the Overpass fan-out vs calling
 * fetchGreenSpacesEnriched + fetchHighwaySegments in parallel, and populates
 * both per-query caches so subsequent callers of either function get hits.
 */
export async function fetchGreenSpacesAndHighways(
  center: RoutePoint,
  radiusKm: number
): Promise<{ greenSpaces: GreenSpace[]; highwayPoints: RoutePoint[] }> {
  const greenKey = locationKey('enriched', center, radiusKm);
  const hwKey = locationKey('highway', center, radiusKm);

  const cachedGreen = enrichedGreenSpaceCache.get(greenKey);
  const cachedHw = highwayCache.get(hwKey);
  if (cachedGreen !== undefined && cachedHw !== undefined) {
    return { greenSpaces: cachedGreen, highwayPoints: cachedHw };
  }

  const radiusMeters = Math.round(radiusKm * 1000);
  const a = `around:${radiusMeters},${center.lat},${center.lng}`;
  // Combined union — `out center bb tags;` works for both halves; highway
  // parsing only needs `center`, but the extra `bb tags` payload is small.
  const query = `[out:json][timeout:5];(${greenSpaceSubQuery(a)}${highwaySubQuery(a)});out center bb tags;`;

  try {
    const res = await fetchOverpassRace(query);
    const data = await res.json();
    const elements = data.elements || [];

    const greenElements: any[] = [];
    const highwayElements: any[] = [];
    for (const el of elements) {
      if (MAJOR_HIGHWAY_TYPES.has(el.tags?.highway)) highwayElements.push(el);
      else greenElements.push(el);
    }

    const greenSpaces = parseGreenSpaceElements(greenElements);
    const highwayPoints = parseHighwayElements(highwayElements);

    enrichedGreenSpaceCache.set(greenKey, greenSpaces);
    highwayCache.set(hwKey, highwayPoints);
    return { greenSpaces, highwayPoints };
  } catch (err) {
    console.warn('Combined Overpass query failed:', err);
    enrichedGreenSpaceCache.set(greenKey, []);
    highwayCache.set(hwKey, []);
    return { greenSpaces: [], highwayPoints: [] };
  }
}
