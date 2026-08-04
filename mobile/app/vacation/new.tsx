// mobile/app/vacation/new.tsx
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useVacationStore } from '@/stores/vacationStore';
import { getGroups } from '@/lib/splitwise';
import { VacationConflictError } from '@/lib/vacationErrors';
import { SplitwiseGroup } from '@/lib/types';
import { useToast } from '@/components/ToastProvider';
import { Colors, Radius, Shadow, Spacing } from '@/lib/theme';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function NewVacationScreen() {
  const router = useRouter();
  const toast = useToast();
  const create = useVacationStore((s) => s.create);

  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [groups, setGroups] = useState<SplitwiseGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<SplitwiseGroup | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getGroups().then(setGroups).catch(() => setGroups([]));
  }, []);

  const datesValid =
    (startDate === '' && endDate === '') ||
    (DATE_RE.test(startDate) && DATE_RE.test(endDate) && startDate <= endDate);
  const canSave = name.trim() !== '' && datesValid && !submitting;

  async function handleSave() {
    if (!canSave) return;
    setSubmitting(true);
    try {
      const vacation = await create({
        name: name.trim(),
        start_date: startDate || null,
        end_date: endDate || null,
        splitwise_group_id: selectedGroup?.id ?? null,
        splitwise_group_name: selectedGroup?.name ?? null,
        splitwise_group_member_ids: selectedGroup?.member_ids ?? null,
      });
      router.replace(`/vacation/${vacation.id}`);
    } catch (err) {
      if (err instanceof VacationConflictError) {
        toast.show(err.message, 'error');
      } else {
        toast.show('Could not create vacation. Please try again.', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={24} color={Colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>New vacation</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.label}>Name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="Hawaii trip"
          placeholderTextColor={Colors.textTertiary}
          accessibilityLabel="Vacation name"
        />

        <Text style={styles.label}>Dates (optional)</Text>
        <Text style={styles.hint}>If set, the vacation starts and ends automatically on these dates.</Text>
        <View style={styles.dateRow}>
          <TextInput
            style={[styles.input, styles.dateInput]}
            value={startDate}
            onChangeText={setStartDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={Colors.textTertiary}
            accessibilityLabel="Start date"
          />
          <TextInput
            style={[styles.input, styles.dateInput]}
            value={endDate}
            onChangeText={setEndDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={Colors.textTertiary}
            accessibilityLabel="End date"
          />
        </View>
        {!datesValid && <Text style={styles.error}>Enter both dates as YYYY-MM-DD, end on or after start.</Text>}

        {groups.length > 0 && (
          <>
            <Text style={styles.label}>Splitwise group (optional)</Text>
            {groups.map((g) => {
              const isSelected = selectedGroup?.id === g.id;
              return (
                <Pressable
                  key={g.id}
                  style={[styles.groupRow, isSelected && styles.groupRowSelected]}
                  onPress={() => setSelectedGroup(isSelected ? null : g)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                  accessibilityLabel={g.name}
                >
                  <Text style={styles.groupName}>{g.name}</Text>
                  {isSelected && <Ionicons name="checkmark-circle" size={18} color={Colors.primary} />}
                </Pressable>
              );
            })}
          </>
        )}
      </ScrollView>

      <Pressable
        style={({ pressed }) => [styles.saveBtn, !canSave && styles.saveBtnDisabled, pressed && canSave && styles.saveBtnPressed]}
        onPress={handleSave}
        disabled={!canSave}
        accessibilityRole="button"
        accessibilityLabel="Save vacation"
      >
        {submitting ? <ActivityIndicator color={Colors.textInverse} /> : <Text style={styles.saveText}>Create vacation</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, paddingTop: 56, paddingBottom: Spacing.md,
  },
  headerTitle: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary },
  body: { padding: Spacing.xl },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.sm, marginTop: Spacing.lg },
  hint: { fontSize: 12, color: Colors.textTertiary, marginBottom: Spacing.sm },
  input: {
    backgroundColor: Colors.surface, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md, paddingVertical: 12, fontSize: 15, color: Colors.textPrimary,
  },
  dateRow: { flexDirection: 'row', gap: Spacing.md },
  dateInput: { flex: 1 },
  error: { fontSize: 12, color: Colors.error, marginTop: Spacing.sm },
  groupRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.surface, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md, paddingVertical: 12, marginBottom: Spacing.sm,
  },
  groupRowSelected: { borderColor: Colors.primary, backgroundColor: Colors.primaryMuted },
  groupName: { fontSize: 15, color: Colors.textPrimary, fontWeight: '500' },
  saveBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg, paddingVertical: 16,
    justifyContent: 'center', alignItems: 'center', marginHorizontal: Spacing.xl, marginBottom: Spacing.xl, ...Shadow.sm,
  },
  saveBtnDisabled: { backgroundColor: Colors.surfaceMuted },
  saveBtnPressed: { backgroundColor: Colors.primaryDark },
  saveText: { color: Colors.textInverse, fontSize: 16, fontWeight: '700' },
});
