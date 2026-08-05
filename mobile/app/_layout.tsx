// mobile/app/_layout.tsx
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Slot, SplashScreen } from 'expo-router';
import { useEffect } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
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

  useEffect(() => {
    async function init() {
      try {
        await initDb();
      } catch (e) {
        console.error('initDb failed', e);
      }
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
            <Slot />
          </BottomSheetModalProvider>
        </ToastProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
