import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { Pressable, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import { useState } from 'react';
import Constants from 'expo-constants';
import { useAuthStore } from '@/stores/authStore';
import { usePlaidStore } from '@/stores/plaidStore';

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
    <View style={styles.container}>
      <Text style={styles.title}>SplitEasy</Text>
      <Text style={styles.subtitle}>Stop forgetting to split expenses.</Text>
      <Pressable style={styles.btn} onPress={handleSignIn} disabled={loading}>
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.btnText}>Sign in with Splitwise</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, backgroundColor: '#fff' },
  title: { fontSize: 36, fontWeight: '800', color: '#111', marginBottom: 8 },
  subtitle: { fontSize: 16, color: '#666', marginBottom: 48, textAlign: 'center' },
  btn: { backgroundColor: '#5C7AEA', borderRadius: 14, paddingVertical: 16, paddingHorizontal: 32, minWidth: 220, alignItems: 'center' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
