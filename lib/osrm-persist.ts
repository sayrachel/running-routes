/**
 * Persist the in-memory OSRM route cache to AsyncStorage so cold app
 * starts can reuse the prior session's routing work. Most useful when a
 * user re-generates from the same start (waypoints often repeat across
 * generations because green-space picks come from a finite catalog) or
 * when iterative distance refinement re-queries a near-duplicate URL.
 *
 * Mirrors lib/overpass-persist.ts so the algorithm QA harness — which
 * runs under Node and doesn't have AsyncStorage — can keep importing
 * lib/osrm without dragging in the React Native dependency.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { dumpOSRMCache, loadOSRMCache, type OSRMSnapshot } from './osrm';

const PERSIST_KEY = '@running_routes_osrm_cache_v1';
const PERSIST_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface PersistedSnapshot extends OSRMSnapshot {
  ts: number;
}

export async function loadPersistedOSRMCache(now: number = Date.now()): Promise<void> {
  try {
    const json = await AsyncStorage.getItem(PERSIST_KEY);
    if (!json) return;
    const snapshot = JSON.parse(json) as PersistedSnapshot;
    if (!snapshot.ts || now - snapshot.ts > PERSIST_TTL_MS) return;
    loadOSRMCache({ routes: snapshot.routes });
  } catch {
    // Fall through silently — a corrupt cache shouldn't block the app.
  }
}

export async function persistOSRMCache(): Promise<void> {
  try {
    const snapshot = dumpOSRMCache();
    if (snapshot.routes.length === 0) return;
    const persisted: PersistedSnapshot = { ...snapshot, ts: Date.now() };
    await AsyncStorage.setItem(PERSIST_KEY, JSON.stringify(persisted));
  } catch {
    // Fail silently — losing the persistence write just means slightly
    // slower next cold start, not a user-visible failure.
  }
}
