/**
 * Persist the in-memory Overpass cache to AsyncStorage so cold app starts
 * for the same neighborhood reuse the prior session's network round trips.
 * Keeps the green-space + highway data per (lat, lng) cache key alongside a
 * timestamp; entries older than PERSIST_TTL_MS are ignored on load.
 *
 * Kept in its own file so the harness — which runs under Node and doesn't
 * have AsyncStorage — can keep importing lib/overpass without dragging in
 * the React Native dependency.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { dumpOverpassCaches, loadOverpassCaches, type OverpassSnapshot } from './overpass';

const PERSIST_KEY = '@running_routes_overpass_cache_v1';
const PERSIST_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface PersistedSnapshot extends OverpassSnapshot {
  ts: number;
}

export async function loadPersistedOverpassCache(now: number = Date.now()): Promise<void> {
  try {
    const json = await AsyncStorage.getItem(PERSIST_KEY);
    if (!json) return;
    const snapshot = JSON.parse(json) as PersistedSnapshot;
    if (!snapshot.ts || now - snapshot.ts > PERSIST_TTL_MS) return;
    loadOverpassCaches({ enriched: snapshot.enriched, highway: snapshot.highway });
  } catch {
    // Fall through silently — a corrupt cache shouldn't block the app.
  }
}

export async function persistOverpassCache(): Promise<void> {
  try {
    const snapshot = dumpOverpassCaches();
    if (snapshot.enriched.length === 0 && snapshot.highway.length === 0) return;
    const persisted: PersistedSnapshot = { ...snapshot, ts: Date.now() };
    await AsyncStorage.setItem(PERSIST_KEY, JSON.stringify(persisted));
  } catch {
    // Fail silently — losing the persistence write just means slightly
    // slower next cold start, not a user-visible failure.
  }
}
