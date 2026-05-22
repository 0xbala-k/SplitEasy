import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
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
import { usePlaidStore } from '@/stores/plaidStore';
import { getLinkToken, WorkerError } from '@/lib/worker';
import { isPlaidLinkNativeAvailable } from '@/lib/plaidLinkAvailable';
import { useRouter } from 'expo-router';

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
          ? 'Expo Go does not ship the Plaid native module, so the button cannot open Link. From the mobile folder run: npx expo run:ios or npx expo run:android'
          : 'The Plaid native module is not in this binary. Rebuild with npx expo run:ios or npx expo run:android after native dependencies are installed.',
      );
      return;
    }

    setLoading(true);
    try {
      const { link_token } = await getLinkToken();
      await destroy().catch(() => {});
      // Plaid RN SDK: call `open` after `create`. Relying only on `create(..., onLoad: () => open())`
      // breaks when native never fires `onLoad`, so Link never appears.
      create({
        token: link_token,
        logLevel: LinkLogLevel.ERROR,
        noLoadingState: false,
      });
      // Defer `open` so `create` can register with the native bridge first (avoids no-op open on some builds).
      requestAnimationFrame(() => {
        open({
          iOSPresentationStyle: LinkIOSPresentationStyle.MODAL,
          onSuccess: (success) => {
            void onLinkSuccess(success);
          },
          onExit: (exit) => {
            onLinkExit(exit);
          },
        });
      });
    } catch (e) {
      console.error('Plaid link failed', e);
      const message =
        e instanceof WorkerError
          ? e.code
          : e instanceof Error
            ? e.message
            : 'Could not start bank linking.';
      Alert.alert('Plaid unavailable', message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Connect your bank</Text>
      <Text style={styles.subtitle}>
        SplitEasy uses Plaid to securely import your transactions. Nothing is stored on any server.
      </Text>

      <Pressable style={styles.btn} onPress={startPlaid} disabled={loading}>
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Connect via Plaid</Text>}
      </Pressable>

      <Pressable style={styles.skip} onPress={() => router.replace('/(tabs)/')}>
        <Text style={styles.skipText}>Skip for now</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, backgroundColor: '#fff' },
  title: { fontSize: 28, fontWeight: '800', color: '#111', marginBottom: 12 },
  subtitle: { fontSize: 15, color: '#666', textAlign: 'center', marginBottom: 40, lineHeight: 22 },
  btn: { backgroundColor: '#007AFF', borderRadius: 14, paddingVertical: 16, paddingHorizontal: 32, minWidth: 220, alignItems: 'center' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  skip: { marginTop: 20 },
  skipText: { color: '#007AFF', fontSize: 15 },
});
