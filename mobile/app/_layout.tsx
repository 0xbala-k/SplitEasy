// mobile/app/_layout.tsx
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Slot, SplashScreen } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StartupScreen } from '@/components/StartupScreen';
import { ToastProvider } from '@/components/ToastProvider';
import { useAuthStore } from '@/stores/authStore';
import { usePlaidStore } from '@/stores/plaidStore';
import { initDb } from '@/lib/db';

if (Platform.OS !== 'web') {
  SplashScreen.preventAutoHideAsync();
}

export default function RootLayout() {
  const { hydrate: hydrateAuth } = useAuthStore();
  const { hydrate: hydratePlaid } = usePlaidStore();
  const [dbSettled, setDbSettled] = useState(false);

  useEffect(() => {
    async function init() {
      try {
        await initDb();
      } catch (e) {
        console.error('initDb failed', e);
      }
      // Settled, not succeeded: a database that failed to open must not
      // strand the user on the startup screen forever. Screens surface their
      // own load errors from there.
      setDbSettled(true);
      await Promise.all([hydrateAuth(), hydratePlaid()]);
    }
    void init();
  }, []);

  useEffect(() => {
    if (
      Platform.OS === 'web' &&
      process.env.NODE_ENV === 'production' &&
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator
    ) {
      navigator.serviceWorker.register('/sw.js').catch((e) => {
        console.error('Service worker registration failed', e);
      });
    }
  }, []);

  return (
    <GestureHandlerRootView style={styles.flex}>
      {/* FriendPickerSheet and AddToVacationSheet call useSafeAreaInsets and
          currently only resolve via the navigator's implicit
          SafeAreaProviderCompat; an explicit root provider makes insets
          reliable everywhere. */}
      <SafeAreaProvider>
        <ToastProvider>
          <BottomSheetModalProvider>
            {/* Nothing may render until the database has been opened. Routes
                query it from mount effects, so a route rendered in the same
                tick as this layout — which is what a deep link or a browser
                refresh does — would otherwise throw "DB not initialized" and
                leave the screen empty until something re-focused it. */}
            {dbSettled ? <Slot /> : <StartupScreen status="Opening your data…" />}
          </BottomSheetModalProvider>
        </ToastProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
