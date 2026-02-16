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
}

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
