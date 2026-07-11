// mobile/app/oauth/callback.tsx
// Web-only landing route for the Splitwise OAuth redirect. Native sign-in
// never navigates here (it uses the spliteasy:// scheme via expo-web-browser).
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuthStore } from '@/stores/authStore';
import { usePlaidStore } from '@/stores/plaidStore';
import { Colors, Radius, Spacing } from '@/lib/theme';

export default function OAuthCallbackScreen() {
  const params = useLocalSearchParams<{ code?: string; error?: string }>();
  const router = useRouter();
  const signIn = useAuthStore((s) => s.signIn);
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  const code = typeof params.code === 'string' ? params.code : undefined;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!code || typeof window === 'undefined') {
      setFailed(true);
      return;
    }
    void (async () => {
      try {
        await signIn(code, `${window.location.origin}/oauth/callback`);
        // Root layout hydration may not have finished — hydrate explicitly so
        // the isLinked routing decision is correct.
        await usePlaidStore.getState().hydrate();
        router.replace(usePlaidStore.getState().isLinked ? '/(tabs)/' : '/(auth)/bank-connect');
      } catch (e) {
        console.error('Splitwise OAuth exchange failed', e);
        setFailed(true);
      }
    })();
  }, [code, router, signIn]);

  return (
    <View style={styles.root}>
      {failed ? (
        <>
          <Text style={styles.title}>Sign-in failed</Text>
          <Text style={styles.subtitle}>We couldn't complete the Splitwise sign-in.</Text>
          <Pressable
            style={styles.btn}
            onPress={() => router.replace('/(auth)/')}
            accessibilityRole="button"
            accessibilityLabel="Back to sign in"
          >
            <Text style={styles.btnText}>Back to sign in</Text>
          </Pressable>
        </>
      ) : (
        <>
          <ActivityIndicator size="large" color={Colors.textInverse} />
          <Text style={styles.subtitle}>Completing sign-in…</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.hero,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.xxxl,
  },
  title: { fontSize: 22, fontWeight: '800', color: Colors.textInverse, marginBottom: Spacing.sm },
  subtitle: { fontSize: 15, color: 'rgba(255,255,255,0.75)', marginTop: Spacing.md, textAlign: 'center' },
  btn: {
    marginTop: Spacing.xxl,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    paddingVertical: 14,
    paddingHorizontal: Spacing.xxl,
  },
  btnText: { color: Colors.primary, fontSize: 15, fontWeight: '700' },
});
