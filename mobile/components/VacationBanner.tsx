// mobile/components/VacationBanner.tsx
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useVacationStore } from '@/stores/vacationStore';
import { Colors, Radius, Shadow, Spacing } from '@/lib/theme';

export function VacationBanner() {
  const router = useRouter();
  const vacations = useVacationStore((s) => s.vacations);
  const activeVacation = useVacationStore((s) => s.activeVacation);
  const load = useVacationStore((s) => s.load);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const inProgress = activeVacation ?? vacations.find((v) => v.status === 'draft') ?? null;

  if (inProgress) {
    return (
      <Pressable
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
        onPress={() => router.push(`/vacation/${inProgress.id}`)}
        accessibilityRole="button"
        accessibilityLabel={`Open ${inProgress.name} vacation`}
      >
        <View style={styles.icon}>
          <Ionicons name="airplane-outline" size={18} color={Colors.primary} />
        </View>
        <View style={styles.info}>
          <Text style={styles.title} numberOfLines={1}>{inProgress.name}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {inProgress.start_date && inProgress.end_date
              ? `${inProgress.start_date} – ${inProgress.end_date}`
              : inProgress.status === 'active' ? 'Active vacation' : 'Not started yet'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
      </Pressable>
    );
  }

  if (vacations.length === 0) {
    return (
      <Pressable
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
        onPress={() => router.push('/vacation')}
        accessibilityRole="button"
        accessibilityLabel="Create a vacation"
      >
        <View style={styles.icon}>
          <Ionicons name="airplane-outline" size={18} color={Colors.primary} />
        </View>
        <View style={styles.info}>
          {/* Static copy, not user data — let it wrap rather than truncate. */}
          <Text style={styles.title} numberOfLines={2}>Track vacation spending separately</Text>
          <Text style={styles.subtitle} numberOfLines={1}>Create a vacation</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
      </Pressable>
    );
  }

  return (
    <Pressable
      style={styles.linkRow}
      onPress={() => router.push('/vacation')}
      accessibilityRole="button"
      accessibilityLabel="View vacations"
    >
      <Ionicons name="airplane-outline" size={14} color={Colors.primary} style={{ marginRight: 6 }} />
      <Text style={styles.linkText}>Vacations</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
    ...Shadow.sm,
  },
  cardPressed: { backgroundColor: Colors.surfaceMuted },
  icon: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  info: { flex: 1 },
  title: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  subtitle: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },

  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  linkText: { fontSize: 13, fontWeight: '600', color: Colors.primary },
});
