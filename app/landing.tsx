import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAppContext } from '@/lib/AppContext';
import { Colors, Fonts } from '@/lib/theme';

export default function LandingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const ctx = useAppContext();

  const handleSignIn = () => {
    ctx.setUser({ name: 'Alex Runner', email: 'alex@example.com', avatar: '' });
    ctx.setIsLoggedIn(true);
    router.replace('/');
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.content}>
        <Ionicons name="walk" size={80} color={Colors.primary} />
        <Text style={styles.appName}>RouteForge</Text>
        <Text style={styles.tagline}>Plan the perfect running route, every time</Text>
      </View>

      <View style={styles.buttonArea}>
        <Pressable
          onPress={handleSignIn}
          style={({ pressed }) => [
            styles.signInButton,
            pressed && { transform: [{ scale: 0.98 }] },
          ]}
        >
          <Ionicons name="logo-google" size={20} color={Colors.primaryForeground} />
          <Text style={styles.signInText}>Sign in with Google</Text>
        </Pressable>
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
  },
  signInButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: Colors.primary,
    borderRadius: 16,
    paddingVertical: 16,
  },
  signInText: {
    fontFamily: Fonts.sansBold,
    fontSize: 16,
    color: Colors.primaryForeground,
  },
});
