import type { RoutePreferences } from './route-generator';

interface ScoringCandidate {
  distanceKm: number;
  targetDistanceKm: number;
}

/**
 * Score a route candidate (0–1) based on user preferences and real API data.
 *
 * Scoring weights:
 * - lowTraffic: true → quietScore weight = 0.4
 * - Remaining weight goes to distance accuracy (how close to target distance)
 *
 * @returns score between 0 and 1 (higher is better)
 */
export function scoreRoute(
  candidate: ScoringCandidate,
  prefs: RoutePreferences,
  quietScore: number
): number {
  let totalWeight = 0;
  let weightedSum = 0;

  // Low traffic preference
  if (prefs.lowTraffic) {
    const weight = 0.4;
    totalWeight += weight;
    weightedSum += weight * quietScore;
  }

  // Distance accuracy gets remaining weight (minimum 0.2 to always matter)
  const distWeight = Math.max(1.0 - totalWeight, 0.2);
  totalWeight += distWeight;

  const distRatio = candidate.targetDistanceKm > 0
    ? candidate.distanceKm / candidate.targetDistanceKm
    : 1;
  // Perfect ratio = 1.0, penalize deviation in either direction
  const distScore = Math.max(1.0 - Math.abs(1.0 - distRatio) * 2, 0);
  weightedSum += distWeight * distScore;

  return totalWeight > 0 ? weightedSum / totalWeight : 0.5;
}
