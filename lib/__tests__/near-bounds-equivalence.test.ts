import { overlapSegmentRatio, countPendantLoops, trimPendantLoops, haversineDistance, bearingFrom } from '../osrm';
import type { RoutePoint } from '../route-generator';

// CLAUDE.md #58: overlapSegmentRatio / countPendantLoops / trimPendantLoops
// skip the haversine for point pairs that a cheap degree-space bound proves
// are out of tolerance. That is only safe if every decision is unchanged, so
// these tests pin the optimized functions to naive reference copies of the
// original O(n²) scans on randomized polylines with planted pendant loops
// and near-duplicate (retraced) segments.

const TOL_KM = 0.020;
const MAX_BODY_FRAC = 0.30;
const MAX_BODY_KM = 0.300;
const MIN_BODY_SEGS = 2;

function pathKm(points: RoutePoint[], from = 0, to = points.length - 1): number {
  let km = 0;
  for (let k = from; k < to; k++) km += haversineDistance(points[k], points[k + 1]);
  return km;
}

function refOverlap(points: RoutePoint[], proximityKm = 0.012, bearingTolDeg = 20): number {
  if (points.length < 2) return 0;
  const n = points.length - 1;
  const mid: RoutePoint[] = [];
  const brg: number[] = [];
  const len: number[] = [];
  let totalLen = 0;
  for (let i = 0; i < n; i++) {
    mid.push({ lat: (points[i].lat + points[i + 1].lat) / 2, lng: (points[i].lng + points[i + 1].lng) / 2 });
    brg.push(bearingFrom(points[i], points[i + 1]));
    len.push(haversineDistance(points[i], points[i + 1]));
    totalLen += len[i];
  }
  if (totalLen === 0) return 0;
  let overlapLen = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 5; j < n; j++) {
      if (haversineDistance(mid[i], mid[j]) > proximityKm) continue;
      const raw = Math.abs(brg[i] - brg[j]) % 360;
      const ang = Math.min(raw, 360 - raw);
      if (ang < bearingTolDeg || (180 - ang) < bearingTolDeg) { overlapLen += len[i]; break; }
    }
  }
  return overlapLen / totalLen;
}

function refMatch(points: RoutePoint[], i: number, j: number, totalKm: number): boolean {
  if (!(haversineDistance(points[i], points[j + 1]) < TOL_KM && haversineDistance(points[i + 1], points[j]) < TOL_KM)) return false;
  if (haversineDistance(points[i], points[i + 1]) < TOL_KM) return false;
  const bodyKm = pathKm(points, i + 1, j);
  if (bodyKm > MAX_BODY_KM) return false;
  return !(totalKm > 0 && bodyKm / totalKm > MAX_BODY_FRAC);
}

function refCountPendants(points: RoutePoint[]): number {
  if (points.length < 5) return 0;
  const consumed = new Array<boolean>(points.length).fill(false);
  const totalKm = pathKm(points);
  let count = 0;
  for (let i = 0; i < points.length - 1; i++) {
    if (consumed[i]) continue;
    for (let j = i + 1 + MIN_BODY_SEGS; j < points.length - 1; j++) {
      if (consumed[j]) continue;
      if (refMatch(points, i, j, totalKm)) {
        count++;
        for (let k = i; k <= j; k++) consumed[k] = true;
        break;
      }
    }
  }
  return count;
}

function refTrimOne(points: RoutePoint[]): RoutePoint[] {
  const totalKm = pathKm(points);
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = i + 1 + MIN_BODY_SEGS; j < points.length - 1; j++) {
      if (refMatch(points, i, j, totalKm)) return [...points.slice(0, i + 1), ...points.slice(j + 2)];
    }
  }
  return points;
}

function refTrim(points: RoutePoint[]): RoutePoint[] {
  if (points.length < 5) return points;
  let current = points;
  for (let pass = 0; pass < 2; pass++) {
    const next = refTrimOne(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

// Deterministic polylines: a grid-ish random walk (≈ city blocks) with
// planted square pendants (bridge out, loop, bridge back) and occasional
// back-tracking so retraced/antiparallel segments exist.
function makePolyline(seed: number, lat0: number): RoutePoint[] {
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pts: RoutePoint[] = [{ lat: lat0, lng: -73.98 }];
  const step = 0.0004; // ~45m
  let dir = 0;
  for (let k = 0; k < 220; k++) {
    const r = rand();
    if (r < 0.15) dir = (dir + 1) % 4;
    else if (r < 0.30) dir = (dir + 3) % 4;
    const last = pts[pts.length - 1];
    const jitter = (rand() - 0.5) * 0.00002;
    const next = {
      lat: last.lat + (dir === 0 ? step : dir === 2 ? -step : 0) + jitter,
      lng: last.lng + (dir === 1 ? step : dir === 3 ? -step : 0) + jitter,
    };
    pts.push(next);
    if (rand() < 0.04) {
      const a = pts[pts.length - 1];
      const d = 0.0005 + rand() * 0.0004;
      const b = { lat: a.lat + d, lng: a.lng };
      pts.push(b, { lat: b.lat, lng: b.lng + d }, { lat: b.lat + d, lng: b.lng + d }, { lat: b.lat + d, lng: b.lng }, { lat: b.lat + 0.00001, lng: b.lng }, { lat: a.lat + 0.00001, lng: a.lng });
    }
    if (rand() < 0.03) {
      const back = pts.slice(Math.max(0, pts.length - 4)).reverse();
      for (const p of back) pts.push({ lat: p.lat + 0.00003, lng: p.lng - 0.00003 });
    }
  }
  return pts;
}

describe('nearBounds pre-check keeps O(n²) scans exact (CLAUDE.md #58)', () => {
  const polylines = Array.from({ length: 40 }, (_, k) => makePolyline(1000 + k * 7919, k % 2 === 0 ? 40.72 : 59.9));

  test('overlapSegmentRatio matches the reference scan', () => {
    for (const p of polylines) expect(overlapSegmentRatio(p)).toBe(refOverlap(p));
  });

  test('countPendantLoops matches the reference scan', () => {
    let nonZero = 0;
    for (const p of polylines) {
      const ref = refCountPendants(p);
      if (ref > 0) nonZero++;
      expect(countPendantLoops(p)).toBe(ref);
    }
    expect(nonZero).toBeGreaterThan(5); // planted pendants actually exercised the match path
  });

  test('trimPendantLoops matches the reference trim', () => {
    let trimmed = 0;
    for (const p of polylines) {
      const ref = refTrim(p);
      if (ref !== p) trimmed++;
      expect(trimPendantLoops(p)).toEqual(ref);
    }
    expect(trimmed).toBeGreaterThan(5);
  });
});
