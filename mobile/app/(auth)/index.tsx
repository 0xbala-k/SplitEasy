import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { Pressable, StatusBar, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import { useState } from 'react';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '@/stores/authStore';
import { usePlaidStore } from '@/stores/plaidStore';
import { Colors, Radius, Shadow, Spacing } from '@/lib/theme';

const REDIRECT_URI = 'spliteasy://oauth/callback';
const CLIENT_ID: string = Constants.expoConfig?.extra?.splitwiseClientId ?? '';

export default function WelcomeScreen() {
  const [loading, setLoading] = useState(false);
  const signIn = useAuthStore((s) => s.signIn);
  const router = useRouter();

  async function handleSignIn() {
    setLoading(true);
    try {
      const authUrl =
        `https://secure.splitwise.com/oauth/authorize` +
        `?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

      const result = await WebBrowser.openAuthSessionAsync(authUrl, REDIRECT_URI);
      if (result.type !== 'success') return;

      const url = Linking.parse(result.url);
      const code = url.queryParams?.code as string | undefined;
      if (!code) return;

      await signIn(code, REDIRECT_URI);

      const isLinked = usePlaidStore.getState().isLinked;
      router.replace(isLinked ? '/(tabs)/' : '/(auth)/bank-connect');
    } catch (err) {
      console.error('Sign in failed', err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.hero} />

      {/* Hero section */}
      <View style={styles.hero}>
        <View style={styles.logoRing}>
          <Ionicons name="swap-horizontal" size={32} color={Colors.primary} />
        </View>
        <Text style={styles.appName}>SplitEasy</Text>
        <Text style={styles.tagline}>Split expenses with friends,{'\n'}effortlessly.</Text>
      </View>

      {/* Content card */}
      <View style={styles.card}>
        <View style={styles.featureRow}>
          <FeatureItem icon="card-outline" label="Link your bank" />
          <FeatureItem icon="people-outline" label="Pick friends" />
          <FeatureItem icon="checkmark-circle-outline" label="Split & done" />
        </View>

        <Text style={styles.hint}>
          Sign in with Splitwise to see your friends and create shared expenses automatically.
        </Text>

        <Pressable
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
          onPress={handleSignIn}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel="Sign in with Splitwise"
        >
          {loading ? (
            <ActivityIndicator color={Colors.textInverse} />
          ) : (
            <>
              <Ionicons name="log-in-outline" size={20} color={Colors.textInverse} style={styles.btnIcon} />
              <Text style={styles.btnText}>Sign in with Splitwise</Text>
            </>
          )}
        </Pressable>

        <Text style={styles.legal}>
          Your bank credentials are never stored on any server.
        </Text>
      </View>
    </View>
  );
}

function FeatureItem({ icon, label }: { icon: keyof typeof Ionicons.glyphMap; label: string }) {
  return (
    <View style={styles.feature}>
      <View style={styles.featureIcon}>
        <Ionicons name={icon} size={20} color={Colors.primary} />
      </View>
      <Text style={styles.featureLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.hero },

  hero: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.xxxl,
    paddingTop: 60,
  },
  logoRing: {
    width: 72,
    height: 72,
    borderRadius: Radius.xl,
    backgroundColor: Colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.xl,
    ...Shadow.md,
  },
  appName: {
    fontSize: 36,
    fontWeight: '800',
    color: Colors.textInverse,
    letterSpacing: -0.5,
    marginBottom: Spacing.sm,
  },
  tagline: {
    fontSize: 17,
    color: 'rgba(255,255,255,0.72)',
    textAlign: 'center',
    lineHeight: 26,
  },

  card: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    padding: Spacing.xxl,
    paddingBottom: 40,
    ...Shadow.md,
  },
  featureRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Spacing.xxl,
  },
  feature: {
    alignItems: 'center',
    flex: 1,
  },
  featureIcon: {
    width: 48,
    height: 48,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  featureLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.textSecondary,
    textAlign: 'center',
  },

  hint: {
    fontSize: 14,
    color: Colors.textSecondary,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: Spacing.xl,
  },
  btn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: 16,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 52,
    ...Shadow.sm,
  },
  btnPressed: { backgroundColor: Colors.primaryDark },
  btnIcon: { marginRight: Spacing.sm },
  btnText: { color: Colors.textInverse, fontSize: 16, fontWeight: '700' },

  legal: {
    fontSize: 12,
    color: Colors.textTertiary,
    textAlign: 'center',
    marginTop: Spacing.lg,
    lineHeight: 18,
  },
});
