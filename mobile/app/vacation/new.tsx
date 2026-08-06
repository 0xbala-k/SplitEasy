// mobile/app/vacation/new.tsx
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [groups, setGroups] = useState<SplitwiseGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<SplitwiseGroup | null>(null);
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);
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
      <View style={[styles.header, { paddingTop: insets.top + Spacing.sm }]}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={24} color={Colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>New vacation</Text>
        <View style={{ width: 24 }} />
      </View>

      <KeyboardAvoidingView
        style={styles.keyboardAvoider}
        behavior={Platform.select({ ios: 'padding', android: undefined })}
      >
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
              <Pressable
                style={styles.groupTrigger}
                onPress={() => setGroupPickerOpen((open) => !open)}
                accessibilityRole="button"
                accessibilityLabel="Select Splitwise group"
                accessibilityState={{ expanded: groupPickerOpen }}
              >
                <Text
                  style={selectedGroup ? styles.groupTriggerText : styles.groupTriggerPlaceholder}
                  numberOfLines={1}
                >
                  {selectedGroup ? selectedGroup.name : 'None'}
                </Text>
                <Ionicons
                  name={groupPickerOpen ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color={Colors.textSecondary}
                />
              </Pressable>

              {groupPickerOpen && (
                <View style={styles.groupPanel}>
                  <ScrollView nestedScrollEnabled style={styles.groupPanelScroll}>
                    <Pressable
                      style={[styles.groupRow, !selectedGroup && styles.groupRowSelected]}
                      onPress={() => {
                        setSelectedGroup(null);
                        setGroupPickerOpen(false);
                      }}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: !selectedGroup }}
                      accessibilityLabel="None"
                    >
                      <Text style={styles.groupName} numberOfLines={1}>None</Text>
                      {!selectedGroup && <Ionicons name="checkmark-circle" size={18} color={Colors.primary} />}
                    </Pressable>
                    {groups.map((g) => {
                      const isSelected = selectedGroup?.id === g.id;
                      return (
                        <Pressable
                          key={g.id}
                          style={[styles.groupRow, isSelected && styles.groupRowSelected]}
                          onPress={() => {
                            setSelectedGroup(isSelected ? null : g);
                            setGroupPickerOpen(false);
                          }}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: isSelected }}
                          accessibilityLabel={g.name}
                        >
                          <Text style={styles.groupName} numberOfLines={1}>{g.name}</Text>
                          {isSelected && <Ionicons name="checkmark-circle" size={18} color={Colors.primary} />}
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </View>
              )}
            </>
          )}
        </ScrollView>

        <Pressable
          style={({ pressed }) => [
            styles.saveBtn,
            // Clear the home indicator without doubling the margin on devices
            // that don't have one.
            { marginBottom: Math.max(Spacing.xl, insets.bottom) },
            !canSave && styles.saveBtnDisabled,
            pressed && canSave && styles.saveBtnPressed,
          ]}
          onPress={handleSave}
          disabled={!canSave}
          accessibilityRole="button"
          accessibilityLabel="Save vacation"
        >
          {submitting ? <ActivityIndicator color={Colors.textInverse} /> : <Text style={styles.saveText}>Create vacation</Text>}
        </Pressable>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md,
  },
  headerTitle: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary },
  keyboardAvoider: { flex: 1 },
  body: { padding: Spacing.xl },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.sm, marginTop: Spacing.lg },
  hint: { fontSize: 12, color: Colors.textTertiary, marginBottom: Spacing.sm },
  input: {
    backgroundColor: Colors.surface, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md, paddingVertical: 12, fontSize: 15, color: Colors.textPrimary,
  },
  dateRow: { flexDirection: 'row', gap: Spacing.md },
  // minWidth: 0 is required on web: flex items default to min-width:auto there,
  // so a TextInput refuses to shrink below its intrinsic width and overflows the
  // row. React Native has no such rule, so this is a no-op on native.
  dateInput: { flex: 1, minWidth: 0 },
  error: { fontSize: 12, color: Colors.error, marginTop: Spacing.sm },
  groupTrigger: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.surface, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md, paddingVertical: 12,
  },
  groupTriggerText: { flex: 1, fontSize: 15, color: Colors.textPrimary },
  groupTriggerPlaceholder: { flex: 1, fontSize: 15, color: Colors.textTertiary },
  groupPanel: {
    marginTop: Spacing.sm, maxHeight: 240, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.surface, ...Shadow.sm,
  },
  groupPanelScroll: { padding: Spacing.sm },
  groupRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.surface, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md, paddingVertical: 12, marginBottom: Spacing.sm,
  },
  groupRowSelected: { borderColor: Colors.primary, backgroundColor: Colors.primaryMuted },
  groupName: { flex: 1, marginRight: Spacing.sm, fontSize: 15, color: Colors.textPrimary, fontWeight: '500' },
  saveBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg, paddingVertical: 16,
    justifyContent: 'center', alignItems: 'center', marginHorizontal: Spacing.xl, ...Shadow.sm,
  },
  saveBtnDisabled: { backgroundColor: Colors.surfaceMuted },
  saveBtnPressed: { backgroundColor: Colors.primaryDark },
  saveText: { color: Colors.textInverse, fontSize: 16, fontWeight: '700' },
});
