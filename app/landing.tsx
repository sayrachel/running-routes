import React, { useState } from 'react';
import {
  View,
  Text,
  Image,
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
  const [loading, setLoading] = useState<'apple' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSuccess = () => {
    router.replace('/');
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
    } catch (err: any) {
      const msg = err?.message || 'Apple sign-in failed. Please try again.';
      setError(msg);
      console.error('Apple sign-in error:', err);
    } finally {
      setLoading(null);
    }
  };

  const handleGuestContinue = () => {
    ctx.setIsLoggedIn(true);
    ctx.setUser({ name: 'Guest', email: '', avatar: '' });
    router.replace('/');
  };

  const isLoading = loading !== null;

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.content}>
        <Image source={require('@/assets/icon.png')} style={styles.appIcon} />
        <Text style={styles.appName}>Run Routes</Text>
        <Text style={styles.tagline}>Generate new running routes</Text>
      </View>

      <View style={styles.buttonArea}>
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

        {/* Divider */}
        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* Continue as Guest */}
        <Pressable
          onPress={handleGuestContinue}
          disabled={isLoading}
          style={({ pressed }) => [
            styles.oauthButton,
            styles.guestButton,
            pressed && !isLoading && { transform: [{ scale: 0.98 }] },
          ]}
        >
          <Ionicons name="person-outline" size={20} color={Colors.foreground} />
          <Text style={[styles.oauthText, { color: Colors.foreground }]}>
            Continue as Guest
          </Text>
        </Pressable>

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
  appIcon: {
    width: 100,
    height: 100,
    borderRadius: 22,
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
  guestButton: {
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: Colors.border,
  },
  dividerText: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Colors.mutedForeground,
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
