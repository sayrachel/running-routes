import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { GeneratedRoute, RoutePoint, RoutePreferences } from './route-generator';
import { useAuth } from './useAuth';
import {
  addFavoriteRoute,
  removeFavoriteRoute,
  onFavoritesSnapshot,
  updateUserProfile,
  getCachedFavorites,
  flushPendingRuns,
} from './firestore';
import type { FavoriteRouteRecord } from './types';

const DISTANCE_STORAGE_KEY = '@running_routes_last_distance_v3';

export type RouteStyle = 'loop' | 'point-to-point' | 'out-and-back';

export interface User {
  name: string;
  email: string;
  avatar: string;
}

export interface RunPreferences {
  lowTraffic: boolean;
}

export interface FavoriteRoute {
  id: string;
  routeName: string;
  distance: number;
  terrain: 'Loop' | 'Out & Back' | 'Point to Point';
  lat: number;
  lng: number;
}

interface AppState {
  isLoggedIn: boolean;
  setIsLoggedIn: (v: boolean) => void;
  user: User | null;
  setUser: (v: User | null) => void;
  firebaseUid: string | null;
  authLoading: boolean;
  signInWithGoogle: () => Promise<any>;
  signInWithApple: () => Promise<any>;
  signInWithEmail: (email: string, password: string) => Promise<any>;
  signOutUser: () => Promise<void>;
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
  endLocation: RoutePoint | null;
  setEndLocation: (v: RoutePoint | null) => void;
  favorites: FavoriteRoute[];
  addFavorite: (fav: FavoriteRoute) => void;
  removeFavorite: (id: string) => void;
}

const DEFAULT_CENTER: RoutePoint = { lat: 40.7128, lng: -74.006 };

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const { user: firebaseUser, loading: authLoading, isAuthenticated, signInWithGoogle, signInWithApple, signInWithEmail, signOut } = useAuth();

  const [isLoggedIn, setIsLoggedIn] = useState(true); // TODO: revert to false when done testing
  const [user, setUser] = useState<User | null>({ name: 'Test User', email: 'test@example.com', avatar: '' }); // TODO: revert to null
  const [center, setCenter] = useState<RoutePoint>(DEFAULT_CENTER);
  const [hasLocation, setHasLocation] = useState(false);
  const [gpsStrength, setGpsStrength] = useState<0 | 1 | 2 | 3>(0);
  const [distance, setDistanceRaw] = useState(3);
  const [routeStyle, setRouteStyle] = useState<RouteStyle>('loop');

  // Persist distance and load last used distance on mount
  const setDistance = useCallback((v: number) => {
    setDistanceRaw(v);
    AsyncStorage.setItem(DISTANCE_STORAGE_KEY, String(v)).catch(() => {});
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(DISTANCE_STORAGE_KEY).then((val) => {
      if (val !== null) {
        const parsed = parseFloat(val);
        if (!isNaN(parsed) && parsed > 0) setDistanceRaw(parsed);
      }
    }).catch(() => {});
  }, []);
  const [prefs, setPrefs] = useState<RunPreferences>({
    lowTraffic: false,
  });
  const [routes, setRoutes] = useState<GeneratedRoute[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<GeneratedRoute | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
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
  // TODO: remove bypass when done testing
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
    }
    // Bypass: don't reset to logged-out when no Firebase user
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
        }))
      );
    });

    return unsubscribe;
  }, [firebaseUser]);

  const addFavorite = useCallback(
    (fav: FavoriteRoute) => {
      // Optimistic update
      setFavorites((prev) => {
        if (prev.some((f) => f.id === fav.id)) return prev;
        return [...prev, fav];
      });

      // Persist to Firestore
      if (firebaseUser) {
        addFavoriteRoute(firebaseUser.uid, {
          routeName: fav.routeName,
          distance: fav.distance,
          terrain: fav.terrain,
          lat: fav.lat,
          lng: fav.lng,
          createdAt: Date.now(),
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

  return (
    <AppContext.Provider
      value={{
        isLoggedIn,
        setIsLoggedIn,
        user,
        setUser,
        firebaseUid: firebaseUser?.uid ?? null,
        authLoading,
        signInWithGoogle,
        signInWithApple,
        signInWithEmail,
        signOutUser,
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
