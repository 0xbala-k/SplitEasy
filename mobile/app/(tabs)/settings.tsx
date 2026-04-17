import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuthStore } from '@/stores/authStore';
import { usePlaidStore } from '@/stores/plaidStore';

export default function SettingsScreen() {
  const { display_name, avatar_url, signOut } = useAuthStore();
  const { institution_name, isLinked, disconnect } = usePlaidStore();

  function confirmSignOut() {
    Alert.alert('Sign Out', 'This will remove all local data from this device. Your Splitwise data is safe.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: signOut },
    ]);
  }

  function confirmDisconnect() {
    Alert.alert('Disconnect Bank', 'This will remove your bank connection and all local transactions.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: disconnect },
    ]);
  }

  return (
    <View style={styles.container}>
      {/* Splitwise account */}
      <Text style={styles.sectionTitle}>Splitwise Account</Text>
      <View style={styles.card}>
        {avatar_url ? (
          <Image source={{ uri: avatar_url }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]} />
        )}
        <Text style={styles.name}>{display_name ?? 'Unknown'}</Text>
        <Pressable style={styles.dangerBtn} onPress={confirmSignOut}>
          <Text style={styles.dangerText}>Sign Out</Text>
        </Pressable>
      </View>

      {/* Bank account */}
      <Text style={styles.sectionTitle}>Connected Bank</Text>
      <View style={styles.card}>
        {isLinked ? (
          <>
            <Text style={styles.institution}>{institution_name ?? 'Connected'}</Text>
            <Pressable style={styles.dangerBtn} onPress={confirmDisconnect}>
              <Text style={styles.dangerText}>Disconnect</Text>
            </Pressable>
          </>
        ) : (
          <Text style={styles.noBank}>No bank connected</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5', padding: 20 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: '#888', textTransform: 'uppercase', marginBottom: 8, marginTop: 24 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  avatarFallback: { backgroundColor: '#ddd' },
  name: { flex: 1, fontSize: 15, fontWeight: '600', color: '#111' },
  institution: { flex: 1, fontSize: 15, fontWeight: '600', color: '#111' },
  noBank: { flex: 1, fontSize: 15, color: '#888' },
  dangerBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: '#FEE2E2' },
  dangerText: { color: '#c0392b', fontWeight: '600', fontSize: 13 },
});
