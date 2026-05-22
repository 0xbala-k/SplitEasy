import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import {
  create,
  open,
  destroy,
  LinkSuccess,
  LinkExit,
  LinkLogLevel,
  LinkIOSPresentationStyle,
} from 'react-native-plaid-link-sdk';
import { Ionicons } from '@expo/vector-icons';
import { usePlaidStore } from '@/stores/plaidStore';
import { getLinkToken, WorkerError } from '@/lib/worker';
import { isPlaidLinkNativeAvailable } from '@/lib/plaidLinkAvailable';
import { useRouter } from 'expo-router';
import { Colors, Radius, Shadow, Spacing } from '@/lib/theme';

export default function BankConnectScreen() {
  const [loading, setLoading] = useState(false);
  const linkBank = usePlaidStore((s) => s.linkBank);
  const router = useRouter();

  useEffect(() => {
    return () => {
      void destroy().catch(() => {});
    };
  }, []);

  async function onLinkSuccess(success: LinkSuccess) {
    const institutionName = success.metadata.institution?.name ?? 'Your bank';
    await linkBank(success.publicToken, institutionName);
    await destroy().catch(() => {});
    router.replace('/(tabs)/');
  }

  function onLinkExit(_exit: LinkExit) {
    void destroy().catch(() => {});
  }

  async function startPlaid() {
    if (!isPlaidLinkNativeAvailable()) {
      const inExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
      Alert.alert(
        'Plaid needs a native build',
        inExpoGo
          ? 'Expo Go does not ship the Plaid native module. Run: npx expo run:ios'
          : 'The Plaid native module is not in this binary. Rebuild with npx expo run:ios.',
      );
      return;
    }

    setLoading(true);
    try {
      const { link_token } = await getLinkToken();
      await destroy().catch(() => {});
      create({
        token: link_token,
        logLevel: LinkLogLevel.ERROR,
        noLoadingState: false,
      });
      requestAnimationFrame(() => {
        open({
          iOSPresentationStyle: LinkIOSPresentationStyle.MODAL,
          onSuccess: (success) => { void onLinkSuccess(success); },
          onExit: (exit) => { onLinkExit(exit); },
        });
      });
    } catch (e) {
      console.error('Plaid link failed', e);
      const message =
        e instanceof WorkerError ? e.code
        : e instanceof Error ? e.message
        : 'Could not start bank linking.';
      Alert.alert('Plaid unavailable', message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.hero} />

      {/* Hero */}
      <View style={styles.hero}>
        <View style={styles.stepRow}>
          <View style={[styles.stepDot, styles.stepDotDone]} />
          <View style={styles.stepLine} />
          <View style={[styles.stepDot, styles.stepDotActive]} />
        </View>
        <View style={styles.iconRing}>
          <Ionicons name="shield-checkmark-outline" size={32} color={Colors.primary} />
        </View>
        <Text style={styles.title}>Connect your bank</Text>
        <Text style={styles.subtitle}>Securely import transactions via Plaid.</Text>
      </View>

      {/* Card */}
      <View style={styles.card}>
        <SecurityItem icon="lock-closed-outline" text="Bank-level 256-bit encryption" />
        <SecurityItem icon="eye-off-outline" text="Credentials never stored on our servers" />
        <SecurityItem icon="refresh-outline" text="Read-only access — we can't move your money" />

        <Pressable
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
          onPress={startPlaid}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel="Connect via Plaid"
        >
          {loading ? (
            <ActivityIndicator color={Colors.textInverse} />
          ) : (
            <>
              <Ionicons name="link-outline" size={20} color={Colors.textInverse} style={styles.btnIcon} />
              <Text style={styles.btnText}>Connect via Plaid</Text>
            </>
          )}
        </Pressable>

        <Pressable
          style={styles.skip}
          onPress={() => router.replace('/(tabs)/')}
          accessibilityRole="button"
          accessibilityLabel="Skip bank connection for now"
        >
          <Text style={styles.skipText}>Skip for now</Text>
        </Pressable>
      </View>
    </View>
  );
}

function SecurityItem({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return (
    <View style={styles.secRow}>
      <View style={styles.secIcon}>
        <Ionicons name={icon} size={16} color={Colors.success} />
      </View>
      <Text style={styles.secText}>{text}</Text>
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
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.xxl,
  },
  stepDot: {
    width: 10,
    height: 10,
    borderRadius: Radius.full,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  stepDotDone: { backgroundColor: Colors.success },
  stepDotActive: { backgroundColor: Colors.textInverse, width: 12, height: 12 },
  stepLine: { width: 40, height: 2, backgroundColor: 'rgba(255,255,255,0.25)', marginHorizontal: Spacing.sm },

  iconRing: {
    width: 72,
    height: 72,
    borderRadius: Radius.xl,
    backgroundColor: Colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.xl,
    ...Shadow.md,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: Colors.textInverse,
    letterSpacing: -0.3,
    marginBottom: Spacing.sm,
  },
  subtitle: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.65)',
    textAlign: 'center',
  },

  card: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radius.xxl,
    borderTopRightRadius: Radius.xxl,
    padding: Spacing.xxl,
    paddingBottom: 40,
    ...Shadow.md,
  },

  secRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  secIcon: {
    width: 32,
    height: 32,
    borderRadius: Radius.sm,
    backgroundColor: Colors.successLight,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  secText: {
    flex: 1,
    fontSize: 14,
    color: Colors.textSecondary,
    lineHeight: 20,
  },

  btn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: 16,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 52,
    marginTop: Spacing.sm,
    ...Shadow.sm,
  },
  btnPressed: { backgroundColor: Colors.primaryDark },
  btnIcon: { marginRight: Spacing.sm },
  btnText: { color: Colors.textInverse, fontSize: 16, fontWeight: '700' },

  skip: { paddingVertical: Spacing.lg, alignItems: 'center', marginTop: Spacing.xs },
  skipText: { color: Colors.textSecondary, fontSize: 15, fontWeight: '500' },
});
