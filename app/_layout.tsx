import { useEffect } from 'react';
import { View, ActivityIndicator, Platform, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { SpaceMono_400Regular, SpaceMono_700Bold } from '@expo-google-fonts/space-mono';
import { AppProvider, useAppContext } from '@/lib/AppContext';
import { Colors } from '@/lib/theme';

SplashScreen.preventAutoHideAsync();

function useWebMobileFrame() {
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const style = document.createElement('style');
    style.textContent = `
      html, body {
        background-color: #0b0f14 !important;
      }
      #root {
        max-width: 390px !important;
        max-height: 844px !important;
        margin: 20px auto !important;
        border-radius: 40px !important;
        box-shadow: 0 0 0 8px #1a1f28, 0 0 40px rgba(0,0,0,0.5) !important;
        overflow: hidden !important;
      }
      @media (min-height: 900px) {
        body {
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
        }
        #root {
          margin: 0 auto !important;
        }
      }
      @media (max-width: 430px) {
        #root {
          max-width: 100% !important;
          max-height: 100% !important;
          border-radius: 0 !important;
          box-shadow: none !important;
        }
      }
    `;
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); };
  }, []);
}

function AuthGate({ children }: { children: React.ReactNode }) {
  // TODO: remove bypass when done testing
  return <>{children}</>;
}

const layoutStyles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default function RootLayout() {
  useWebMobileFrame();
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    SpaceMono_400Regular,
    SpaceMono_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <AppProvider>
      <AuthGate>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: Colors.background },
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen name="landing" />
          <Stack.Screen name="index" />
          <Stack.Screen name="run" />
        </Stack>
      </AuthGate>
    </AppProvider>
  );
}
