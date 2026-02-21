import { useState, useEffect, useCallback } from 'react';
import {
  onAuthStateChanged,
  signInWithCredential,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  GoogleAuthProvider,
  OAuthProvider,
  type User,
} from 'firebase/auth';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import { auth } from './firebase';
import { Platform } from 'react-native';

// Required for web redirect to close the popup
WebBrowser.maybeCompleteAuthSession();

/**
 * Google OAuth client IDs — replace with your own from Google Cloud Console.
 *
 * To set up:
 * 1. Go to https://console.cloud.google.com/apis/credentials
 * 2. Create OAuth 2.0 client IDs for:
 *    - Web application (for Expo web + auth proxy)
 *    - iOS (with your bundle ID: com.runroutes.app)
 *    - Android (with your SHA-1 fingerprint)
 * 3. Set the web client's redirect URI to: https://auth.expo.io/@sayrachel/run-routes
 */
const GOOGLE_WEB_CLIENT_ID = '390142091620-jip3n20e8d4657r4doa667jq2h4v59m5.apps.googleusercontent.com';
const GOOGLE_IOS_CLIENT_ID = 'YOUR_IOS_CLIENT_ID.apps.googleusercontent.com';
const GOOGLE_ANDROID_CLIENT_ID = 'YOUR_ANDROID_CLIENT_ID.apps.googleusercontent.com';

// Static Google OpenID Connect discovery document
const GOOGLE_DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Listen for Firebase auth state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signInWithGoogle = useCallback(async () => {
    try {
      const nonce = Math.random().toString(36).substring(2, 15);
      const hashedNonce = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        nonce
      );

      const clientId =
        Platform.OS === 'ios'
          ? GOOGLE_IOS_CLIENT_ID
          : Platform.OS === 'android'
            ? GOOGLE_ANDROID_CLIENT_ID
            : GOOGLE_WEB_CLIENT_ID;

      const redirectUri = AuthSession.makeRedirectUri({
        scheme: 'runroutes',
        path: 'auth',
      });

      const request = new AuthSession.AuthRequest({
        clientId,
        scopes: ['openid', 'profile', 'email'],
        redirectUri,
        responseType: AuthSession.ResponseType.IdToken,
        extraParams: {
          nonce: hashedNonce,
        },
      });

      const result = await request.promptAsync(GOOGLE_DISCOVERY);

      if (result.type === 'success' && result.params.id_token) {
        const credential = GoogleAuthProvider.credential(result.params.id_token, null);
        const userCredential = await signInWithCredential(auth, credential);
        return userCredential.user;
      }

      return null;
    } catch (error) {
      console.error('Google Sign-In error:', error);
      return null;
    }
  }, []);

  const signInWithApple = useCallback(async () => {
    try {
      const nonce = Math.random().toString(36).substring(2, 15);
      const hashedNonce = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        nonce
      );

      const redirectUri = AuthSession.makeRedirectUri({
        scheme: 'runroutes',
        path: 'auth',
      });

      const request = new AuthSession.AuthRequest({
        clientId: 'com.runroutes.app',
        scopes: ['name', 'email'],
        redirectUri,
        responseType: AuthSession.ResponseType.IdToken,
        extraParams: {
          nonce: hashedNonce,
          response_mode: 'form_post',
        },
      });

      const appleDiscovery: AuthSession.DiscoveryDocument = {
        authorizationEndpoint: 'https://appleid.apple.com/auth/authorize',
        tokenEndpoint: 'https://appleid.apple.com/auth/token',
      };

      const result = await request.promptAsync(appleDiscovery);

      if (result.type === 'success' && result.params.id_token) {
        const provider = new OAuthProvider('apple.com');
        const credential = provider.credential({
          idToken: result.params.id_token,
          rawNonce: nonce,
        });
        const userCredential = await signInWithCredential(auth, credential);
        return userCredential.user;
      }

      return null;
    } catch (error) {
      console.error('Apple Sign-In error:', error);
      return null;
    }
  }, []);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      return userCredential.user;
    } catch (error: any) {
      // If user doesn't exist, create a new account
      if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential') {
        try {
          const userCredential = await createUserWithEmailAndPassword(auth, email, password);
          return userCredential.user;
        } catch (createError) {
          console.error('Email sign-up error:', createError);
          throw createError;
        }
      }
      console.error('Email sign-in error:', error);
      throw error;
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await firebaseSignOut(auth);
    } catch (error) {
      console.error('Sign-out error:', error);
    }
  }, []);

  return {
    user,
    loading,
    isAuthenticated: !!user,
    signInWithGoogle,
    signInWithApple,
    signInWithEmail,
    signOut,
  };
}
