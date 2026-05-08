import React, { useEffect, useState } from 'react';
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
import * as AppleAuthentication from 'expo-apple-authentication';
import { useAppContext } from '@/lib/AppContext';
import { Colors, Fonts } from '@/lib/theme';

export default function LandingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const ctx = useAppContext();
  const [loading, setLoading] = useState<'apple' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'ios') {
      AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
    }
  }, []);

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
      }
      // null = user dismissed the Apple sheet (intentional cancel). Silent
      // no-op — surfacing this as an error misled users who deliberately
      // backed out and made the screen feel broken.
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
        {/* Apple Sign-In — uses the native AppleAuthenticationButton so it
            renders Apple's HIG-compliant button (required by App Review). */}
        {appleAvailable && (
          <View style={styles.appleButtonWrap}>
            {loading === 'apple' ? (
              <View style={styles.appleLoading}>
                <ActivityIndicator size="small" color="#000" />
              </View>
            ) : (
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
                cornerRadius={16}
                style={styles.appleButton}
                onPress={handleAppleSignIn}
              />
            )}
          </View>
        )}

        {/* Divider */}
        {appleAvailable && (
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or</Text>
            <View style={styles.dividerLine} />
          </View>
        )}

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
  appleButtonWrap: {
    height: 52,
  },
  appleButton: {
    width: '100%',
    height: 52,
  },
  appleLoading: {
    height: 52,
    borderRadius: 16,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
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
