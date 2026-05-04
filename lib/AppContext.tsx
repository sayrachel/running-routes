import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { GeneratedRoute, RoutePoint, RoutePreferences } from './route-generator';
import type { UnitSystem } from './units';
import { useAuth } from './useAuth';
import {
  addFavoriteRoute,
  removeFavoriteRoute,
  onFavoritesSnapshot,
  updateUserProfile,
  getCachedFavorites,
  flushPendingRuns,
  deleteUserData,
} from './firestore';
import type { FavoriteRouteRecord } from './types';

const DISTANCE_STORAGE_KEY = '@running_routes_last_distance_v3';
const UNITS_STORAGE_KEY = '@running_routes_units';

export type RouteStyle = 'loop' | 'point-to-point' | 'out-and-back';

export interface User {
  name: string;
  email: string;
  avatar: string;
}

export interface RunPreferences {
  lowTraffic: boolean;
  units: UnitSystem;
}

export interface FavoriteRoute {
  id: string;
  routeName: string;
  distance: number;
  terrain: 'Loop' | 'Out & Back' | 'Point to Point';
  lat: number;
  lng: number;
  points?: { lat: number; lng: number }[];
  createdAt?: number;
}

interface AppState {
  isLoggedIn: boolean;
  setIsLoggedIn: (v: boolean) => void;
  user: User | null;
  setUser: (v: User | null) => void;
  firebaseUid: string | null;
  authLoading: boolean;
  signInWithApple: () => Promise<any>;
  signInWithEmail: (email: string, password: string) => Promise<any>;
  signOutUser: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  center: RoutePoint;
  setCenter: (p: RoutePoint) => void;
  hasLocation: boolean;
  setHasLocation: (v: boolean) => void;
  gpsStrength: 0 | 1 | 2 | 3;
  setGpsStrength: (v: 0 | 1 | 2 | 3) => void;
  distance: number;
  setDistance: (v: number) => void;
  routeStyle: RouteStyle;
  setRouteStyle: (v: RouteStyle) => void;
  prefs: RunPreferences;
  setPrefs: (v: RunPreferences) => void;
  routes: GeneratedRoute[];
  setRoutes: (v: GeneratedRoute[]) => void;
  selectedRoute: GeneratedRoute | null;
  setSelectedRoute: (v: GeneratedRoute | null) => void;
  isGenerating: boolean;
  setIsGenerating: (v: boolean) => void;
  // Lifted from app/index.tsx local state because router.replace() unmounts
  // the plan screen during generation. Error setters captured in the original
  // mount's closure become no-ops by the time generation resolves; storing
  // the message in a context that survives the unmount lets the freshly
  // remounted plan screen display it.
  generateError: string | null;
  setGenerateError: (v: string | null) => void;
  endLocation: RoutePoint | null;
  setEndLocation: (v: RoutePoint | null) => void;
  favorites: FavoriteRoute[];
  addFavorite: (fav: FavoriteRoute) => void;
  removeFavorite: (id: string) => void;
}

const DEFAULT_CENTER: RoutePoint = { lat: 40.7128, lng: -74.006 };

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const { user: firebaseUser, loading: authLoading, isAuthenticated, signInWithApple, signInWithEmail, signOut, deleteAccount: deleteAuthAccount } = useAuth();

  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [center, setCenter] = useState<RoutePoint>(DEFAULT_CENTER);
  const [hasLocation, setHasLocation] = useState(false);
  const [gpsStrength, setGpsStrength] = useState<0 | 1 | 2 | 3>(0);
  const [distance, setDistanceRaw] = useState(3);
  const [routeStyle, setRouteStyle] = useState<RouteStyle>('loop');

  // Persist distance and load last used distance on mount
  const setDistance = useCallback((v: number) => {
    const clamped = Math.max(1, Math.min(50, v));
    setDistanceRaw(clamped);
    AsyncStorage.setItem(DISTANCE_STORAGE_KEY, String(clamped)).catch(() => {});
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(DISTANCE_STORAGE_KEY).then((val) => {
      if (val !== null) {
        const parsed = parseFloat(val);
        if (!isNaN(parsed) && parsed > 0) setDistanceRaw(parsed);
      }
    }).catch(() => {});
  }, []);
  const [prefs, setPrefsRaw] = useState<RunPreferences>({
    lowTraffic: true,
    units: 'imperial',
  });

  // Persist units preference
  const setPrefs = useCallback((v: RunPreferences) => {
    setPrefsRaw(v);
    AsyncStorage.setItem(UNITS_STORAGE_KEY, v.units).catch(() => {});
  }, []);

  // Load persisted units on mount
  useEffect(() => {
    AsyncStorage.getItem(UNITS_STORAGE_KEY).then((val) => {
      if (val === 'imperial' || val === 'metric') {
        setPrefsRaw((prev) => ({ ...prev, units: val }));
      }
    }).catch(() => {});
  }, []);
  const [routes, setRoutes] = useState<GeneratedRoute[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<GeneratedRoute | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [endLocation, setEndLocation] = useState<RoutePoint | null>(null);
  const [favorites, setFavorites] = useState<FavoriteRoute[]>([]);

  // Load cached favorites on mount for instant offline display
  useEffect(() => {
    getCachedFavorites().then((cached) => {
      if (cached.length > 0) {
        setFavorites(
          cached.map((f) => ({
            id: f.id!,
            routeName: f.routeName,
            distance: f.distance,
            terrain: f.terrain,
            lat: f.lat,
            lng: f.lng,
            points: f.points,
            createdAt: f.createdAt,
          }))
        );
      }
    }).catch(() => {});
  }, []);

  // Flush any pending runs on mount
  useEffect(() => {
    flushPendingRuns().catch(() => {});
  }, []);

  // Sync Firebase Auth user → app user state
  useEffect(() => {
    if (firebaseUser) {
      setUser({
        name: firebaseUser.displayName || 'Runner',
        email: firebaseUser.email || '',
        avatar: firebaseUser.photoURL || '',
      });
      setIsLoggedIn(true);

      // Ensure Firestore profile exists
      updateUserProfile(firebaseUser.uid, {
        displayName: firebaseUser.displayName || 'Runner',
        email: firebaseUser.email || '',
        photoURL: firebaseUser.photoURL || null,
        createdAt: Date.now(),
      }).catch(() => {});
    } else if (!authLoading) {
      setIsLoggedIn(false);
      setUser(null);
    }
  }, [firebaseUser, authLoading]);

  // Real-time Firestore favorites listener
  useEffect(() => {
    if (!firebaseUser) return;

    const unsubscribe = onFavoritesSnapshot(firebaseUser.uid, (favRecords) => {
      setFavorites(
        favRecords.map((f) => ({
          id: f.id!,
          routeName: f.routeName,
          distance: f.distance,
          terrain: f.terrain,
          lat: f.lat,
          lng: f.lng,
          points: f.points,
          createdAt: f.createdAt,
        }))
      );
    });

    return unsubscribe;
  }, [firebaseUser]);

  const addFavorite = useCallback(
    (fav: FavoriteRoute) => {
      const now = Date.now();
      const favWithDate = { ...fav, createdAt: fav.createdAt ?? now };
      // Optimistic update
      setFavorites((prev) => {
        if (prev.some((f) => f.id === favWithDate.id)) return prev;
        return [favWithDate, ...prev];
      });

      // Persist to Firestore
      if (firebaseUser) {
        addFavoriteRoute(firebaseUser.uid, {
          routeName: favWithDate.routeName,
          distance: favWithDate.distance,
          terrain: favWithDate.terrain,
          lat: favWithDate.lat,
          lng: favWithDate.lng,
          points: favWithDate.points,
          createdAt: now,
        }).catch(console.warn);
      }
    },
    [firebaseUser]
  );

  const removeFavoriteHandler = useCallback(
    (id: string) => {
      // Optimistic update
      setFavorites((prev) => prev.filter((f) => f.id !== id));

      // Remove from Firestore
      if (firebaseUser) {
        removeFavoriteRoute(firebaseUser.uid, id).catch(console.warn);
      }
    },
    [firebaseUser]
  );

  const signOutUser = useCallback(async () => {
    await signOut();
    setIsLoggedIn(false);
    setUser(null);
    setFavorites([]);
  }, [signOut]);

  const deleteAccountHandler = useCallback(async () => {
    const uid = firebaseUser?.uid;
    if (uid) {
      await deleteUserData(uid);
    }
    await deleteAuthAccount();
    setIsLoggedIn(false);
    setUser(null);
    setFavorites([]);
  }, [firebaseUser, deleteAuthAccount]);

  return (
    <AppContext.Provider
      value={{
        isLoggedIn,
        setIsLoggedIn,
        user,
        setUser,
        firebaseUid: firebaseUser?.uid ?? null,
        authLoading,
        signInWithApple,
        signInWithEmail,
        signOutUser,
        deleteAccount: deleteAccountHandler,
        center,
        setCenter,
        hasLocation,
        setHasLocation,
        gpsStrength,
        setGpsStrength,
        distance,
        setDistance,
        routeStyle,
        setRouteStyle,
        prefs,
        setPrefs,
        routes,
        setRoutes,
        selectedRoute,
        setSelectedRoute,
        isGenerating,
        setIsGenerating,
        generateError,
        setGenerateError,
        endLocation,
        setEndLocation,
        favorites,
        addFavorite,
        removeFavorite: removeFavoriteHandler,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppProvider');
  return ctx;
}
