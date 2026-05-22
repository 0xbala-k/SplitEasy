import { SplashScreen, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useAuthStore } from '@/stores/authStore';
import { usePlaidStore } from '@/stores/plaidStore';

export default function Index() {
  const router = useRouter();
  const { isAuthenticated, isHydrated: authHydrated } = useAuthStore();
  const { isLinked, isHydrated: plaidHydrated } = usePlaidStore();
  const didNavigate = useRef(false);

  const ready = authHydrated && plaidHydrated;

  useLayoutEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  useEffect(() => {
    if (!ready || didNavigate.current) return;
    didNavigate.current = true;

    const path = !isAuthenticated
      ? '/(auth)/'
      : !isLinked
        ? '/(auth)/bank-connect'
        : '/(tabs)/';

    router.replace(path);
  }, [ready, isAuthenticated, isLinked, router]);

  const statusLabel = !authHydrated
    ? 'Restoring session…'
    : !plaidHydrated
      ? 'Restoring bank link…'
      : 'Opening…';

  return (
    <View style={styles.screen} accessibilityLabel="SplitEasy startup">
      <Text style={styles.wordmark}>SplitEasy</Text>
      <Text style={styles.tagline}>Expense splits, simplified</Text>
      <ActivityIndicator size="large" color="#fff" style={styles.spinner} />
      <Text style={styles.status}>{statusLabel}</Text>
      <Text style={styles.debug}>
        JS bundle OK · v{Constants.expoConfig?.version ?? '1.0.0'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#5C7AEA',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  wordmark: {
    fontSize: 40,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: -0.5,
  },
  tagline: {
    marginTop: 8,
    fontSize: 16,
    color: 'rgba(255,255,255,0.92)',
    textAlign: 'center',
  },
  spinner: {
    marginTop: 36,
  },
  status: {
    marginTop: 20,
    fontSize: 15,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.95)',
  },
  debug: {
    position: 'absolute',
    bottom: 48,
    fontSize: 12,
    color: 'rgba(255,255,255,0.75)',
  },
});
