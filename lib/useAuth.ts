import { useState, useEffect, useCallback } from 'react';
import {
  onAuthStateChanged,
  signInWithCredential,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  deleteUser,
  OAuthProvider,
  type User,
} from 'firebase/auth';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import { auth } from './firebase';

// Required for web redirect to close the popup
WebBrowser.maybeCompleteAuthSession();

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

  const deleteAccount = useCallback(async () => {
    if (auth.currentUser) {
      await deleteUser(auth.currentUser);
    }
  }, []);

  return {
    user,
    loading,
    isAuthenticated: !!user,
    signInWithApple,
    signInWithEmail,
    signOut,
    deleteAccount,
  };
}
