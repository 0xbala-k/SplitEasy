// mobile/app/_layout.tsx
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Redirect, Slot, SplashScreen } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { ToastProvider } from '@/components/ToastProvider';
import { useAuthStore } from '@/stores/authStore';
import { usePlaidStore } from '@/stores/plaidStore';
import { initDb } from '@/lib/db';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { isAuthenticated, isHydrated: authHydrated, hydrate: hydrateAuth } = useAuthStore();
  const { isLinked, isHydrated: plaidHydrated, hydrate: hydratePlaid } = usePlaidStore();

  useEffect(() => {
    async function init() {
      await initDb();
      await Promise.all([hydrateAuth(), hydratePlaid()]);
      SplashScreen.hideAsync();
    }
    init();
  }, []);

  if (!authHydrated || !plaidHydrated) return null;

  if (!isAuthenticated) return <Redirect href="/(auth)/" />;
  if (!isLinked) return <Redirect href="/(auth)/bank-connect" />;

  return (
    <GestureHandlerRootView style={styles.flex}>
      <ToastProvider>
        <BottomSheetModalProvider>
          <Slot />
        </BottomSheetModalProvider>
      </ToastProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
