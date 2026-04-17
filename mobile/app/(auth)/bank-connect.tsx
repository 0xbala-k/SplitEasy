import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { PlaidLink, LinkSuccess, LinkExit, LinkLogLevel, LinkIOSPresentationStyle } from 'react-native-plaid-link-sdk';
import { usePlaidStore } from '@/stores/plaidStore';
import { getLinkToken } from '@/lib/worker';
import { useRouter } from 'expo-router';

export default function BankConnectScreen() {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const linkBank = usePlaidStore((s) => s.linkBank);
  const router = useRouter();

  async function startPlaid() {
    setLoading(true);
    try {
      const { link_token } = await getLinkToken();
      setLinkToken(link_token);
    } finally {
      setLoading(false);
    }
  }

  async function onSuccess(success: LinkSuccess) {
    const institutionName = success.metadata.institution?.name ?? 'Your bank';
    await linkBank(success.publicToken, institutionName);
    setLinkToken(null);
  }

  function onExit(_exit: LinkExit) {
    setLinkToken(null);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Connect your bank</Text>
      <Text style={styles.subtitle}>
        SplitEasy uses Plaid to securely import your transactions. Nothing is stored on any server.
      </Text>

      {linkToken ? (
        <PlaidLink
          tokenConfig={{ token: linkToken, logLevel: LinkLogLevel.ERROR, noLoadingState: false }}
          onSuccess={onSuccess}
          onExit={onExit}
          iOSPresentationStyle={LinkIOSPresentationStyle.MODAL}
        >
          <View style={styles.btn}>
            <Text style={styles.btnText}>Tap to open Plaid</Text>
          </View>
        </PlaidLink>
      ) : (
        <Pressable style={styles.btn} onPress={startPlaid} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Connect via Plaid</Text>}
        </Pressable>
      )}

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
