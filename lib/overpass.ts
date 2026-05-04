import type { RoutePoint } from './route-generator';

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
// Bumped 8000 → 12000 to give the combined Overpass query (greens +
// highways at 10km radius around dense areas like Manhattan) enough wall-
// clock to finish. Server-side timeout is 10s (see the queries below);
// client should outlast that with a small margin so we get a real error
// or response instead of an AbortError that races the server's own.
const TIMEOUT_MS = 12000;
const BBOX_BUFFER_DEG = 0.002; // ~200m buffer in degrees

/**
 * Default max radius used by the prefetch path — covers all "normal" route
 * distances (≤ ~12mi loops, where calculateSearchRadius lands ≤ 10km).
 * Long-distance requests bump beyond this via `getMaxOverpassRadius` and
 * cache under a separate bucket.
 */
const DEFAULT_OVERPASS_RADIUS_KM = 10;

/**
 * Pick an Overpass query radius that's large enough for the requested route
 * distance. A 30mi loop needs green-space anchors 15-20km from start so the
 * loop can wrap around water; capping at the prefetch's 10km starves the
 * waypoint selector and forces the geometric fallback into a 9km-radius
 * triangle that lands in the Hudson/East River for most NYC starts.
 *
 * Buckets at {10, 15, 20, 25} so a center accumulates at most a handful of
 * cache entries even when the user toggles between distances. Each bucket
 * covers ~5km of distance request range — a 5mi user and a 12mi user both
 * land in bucket 10; a 25mi user and a 30mi user both land in bucket 25.
 */
export function getMaxOverpassRadius(distanceKm: number): number {
  // distanceKm * 0.6 chosen to comfortably exceed `selectGreenSpaceWaypoints`'s
  // maxRadius (loopRadius * 3.0 ≈ distanceKm * 0.36) so we never run out of
  // waypoint candidates. Capped at 25km (NYC fits inside that from any start).
  const desired = Math.min(25, Math.max(DEFAULT_OVERPASS_RADIUS_KM, distanceKm * 0.6));
  if (desired <= 10) return 10;
  if (desired <= 15) return 15;
  if (desired <= 20) return 20;
  return 25;
}

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
// In-flight coalescing for combined green/highway fetches. Keyed by the
// same exactKey the caches use. Lets a prefetch and an immediate Generate
// share a single Overpass round trip instead of firing two parallel
// queries that compete with each other and (under load) get throttled.
// Cleared on completion regardless of success/failure.
const inflightCombinedFetches = new Map<string, Promise<{ greenSpaces: GreenSpace[]; highwayPoints: RoutePoint[] }>>();

/**
 * Snapshot the green-space and highway caches for record-and-replay testing.
 * Used by the quality harness to avoid burning Overpass's per-IP quota on
 * every run — record once when the cache is fresh, replay forever.
 */
export interface OverpassSnapshot {
  enriched: Array<[string, GreenSpace[]]>;
  highway: Array<[string, RoutePoint[]]>;
}

export function dumpOverpassCaches(): OverpassSnapshot {
  return {
    enriched: Array.from(enrichedGreenSpaceCache.entries()),
    highway: Array.from(highwayCache.entries()),
  };
}

export function loadOverpassCaches(snapshot: Partial<OverpassSnapshot>): void {
  // Skip persisted entries with empty arrays. A previous Overpass call that
  // failed (network blip, mirror down, etc.) caches an empty result so the
  // user wasn't blocked at the moment, but persisting that empty entry to
  // AsyncStorage poisons the cache forever — every app launch reloads the
  // empty result, every subsequent generation hits the empty cache, the
  // green-space-first algorithm has nothing to work with. User reported
  // p2p NoHo→Central Park refreshing to "Peaceful Path" with g=0 across
  // many attempts — exactly this pattern. Skipping empty entries on load
  // forces a re-fetch the next time that center is queried, which is the
  // recovery path.
  if (snapshot.enriched) {
    for (const [k, v] of snapshot.enriched) {
      if (v.length > 0) enrichedGreenSpaceCache.set(k, v);
    }
  }
  if (snapshot.highway) {
    for (const [k, v] of snapshot.highway) {
      if (v.length > 0) highwayCache.set(k, v);
    }
  }
}

/**
 * Seed the caches for a (center, radiusKm) under the correct internal key.
 * Used by the test harness to inject synthetic green-space fixtures so the
 * green-space-first algorithm can be exercised when Overpass is unavailable.
 *
 * IMPORTANT: must match the key the production code reads from. The combined
 * `fetchGreenSpacesAndHighways` queries at the bucketed radius
 * (`getMaxOverpassRadius`) and filters in-memory, so we cache under that same
 * key — otherwise the prefill silently misses and the algorithm runs against
 * an empty cache (geometric fallback), which is NOT the path production users
 * hit. Pre-fills under DEFAULT_OVERPASS_RADIUS_KM since synthetic fixtures
 * are sized for sub-12mi tests; long-distance fixtures should pass radiusKm
 * explicitly.
 */
export function prefillOverpassCaches(
  center: RoutePoint,
  radiusKm: number,
  greenSpaces: GreenSpace[],
  highwayPoints: RoutePoint[],
): void {
  // If caller didn't specify, use the default prefetch radius. Bucketing here
  // matches the production fetch path so the key alignment holds.
  const bucketed = radiusKm > DEFAULT_OVERPASS_RADIUS_KM
    ? getMaxOverpassRadius(radiusKm / 0.6) // invert the * 0.6 to back into a request distance
    : DEFAULT_OVERPASS_RADIUS_KM;
  enrichedGreenSpaceCache.set(locationKey('enriched', center, bucketed), greenSpaces);
  highwayCache.set(locationKey('highway', center, bucketed), highwayPoints);
}

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

  // Track per-mirror outcomes so failure logs show which URL failed and how
  // (rather than the generic "All promises were rejected").
  const attempts: { url: string; status: string }[] = OVERPASS_URLS.map((u) => ({ url: u, status: 'pending' }));

  try {
    const response = await Promise.any(
      OVERPASS_URLS.map((url, i) =>
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            // Identifying ourselves to Overpass earns gentler rate limiting
            // — anonymous clients get throttled aggressively.
            'User-Agent': 'RunRoutes/1.0 (irachelma@gmail.com)',
          },
          body,
          signal: controller.signal,
        }).then(
          (res) => {
            attempts[i].status = res.ok ? `ok (${res.status})` : `http ${res.status}`;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res;
          },
          (err) => {
            attempts[i].status = `err ${err?.name ?? ''} ${err?.message ?? err}`.trim();
            throw err;
          }
        )
      )
    );
    return response;
  } catch (err) {
    // Only logged when *every* mirror failed (Promise.any rejected).
    const summary = attempts.map((a) => `  ${a.url}: ${a.status}`).join('\n');
    console.warn(`Overpass mirrors all failed:\n${summary}`);
    throw err;
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
 *
 * Queries at the bucketed radius from `getMaxOverpassRadius(radiusKm/0.6)`
 * — typically the same 10km as the prefetch for normal-distance requests,
 * but bumps to 15/20/25km for long requests so a 30mi loop can find
 * Brooklyn parks 18km from a Manhattan start. Cache lookup checks the
 * exact bucket first, then any LARGER cached bucket (filter down) so a
 * 30mi user fetching at 25km also serves a subsequent 5mi request at the
 * same start without a second network round trip.
 */
export async function fetchGreenSpacesAndHighways(
  center: RoutePoint,
  radiusKm: number
): Promise<{ greenSpaces: GreenSpace[]; highwayPoints: RoutePoint[] }> {
  // Convert the requested in-memory radius back into a bucket. radiusKm
  // here is what calculateSearchRadius returned — usually radius * 1.0 for
  // loops or * 0.8 for OAB, so dividing by 0.6 gives a generous distance
  // estimate that maps to the right bucket.
  const fetchRadiusKm = getMaxOverpassRadius(radiusKm / 0.6);

  // Cache lookup: prefer exact bucket; otherwise scan for any cached entry
  // at >= fetchRadiusKm and filter down. Avoids re-fetching when a larger
  // request previously warmed the cache for the same center.
  const exactKey = locationKey('enriched', center, fetchRadiusKm);
  const cachedAtBucket = enrichedGreenSpaceCache.get(exactKey);
  if (cachedAtBucket !== undefined) {
    const hwBucket = highwayCache.get(locationKey('highway', center, fetchRadiusKm));
    if (hwBucket !== undefined) {
      return filterByRadius(cachedAtBucket, hwBucket, center, radiusKm);
    }
  }
  const covering = findCoveringCachedRadius(center, fetchRadiusKm);
  if (covering !== null) {
    const cachedGreen = enrichedGreenSpaceCache.get(locationKey('enriched', center, covering))!;
    const cachedHw = highwayCache.get(locationKey('highway', center, covering))!;
    return filterByRadius(cachedGreen, cachedHw, center, radiusKm);
  }

  // In-flight coalescing: if another caller is already fetching this exact
  // bucket, await their promise instead of firing a duplicate request. The
  // production race we're closing: useEffect kicks off prefetch when GPS
  // locks; user taps Generate ~2s later before prefetch completes; without
  // this guard, both calls hit Overpass in parallel, compete with each
  // other under any kind of mirror load, and the slow one sometimes blows
  // the resolution budget — surfacing as the "first Generate fails,
  // subsequent succeed" pattern.
  const inflight = inflightCombinedFetches.get(exactKey);
  if (inflight !== undefined) {
    const result = await inflight;
    return filterByRadius(result.greenSpaces, result.highwayPoints, center, radiusKm);
  }

  const radiusMeters = Math.round(fetchRadiusKm * 1000);
  const a = `around:${radiusMeters},${center.lat},${center.lng}`;
  // Combined union — `out center bb tags;` works for both halves; highway
  // parsing only needs `center`, but the extra `bb tags` payload is small.
  // Server timeout bumped 5 → 10 because the combined query was hitting
  // the 5s server-side limit for 10km radius queries over dense areas
  // (Manhattan). When that happens Overpass returns HTTP 200 with an
  // empty elements array AND a `remark: "Query timed out..."` field —
  // which our code was silently treating as "no greens here." Detected
  // explicitly below.
  const query = `[out:json][timeout:10];(${greenSpaceSubQuery(a)}${highwaySubQuery(a)});out center bb tags;`;

  // Wrap the actual fetch in a promise we can register before awaiting.
  // The .finally below removes the entry whether the fetch succeeded or
  // threw — leaving a stale in-flight entry would deadlock all subsequent
  // callers waiting on a settled promise that nobody is going to resolve.
  const fetchPromise = (async (): Promise<{ greenSpaces: GreenSpace[]; highwayPoints: RoutePoint[] }> => {
    try {
      const res = await fetchOverpassRace(query);
      const data = await res.json();
      // Detect server-side timeout disguised as a 200. Overpass returns
      // {elements: [], remark: "runtime error: Query timed out..."} when
      // the query exceeds the [out:json][timeout:N] limit. Without this
      // check we'd treat the timeout as a successful "no greens here"
      // result, cache it (in old code), and serve empty forever. Now we
      // throw and let the catch return empty WITHOUT caching — next call
      // retries.
      if (typeof data.remark === 'string' && /timed out|runtime error/i.test(data.remark)) {
        throw new Error(`Overpass server-side timeout: ${data.remark}`);
      }
      const elements = data.elements || [];

      const greenElements: any[] = [];
      const highwayElements: any[] = [];
      for (const el of elements) {
        if (MAJOR_HIGHWAY_TYPES.has(el.tags?.highway)) highwayElements.push(el);
        else greenElements.push(el);
      }

      const greenSpaces = parseGreenSpaceElements(greenElements);
      const highwayPoints = parseHighwayElements(highwayElements);

      enrichedGreenSpaceCache.set(exactKey, greenSpaces);
      highwayCache.set(locationKey('highway', center, fetchRadiusKm), highwayPoints);
      return { greenSpaces, highwayPoints };
    } catch (err: any) {
      // Keep the message short — full AggregateError stacks flood test output.
      const msg = err?.message ?? String(err);
      console.warn(`Combined Overpass query failed: ${msg.split('\n')[0]}`);
      // Don't cache the empty failure result. Caching empties on error means
      // a single transient failure poisons the cache for the rest of the
      // session AND across launches (via overpass-persist) until the user
      // moves locations enough to query a different bucket. Returning empty
      // without caching means the next lookup retries — slower if Overpass
      // stays down, but the only path back to working state when it
      // recovers. Successful empty results (rare in NYC, common in remote
      // areas) DO get cached above, since those are legitimate.
      return { greenSpaces: [], highwayPoints: [] };
    }
  })();
  inflightCombinedFetches.set(exactKey, fetchPromise);
  try {
    const result = await fetchPromise;
    return filterByRadius(result.greenSpaces, result.highwayPoints, center, radiusKm);
  } finally {
    inflightCombinedFetches.delete(exactKey);
  }
}

/** Scan cache for entries at this center with radius >= `requiredRadiusKm`,
 *  return the smallest such radius (or null). Lets a 30mi user's 25km cache
 *  serve a subsequent 5mi request without a second fetch. */
function findCoveringCachedRadius(center: RoutePoint, requiredRadiusKm: number): number | null {
  const centerPrefix = `enriched:${center.lat.toFixed(3)},${center.lng.toFixed(3)},`;
  let best: number | null = null;
  for (const key of enrichedGreenSpaceCache.keys()) {
    if (!key.startsWith(centerPrefix)) continue;
    const radius = parseFloat(key.slice(centerPrefix.length));
    if (radius >= requiredRadiusKm && (best === null || radius < best)) {
      // Verify the highway cache also has this bucket — otherwise we'd hit
      // an undefined .get() below. They're written together, so this is
      // belt-and-suspenders, but cheap.
      if (highwayCache.has(locationKey('highway', center, radius))) {
        best = radius;
      }
    }
  }
  return best;
}

function filterByRadius(
  green: GreenSpace[],
  highway: RoutePoint[],
  center: RoutePoint,
  radiusKm: number,
): { greenSpaces: GreenSpace[]; highwayPoints: RoutePoint[] } {
  // No-op when the cached data was fetched at exactly the requested radius
  // (or smaller — but findCoveringCachedRadius guarantees we only reach this
  // with cached >= requested). Cheap haversine pass keeps things correct.
  const greenSpaces = green.filter((g) => haversineDistance(center, g.point) <= radiusKm);
  const highwayPoints = highway.filter((p) => haversineDistance(center, p) <= radiusKm);
  return { greenSpaces, highwayPoints };
}

/**
 * Kick off a default-radius Overpass fetch in the background and discard the
 * result — the cache write is the side effect we care about. Use from the
 * UI as soon as the user's location is known so by the time they tap
 * "generate" the Overpass round trip is already complete. Long-distance
 * requests (>12mi) will trigger a second on-demand fetch at the larger
 * bucket; we don't pre-warm those because the typical user requests <10mi.
 */
export function prefetchGreenSpacesAndHighways(center: RoutePoint): void {
  fetchGreenSpacesAndHighways(center, DEFAULT_OVERPASS_RADIUS_KM).catch(() => {
    // Swallow — the real call will report any failure to the user.
  });
}
