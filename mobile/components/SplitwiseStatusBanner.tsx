import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useState } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { signInWithSplitwise } from '@/lib/splitwiseAuth';
import { flushQueue } from '@/lib/splitwiseQueue';
import { Colors, Radius, Spacing } from '@/lib/theme';

const CLIENT_ID: string = Constants.expoConfig?.extra?.splitwiseClientId ?? '';
const SUBSCRIPTION_URL = 'https://secure.splitwise.com/settings/subscription';

// Splitwise returns a bare 401 for both an expired token and a lapsed Pro
// subscription. If the failure outlived the most recent OAuth, the token is
// definitionally fresh, so expiry is eliminated and Pro is the likely cause.
function failureOutlivedLastReconnect(lastReconnectAt: string | null): boolean {
  return lastReconnectAt !== null;
}

export function SplitwiseStatusBanner() {
  const tokenValid = useAuthStore((s) => s.tokenValid);
  const lastReconnectAt = useAuthStore((s) => s.lastReconnectAt);
  const signIn = useAuthStore((s) => s.signIn);
  const [busy, setBusy] = useState(false);

  if (tokenValid) return null;

  const likelyPro = failureOutlivedLastReconnect(lastReconnectAt);

  async function handleReconnect() {
    setBusy(true);
    try {
      const result = await signInWithSplitwise(CLIENT_ID);
      // null on web (the page is navigating away to the OAuth redirect) and on
      // native cancel. app/oauth/callback.tsx completes the web case.
      if (result) {
        await signIn(result.code, result.redirectUri);
        void flushQueue();
      }
    } catch (e) {
      console.error('Splitwise reconnect failed', e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.root} testID="splitwise-status-banner">
      <Text style={styles.title}>
        {likelyPro ? "Reconnecting didn't help" : "Splitwise isn't responding"}
      </Text>
      <Text style={styles.body}>
        {likelyPro
          ? 'This usually means a lapsed Splitwise Pro subscription, which the API now requires. Your data is safe on this device.'
          : 'Your data is safe on this device — nothing has been lost.'}
      </Text>
      <View style={styles.actions}>
        {likelyPro && (
          <Pressable
            style={styles.primaryBtn}
            onPress={() => Linking.openURL(SUBSCRIPTION_URL)}
            accessibilityRole="button"
            accessibilityLabel="Check Splitwise subscription"
          >
            <Text style={styles.primaryText}>Check subscription</Text>
          </Pressable>
        )}
        <Pressable
          style={likelyPro ? styles.secondaryBtn : styles.primaryBtn}
          onPress={handleReconnect}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Reconnect Splitwise"
        >
          <Text style={likelyPro ? styles.secondaryText : styles.primaryText}>
            {busy ? 'Reconnecting…' : 'Reconnect'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: '#FEF3C7',
    borderBottomColor: '#FCD34D',
    borderBottomWidth: 1,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  title: { fontSize: 14, fontWeight: '700', color: '#92400E' },
  body: { fontSize: 13, color: '#92400E', marginTop: 2 },
  actions: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  primaryBtn: {
    backgroundColor: '#92400E',
    borderRadius: Radius.md,
    paddingVertical: 8,
    paddingHorizontal: Spacing.lg,
  },
  primaryText: { color: Colors.textInverse, fontSize: 13, fontWeight: '700' },
  secondaryBtn: {
    borderColor: '#92400E',
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingVertical: 8,
    paddingHorizontal: Spacing.lg,
  },
  secondaryText: { color: '#92400E', fontSize: 13, fontWeight: '700' },
});

export default SplitwiseStatusBanner;
