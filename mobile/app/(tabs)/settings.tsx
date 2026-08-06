import { Image, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { showDialog } from '@/lib/dialog';
import { useAuthStore } from '@/stores/authStore';
import { usePlaidStore, PlaidAccount } from '@/stores/plaidStore';
import { Colors, Radius, Shadow, Spacing } from '@/lib/theme';

export default function SettingsScreen() {
  const { display_name, avatar_url, signOut } = useAuthStore();
  const { accounts, isLinked, disconnect } = usePlaidStore();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  function confirmSignOut() {
    showDialog(
      'Sign Out',
      'This will remove all local data from this device. Your Splitwise data is safe.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: async () => {
            await signOut();
            router.replace('/(auth)/');
          },
        },
      ]
    );
  }

  function confirmDisconnect(account: PlaidAccount) {
    const isLast = accounts.length === 1;
    showDialog(
      `Disconnect ${account.institution_name}`,
      isLast
        ? 'This will remove your bank connection and all local transactions.'
        : 'This will remove this bank connection. Other connected accounts remain.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            await disconnect(account.id);
            if (isLast) router.replace('/(auth)/bank-connect');
          },
        },
      ]
    );
  }

  const initials = display_name
    ? display_name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
    : '?';

  return (
    <ScrollView
      style={[styles.root, { paddingTop: insets.top }]}
      contentContainerStyle={styles.scrollContent}
    >
      <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      {/* Profile section */}
      <View style={styles.profileCard}>
        {avatar_url ? (
          <Image source={{ uri: avatar_url }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarInitials}>{initials}</Text>
          </View>
        )}
        <View style={styles.profileInfo}>
          <Text style={styles.profileName} numberOfLines={1}>{display_name ?? 'Unknown'}</Text>
          <Text style={styles.profileSub}>Splitwise account</Text>
        </View>
        <View style={styles.splitwiseBadge}>
          <Ionicons name="checkmark-circle" size={16} color={Colors.success} />
          <Text style={styles.splitwiseBadgeText}>Connected</Text>
        </View>
      </View>

      {/* Bank Accounts */}
      <Text style={styles.sectionLabel}>Bank Accounts</Text>
      <View style={styles.settingsCard}>
        {isLinked ? (
          <>
            {accounts.map((acct, i) => (
              <View key={acct.id}>
                {i > 0 && <View style={styles.divider} />}
                <View style={styles.settingRow}>
                  <View style={styles.settingIcon}>
                    <Ionicons name="business-outline" size={18} color={Colors.primary} />
                  </View>
                  <View style={styles.settingContent}>
                    <Text style={styles.settingTitle} numberOfLines={1}>{acct.institution_name}</Text>
                    <Text style={styles.settingDesc}>Synced via Plaid</Text>
                  </View>
                  <Pressable
                    style={({ pressed }) => [styles.disconnectBtn, pressed && styles.disconnectBtnPressed]}
                    onPress={() => confirmDisconnect(acct)}
                    accessibilityRole="button"
                    accessibilityLabel={`Disconnect ${acct.institution_name}`}
                  >
                    <Ionicons name="unlink-outline" size={15} color={Colors.error} />
                  </Pressable>
                </View>
              </View>
            ))}
            <View style={styles.divider} />
            <Pressable
              style={({ pressed }) => [styles.settingRow, pressed && styles.rowPressed]}
              onPress={() => router.push('/(auth)/bank-connect')}
              accessibilityRole="button"
            >
              <View style={[styles.settingIcon, { backgroundColor: Colors.successLight }]}>
                <Ionicons name="add-circle-outline" size={18} color={Colors.success} />
              </View>
              <View style={styles.settingContent}>
                <Text style={styles.settingTitle}>Add card / account</Text>
                <Text style={styles.settingDesc}>Connect another bank or card via Plaid</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
            </Pressable>
          </>
        ) : (
          <>
            <View style={styles.settingRow}>
              <View style={[styles.settingIcon, { backgroundColor: Colors.surfaceMuted }]}>
                <Ionicons name="business-outline" size={18} color={Colors.textTertiary} />
              </View>
              <View style={styles.settingContent}>
                <Text style={styles.settingTitle}>No bank connected</Text>
                <Text style={styles.settingDesc}>Connect a bank to import transactions</Text>
              </View>
            </View>
            <View style={styles.divider} />
            <Pressable
              style={({ pressed }) => [styles.settingRow, pressed && styles.rowPressed]}
              onPress={() => router.push('/(auth)/bank-connect')}
              accessibilityRole="button"
            >
              <View style={[styles.settingIcon, { backgroundColor: Colors.primaryMuted }]}>
                <Ionicons name="add-circle-outline" size={18} color={Colors.primary} />
              </View>
              <View style={styles.settingContent}>
                <Text style={styles.settingTitle}>Add card / account</Text>
                <Text style={styles.settingDesc}>Connect a bank or card via Plaid</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
            </Pressable>
          </>
        )}
      </View>

      {/* Account */}
      <Text style={styles.sectionLabel}>Account</Text>
      <View style={styles.settingsCard}>
        <Pressable
          style={({ pressed }) => [styles.settingRow, pressed && styles.rowPressed]}
          onPress={confirmSignOut}
          accessibilityRole="button"
        >
          <View style={[styles.settingIcon, styles.settingIconDanger]}>
            <Ionicons name="log-out-outline" size={18} color={Colors.error} />
          </View>
          <Text style={[styles.settingTitle, styles.dangerText]}>Sign out</Text>
          <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  scrollContent: { paddingBottom: Spacing.xxxl },

  header: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  headerTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: Colors.textPrimary,
    letterSpacing: -0.5,
  },

  profileCard: {
    backgroundColor: Colors.surface,
    marginHorizontal: Spacing.lg,
    borderRadius: Radius.xl,
    padding: Spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.xxl,
    ...Shadow.sm,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: Radius.full,
    marginRight: Spacing.md,
  },
  avatarFallback: {
    backgroundColor: Colors.primaryLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarInitials: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.primary,
  },
  profileInfo: { flex: 1 },
  profileName: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  profileSub: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  splitwiseBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.successLight,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    gap: 4,
  },
  splitwiseBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.success,
  },

  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: Spacing.xl,
    marginBottom: Spacing.sm,
  },
  settingsCard: {
    backgroundColor: Colors.surface,
    marginHorizontal: Spacing.lg,
    borderRadius: Radius.xl,
    marginBottom: Spacing.xxl,
    overflow: 'hidden',
    ...Shadow.sm,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
  },
  rowPressed: { backgroundColor: Colors.surfaceMuted },
  settingIcon: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    backgroundColor: Colors.primaryMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  settingIconDanger: { backgroundColor: Colors.errorLight },
  settingContent: { flex: 1 },
  settingTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  settingDesc: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  dangerText: { color: Colors.error, flex: 1 },
  disconnectBtn: {
    width: 32,
    height: 32,
    borderRadius: Radius.sm,
    backgroundColor: Colors.errorLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  disconnectBtnPressed: { backgroundColor: '#FCA5A5' },
  divider: {
    height: 1,
    backgroundColor: Colors.divider,
    marginLeft: 16 + 36 + 12,
  },
});
