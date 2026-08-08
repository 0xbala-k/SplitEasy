// mobile/components/StartupScreen.tsx
// The pre-app screen, shared by the root layout (while the database opens) and
// app/index.tsx (while auth and Plaid state rehydrate), so the two stages look
// like one continuous startup rather than two different screens.
import Constants from 'expo-constants';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

export function StartupScreen({ status }: { status: string }) {
  return (
    <View style={styles.screen} accessibilityLabel="SplitEasy startup">
      <Text style={styles.wordmark}>SplitEasy</Text>
      <Text style={styles.tagline}>Expense splits, simplified</Text>
      <ActivityIndicator size="large" color="#fff" style={styles.spinner} />
      <Text style={styles.status}>{status}</Text>
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
