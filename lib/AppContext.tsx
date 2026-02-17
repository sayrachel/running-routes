import React, { createContext, useContext, useState } from 'react';
import type { GeneratedRoute, RoutePoint, RoutePreferences } from './route-generator';

export type RouteStyle = 'loop' | 'point-to-point' | 'out-and-back';

export interface User {
  name: string;
  email: string;
  avatar: string;
}

export interface RunPreferences {
  elevation: 'flat' | 'hilly';
  scenic: boolean;
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

const INITIAL_FAVORITES: FavoriteRoute[] = [
  { id: '1', routeName: 'Lakeside Loop', distance: 7.5, terrain: 'Loop', lat: 40.7580, lng: -73.9855 },
  { id: '2', routeName: 'Forest Path', distance: 5.0, terrain: 'Out & Back', lat: 40.7829, lng: -73.9654 },
  { id: '3', routeName: 'City Circuit', distance: 10.2, terrain: 'Loop', lat: 40.7484, lng: -73.9857 },
];

const DEFAULT_CENTER: RoutePoint = { lat: 40.7128, lng: -74.006 };

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [center, setCenter] = useState<RoutePoint>(DEFAULT_CENTER);
  const [hasLocation, setHasLocation] = useState(false);
  const [gpsStrength, setGpsStrength] = useState<0 | 1 | 2 | 3>(0);
  const [distance, setDistance] = useState(5);
  const [routeStyle, setRouteStyle] = useState<RouteStyle>('loop');
  const [prefs, setPrefs] = useState<RunPreferences>({
    elevation: 'flat',
    scenic: true,
    lowTraffic: true,
  });
  const [routes, setRoutes] = useState<GeneratedRoute[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<GeneratedRoute | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [endLocation, setEndLocation] = useState<RoutePoint | null>(null);
  const [favorites, setFavorites] = useState<FavoriteRoute[]>(INITIAL_FAVORITES);

  const addFavorite = (fav: FavoriteRoute) => {
    setFavorites((prev) => {
      if (prev.some((f) => f.id === fav.id)) return prev;
      return [...prev, fav];
    });
  };

  const removeFavorite = (id: string) => {
    setFavorites((prev) => prev.filter((f) => f.id !== id));
  };

  return (
    <AppContext.Provider
      value={{
        isLoggedIn,
        setIsLoggedIn,
        user,
        setUser,
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
        removeFavorite,
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
