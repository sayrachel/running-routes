import type { RoutePoint } from './route-generator';

/** Firebase user profile stored in Firestore */
export interface UserProfile {
  displayName: string;
  email: string;
  photoURL: string | null;
  createdAt: number; // timestamp ms
}

/** A completed run record stored in Firestore */
export interface RunRecord {
  id?: string;
  date: number; // timestamp ms
  routeName: string;
  distance: number; // km
  duration: number; // seconds
  pace: string; // mm:ss format
  avgPace: string;
  calories: number;
  elevation: number; // meters
  splits: { km: number; pace: string; time: string }[];
  gpsTrack: RoutePoint[];
  terrain: string;
}

/** A favorite route stored in Firestore */
export interface FavoriteRouteRecord {
  id?: string;
  routeName: string;
  distance: number;
  terrain: 'Loop' | 'Out & Back' | 'Point to Point';
  lat: number;
  lng: number;
  createdAt: number; // timestamp ms
}

/** Nominatim geocoding result for address autocomplete */
export interface GeocodeSuggestion {
  placeId: string;
  displayName: string;
  lat: number;
  lng: number;
}
