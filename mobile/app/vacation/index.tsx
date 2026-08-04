// mobile/app/vacation/index.tsx
import { useCallback } from 'react';
import { FlatList, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useVacationStore } from '@/stores/vacationStore';
import { Vacation } from '@/lib/types';
import { Colors, Radius, Shadow, Spacing } from '@/lib/theme';

export default function VacationListScreen() {
  const router = useRouter();
  const vacations = useVacationStore((s) => s.vacations);
  const load = useVacationStore((s) => s.load);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const inProgress = vacations.filter((v) => v.status !== 'ended');
  const past = vacations.filter((v) => v.status === 'ended');

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={24} color={Colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>Vacations</Text>
        <Pressable
          onPress={() => router.push('/vacation/new')}
          accessibilityRole="button"
          accessibilityLabel="New vacation"
        >
          <Ionicons name="add" size={26} color={Colors.primary} />
        </Pressable>
      </View>

      {vacations.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Ionicons name="airplane-outline" size={40} color={Colors.textTertiary} />
          <Text style={styles.emptyTitle}>No vacations yet</Text>
          <Text style={styles.emptySubtitle}>Create one to track a trip's spending separately.</Text>
        </View>
      ) : (
        <FlatList
          data={[...inProgress, ...past]}
          keyExtractor={(v) => v.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <VacationRow vacation={item} onPress={() => router.push(`/vacation/${item.id}`)} />
          )}
        />
      )}
    </View>
  );
}

function VacationRow({ vacation, onPress }: { vacation: Vacation; onPress: () => void }) {
  const statusLabel = vacation.status === 'active' ? 'Active' : vacation.status === 'draft' ? 'Draft' : 'Ended';
  const dates = vacation.start_date && vacation.end_date ? `${vacation.start_date} – ${vacation.end_date}` : null;

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${vacation.name} vacation`}
    >
      <View style={styles.info}>
        <Text style={styles.name}>{vacation.name}</Text>
        {dates && <Text style={styles.dates}>{dates}</Text>}
      </View>
      <View style={[styles.statusPill, vacation.status === 'active' && styles.statusPillActive]}>
        <Text style={[styles.statusText, vacation.status === 'active' && styles.statusTextActive]}>{statusLabel}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, paddingTop: 56, paddingBottom: Spacing.md,
  },
  headerTitle: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary },
  list: { padding: Spacing.lg, gap: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.lg, ...Shadow.sm,
  },
  rowPressed: { backgroundColor: Colors.surfaceMuted },
  info: { flex: 1, marginRight: Spacing.sm },
  name: { fontSize: 15, fontWeight: '600', color: Colors.textPrimary },
  dates: { fontSize: 12, color: Colors.textTertiary, marginTop: 2 },
  statusPill: { backgroundColor: Colors.surfaceMuted, borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  statusPillActive: { backgroundColor: Colors.successLight },
  statusText: { fontSize: 11, fontWeight: '600', color: Colors.textSecondary },
  statusTextActive: { color: Colors.success },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.xxxl },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  emptySubtitle: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
});
