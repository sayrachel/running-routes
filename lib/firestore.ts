import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { db } from './firebase';
import type { RunRecord, FavoriteRouteRecord, UserProfile } from './types';

// ─── Cache Keys ──────────────────────────────────────────────

const CACHE_KEY_RUN_HISTORY = '@running_routes_run_history';
const CACHE_KEY_FAVORITES = '@running_routes_favorites';
const CACHE_KEY_PENDING_RUNS = '@running_routes_pending_runs';

// ─── User Profile ───────────────────────────────────────────

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, 'users', userId, 'profile', 'data'));
  return snap.exists() ? (snap.data() as UserProfile) : null;
}

export async function updateUserProfile(
  userId: string,
  data: Partial<UserProfile>
): Promise<void> {
  await setDoc(doc(db, 'users', userId, 'profile', 'data'), data, { merge: true });
}

// ─── Run Records ────────────────────────────────────────────

export async function saveRunRecord(
  userId: string,
  run: Omit<RunRecord, 'id'>
): Promise<string> {
  const colRef = collection(db, 'users', userId, 'runs');
  const docRef = doc(colRef);
  await setDoc(docRef, {
    ...run,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function getRunHistory(userId: string): Promise<RunRecord[]> {
  const q = query(
    collection(db, 'users', userId, 'runs'),
    orderBy('date', 'desc')
  );
  const snap = await getDocs(q);
  const runs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as RunRecord));

  // Cache for offline use
  AsyncStorage.setItem(CACHE_KEY_RUN_HISTORY, JSON.stringify(runs)).catch(() => {});

  return runs;
}

export async function getCachedRunHistory(): Promise<RunRecord[]> {
  try {
    const json = await AsyncStorage.getItem(CACHE_KEY_RUN_HISTORY);
    return json ? JSON.parse(json) : [];
  } catch {
    return [];
  }
}

export function onRunHistorySnapshot(
  userId: string,
  callback: (runs: RunRecord[]) => void
): Unsubscribe {
  const q = query(
    collection(db, 'users', userId, 'runs'),
    orderBy('date', 'desc')
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() } as RunRecord)));
  });
}

// ─── Favorites ──────────────────────────────────────────────

export async function addFavoriteRoute(
  userId: string,
  fav: Omit<FavoriteRouteRecord, 'id'>
): Promise<string> {
  const colRef = collection(db, 'users', userId, 'favorites');
  const docRef = doc(colRef);
  await setDoc(docRef, fav);
  return docRef.id;
}

export async function removeFavoriteRoute(
  userId: string,
  favoriteId: string
): Promise<void> {
  await deleteDoc(doc(db, 'users', userId, 'favorites', favoriteId));
}

export async function getFavorites(userId: string): Promise<FavoriteRouteRecord[]> {
  const q = query(
    collection(db, 'users', userId, 'favorites'),
    orderBy('createdAt', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as FavoriteRouteRecord));
}

export async function getCachedFavorites(): Promise<FavoriteRouteRecord[]> {
  try {
    const json = await AsyncStorage.getItem(CACHE_KEY_FAVORITES);
    return json ? JSON.parse(json) : [];
  } catch {
    return [];
  }
}

export function onFavoritesSnapshot(
  userId: string,
  callback: (favs: FavoriteRouteRecord[]) => void
): Unsubscribe {
  const q = query(
    collection(db, 'users', userId, 'favorites'),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(q, (snap) => {
    const favs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as FavoriteRouteRecord));

    // Cache for offline use
    AsyncStorage.setItem(CACHE_KEY_FAVORITES, JSON.stringify(favs)).catch(() => {});

    callback(favs);
  });
}

// ─── Pending Run Queue (offline) ─────────────────────────────

export async function addPendingRun(
  userId: string,
  run: Omit<RunRecord, 'id'>
): Promise<void> {
  try {
    const json = await AsyncStorage.getItem(CACHE_KEY_PENDING_RUNS);
    const pending: { userId: string; run: Omit<RunRecord, 'id'> }[] = json ? JSON.parse(json) : [];
    pending.push({ userId, run });
    await AsyncStorage.setItem(CACHE_KEY_PENDING_RUNS, JSON.stringify(pending));
  } catch {}
}

export async function flushPendingRuns(): Promise<void> {
  try {
    const json = await AsyncStorage.getItem(CACHE_KEY_PENDING_RUNS);
    if (!json) return;

    const pending: { userId: string; run: Omit<RunRecord, 'id'> }[] = JSON.parse(json);
    if (pending.length === 0) return;

    const remaining: typeof pending = [];
    for (const entry of pending) {
      try {
        await saveRunRecord(entry.userId, entry.run);
      } catch {
        remaining.push(entry);
      }
    }

    if (remaining.length === 0) {
      await AsyncStorage.removeItem(CACHE_KEY_PENDING_RUNS);
    } else {
      await AsyncStorage.setItem(CACHE_KEY_PENDING_RUNS, JSON.stringify(remaining));
    }
  } catch {}
}
