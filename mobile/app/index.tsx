import { SplashScreen, useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { StartupScreen } from '@/components/StartupScreen';
import { useAuthStore } from '@/stores/authStore';
import { usePlaidStore } from '@/stores/plaidStore';

export default function Index() {
  const router = useRouter();
  const { hasSession, isHydrated: authHydrated } = useAuthStore();
  const { isLinked, isHydrated: plaidHydrated } = usePlaidStore();
  const didNavigate = useRef(false);

  const ready = authHydrated && plaidHydrated;

  useLayoutEffect(() => {
    if (Platform.OS !== 'web') void SplashScreen.hideAsync();
  }, []);

  useEffect(() => {
    if (!ready || didNavigate.current) return;
    didNavigate.current = true;

    // Routes on hasSession, NOT on token validity. A dead token (expired, or a
    // lapsed Splitwise Pro subscription) must still open the app — the local
    // database holds every transaction, split and vacation, and bouncing to the
    // welcome screen makes that data unreachable.
    const path = !hasSession
      ? '/(auth)/'
      : !isLinked
        ? '/(auth)/bank-connect'
        : '/(tabs)/';

    router.replace(path);
  }, [ready, hasSession, isLinked, router]);

  const statusLabel = !authHydrated
    ? 'Restoring session…'
    : !plaidHydrated
      ? 'Restoring bank link…'
      : 'Opening…';

  return <StartupScreen status={statusLabel} />;
}
