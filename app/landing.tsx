import React, { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAppContext } from '@/lib/AppContext';
import { Colors, Fonts } from '@/lib/theme';

export default function LandingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const ctx = useAppContext();
  const [loading, setLoading] = useState<'google' | 'apple' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSuccess = () => {
    router.replace('/');
  };

  const handleGoogleSignIn = async () => {
    setLoading('google');
    setError(null);
    try {
      const user = await ctx.signInWithGoogle();
      if (user) {
        handleSuccess();
      } else {
        setError('Sign-in was cancelled. Please try again.');
      }
    } catch (err) {
      setError('Google sign-in failed. Please try again.');
      console.error('Google sign-in error:', err);
    } finally {
      setLoading(null);
    }
  };

  const handleAppleSignIn = async () => {
    setLoading('apple');
    setError(null);
    try {
      const user = await ctx.signInWithApple();
      if (user) {
        handleSuccess();
      } else {
        setError('Sign-in was cancelled. Please try again.');
      }
    } catch (err) {
      setError('Apple sign-in failed. Please try again.');
      console.error('Apple sign-in error:', err);
    } finally {
      setLoading(null);
    }
  };

  const isLoading = loading !== null;

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.content}>
        <Ionicons name="walk" size={80} color={Colors.primary} />
        <Text style={styles.appName}>Running Routes</Text>
        <Text style={styles.tagline}>Plan the perfect running route, every time</Text>
      </View>

      <View style={styles.buttonArea}>
        {/* Google Sign-In */}
        <Pressable
          onPress={handleGoogleSignIn}
          disabled={isLoading}
          style={({ pressed }) => [
            styles.oauthButton,
            pressed && !isLoading && { transform: [{ scale: 0.98 }] },
            isLoading && { opacity: 0.7 },
          ]}
        >
          {loading === 'google' ? (
            <ActivityIndicator size="small" color={Colors.primaryForeground} />
          ) : (
            <Ionicons name="logo-google" size={20} color={Colors.primaryForeground} />
          )}
          <Text style={styles.oauthText}>
            {loading === 'google' ? 'Signing in...' : 'Continue with Google'}
          </Text>
        </Pressable>

        {/* Apple Sign-In */}
        {Platform.OS !== 'android' && (
          <Pressable
            onPress={handleAppleSignIn}
            disabled={isLoading}
            style={({ pressed }) => [
              styles.oauthButton,
              styles.appleButton,
              pressed && !isLoading && { transform: [{ scale: 0.98 }] },
              isLoading && { opacity: 0.7 },
            ]}
          >
            {loading === 'apple' ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons name="logo-apple" size={20} color="#fff" />
            )}
            <Text style={[styles.oauthText, { color: '#fff' }]}>
              {loading === 'apple' ? 'Signing in...' : 'Continue with Apple'}
            </Text>
          </Pressable>
        )}

        {error && <Text style={styles.errorText}>{error}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  appName: {
    fontFamily: Fonts.sansBold,
    fontSize: 36,
    color: Colors.foreground,
    letterSpacing: -0.5,
    marginTop: 16,
  },
  tagline: {
    fontFamily: Fonts.sans,
    fontSize: 16,
    color: Colors.mutedForeground,
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  buttonArea: {
    paddingHorizontal: 20,
    paddingBottom: 40,
    gap: 12,
  },
  oauthButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: Colors.primary,
    borderRadius: 16,
    paddingVertical: 16,
  },
  appleButton: {
    backgroundColor: '#000',
  },
  oauthText: {
    fontFamily: Fonts.sansBold,
    fontSize: 16,
    color: Colors.primaryForeground,
  },
  errorText: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Colors.destructive,
    textAlign: 'center',
  },
});
