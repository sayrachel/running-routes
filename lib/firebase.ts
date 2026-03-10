import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, initializeAuth, getReactNativePersistence } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

/**
 * Firebase configuration — replace these values with your own Firebase project config.
 *
 * To set up:
 * 1. Go to https://console.firebase.google.com
 * 2. Create a new project (or use existing)
 * 3. Add a Web app to get these config values
 * 4. Enable Google Sign-In in Authentication > Sign-in method
 * 5. Create a Firestore database (start in test mode)
 */
const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY || 'AIzaSyBHHMiYyb4m_RzALe0cY40C_b94QipV9Y4',
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN || 'running-routes-fea1d.firebaseapp.com',
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID || 'running-routes-fea1d',
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET || 'running-routes-fea1d.firebasestorage.app',
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '390142091620',
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID || '1:390142091620:web:262aa057291e4202305a71',
};

// Initialize Firebase app (avoid double-init)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Initialize Auth with AsyncStorage persistence for React Native
const auth =
  Platform.OS === 'web'
    ? getAuth(app)
    : initializeAuth(app, {
        persistence: getReactNativePersistence(AsyncStorage),
      });

const db = getFirestore(app);

export { app, auth, db };
