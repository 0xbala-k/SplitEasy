// mobile/app/vacation/[id].tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { showDialog } from '@/lib/dialog';
import {
  getVacationPendingTransactions, getVacationHistory, removeTransactionFromVacation,
  updateTransactionStatus,
} from '@/lib/db';
import { VacationConflictError } from '@/lib/vacationErrors';
import { useVacationStore } from '@/stores/vacationStore';
import { TransactionRow } from '@/components/TransactionRow';
import { FriendPickerSheet } from '@/components/FriendPickerSheet';
import { AddToVacationSheet } from '@/components/AddToVacationSheet';
import { useToast } from '@/components/ToastProvider';
import { EditDatesSheet } from '@/components/EditDatesSheet';
import { HistoryItem, Transaction } from '@/lib/types';
import { formatDayLabel, formatDayLabelWithYear } from '@/lib/date';
import { Colors, Radius, Shadow, Spacing, merchantColor } from '@/lib/theme';

const SELECT_BAR_CONTENT_HEIGHT = 88;

export default function VacationDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const vacations = useVacationStore((s) => s.vacations);
  const loadVacations = useVacationStore((s) => s.load);
  const startVacation = useVacationStore((s) => s.startVacation);
  const endVacation = useVacationStore((s) => s.endVacation);
  const deleteVacation = useVacationStore((s) => s.deleteVacation);
  const updateDates = useVacationStore((s) => s.updateDates);
  const activeVacation = useVacationStore((s) => s.activeVacation);

  const vacation = vacations.find((v) => v.id === id) ?? null;

  const [pending, setPending] = useState<Transaction[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [combineTxs, setCombineTxs] = useState<Transaction[] | null>(null);
  const [pickerToken, setPickerToken] = useState(0);
  const [addToken, setAddToken] = useState(0);
  const [datesToken, setDatesToken] = useState(0);
  const [pendingPresent, setPendingPresent] = useState<null | 'picker' | 'add' | 'dates'>(null);
  const pickerRef = useRef<BottomSheetModal>(null);
  const addRef = useRef<BottomSheetModal>(null);
  const datesRef = useRef<BottomSheetModal>(null);

  const refresh = useCallback(() => {
    if (!id) return;
    getVacationPendingTransactions(id).then(setPending).catch(console.error);
    getVacationHistory(id).then(setHistory).catch(console.error);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      loadVacations();
      refresh();
    }, [loadVacations, refresh])
  );

  // Present sheets from an effect (after the modal has mounted), not synchronously
  // in the tap handler — on the first tap the modal ref is still null otherwise.
  useEffect(() => {
    if (pendingPresent === 'picker') {
      pickerRef.current?.present();
      setPendingPresent(null);
    } else if (pendingPresent === 'add') {
      addRef.current?.present();
      setPendingPresent(null);
    } else if (pendingPresent === 'dates') {
      datesRef.current?.present();
      setPendingPresent(null);
    }
  }, [pendingPresent]);

  if (!vacation) {
    return (
      <View style={styles.root}>
        <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />
        <Text style={styles.notFound}>Vacation not found.</Text>
      </View>
    );
  }

  function toggleSelect(txId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(txId) ? next.delete(txId) : next.add(txId);
      return next;
    });
  }

  function openCombine(members: Transaction[]) {
    if (members.length === 0) return;
    if (new Set(members.map((t) => t.currency)).size > 1) {
      toast.show('This vacation has transactions in more than one currency — select transactions in the same currency to combine.', 'error');
      return;
    }
    setCombineTxs(members);
    setPickerToken((t) => t + 1);
    setPendingPresent('picker');
  }

  function openSelectSplit() {
    openCombine(pending.filter((t) => selectedIds.has(t.id)));
  }

  function splitAllTogether() {
    openCombine(pending);
  }

  async function handleRemove(txId: string) {
    try {
      await removeTransactionFromVacation(txId);
      refresh();
    } catch {
      toast.show('Could not remove transaction. Please try again.', 'error');
    }
  }

  async function handleSkip(txId: string) {
    try {
      // status only — vacation_id survives, so this stays trip spend and
      // materializes into the Travel bucket at its full amount.
      await updateTransactionStatus(txId, 'skipped');
      refresh();
    } catch {
      toast.show('Could not skip transaction. Please try again.', 'error');
    }
  }

  function handleSplitSuccess() {
    pickerRef.current?.dismiss();
    setSelectMode(false);
    setSelectedIds(new Set());
    toast.show('Split added', 'success');
    refresh();
  }

  // Arrow function expressions (not function declarations) so TS's control-flow
  // narrowing of `vacation` from the guard above carries into the closure —
  // function declarations are hoisted and lose that narrowing.
  const handleStart = async () => {
    try {
      await startVacation(vacation.id);
    } catch (err) {
      toast.show(
        err instanceof VacationConflictError
          ? 'Another vacation is already active. End it first.'
          : 'Could not start vacation. Please try again.',
        'error'
      );
    }
  };

  const handleEnd = async () => {
    try {
      await endVacation(vacation.id);
    } catch {
      toast.show('Could not end vacation. Please try again.', 'error');
    }
  };

  const handleDelete = () => {
    showDialog(
      'Delete vacation?',
      pending.length > 0
        ? `${pending.length} pending transaction${pending.length === 1 ? '' : 's'} will move back to your main Transactions list.`
        : 'This vacation will be removed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteVacation(vacation.id);
              router.back();
            } catch {
              toast.show('Could not delete vacation. Please try again.', 'error');
            }
          },
        },
      ]
    );
  };

  const handleSaveDates = async (start: string | null, end: string | null) => {
    try {
      await updateDates(vacation.id, start, end);
      datesRef.current?.dismiss();
      toast.show(start && end ? 'Dates updated' : 'Dates removed', 'success');
    } catch (err) {
      toast.show(
        err instanceof VacationConflictError
          ? 'Those dates overlap another vacation.'
          : 'Could not update dates. Please try again.',
        'error'
      );
    }
  };

  const canStart = vacation.status === 'draft' && !activeVacation;
  const canEnd = vacation.status === 'active';
  // An ended trip's dates are history — editing them would only invite a
  // reconcile that can no longer act on them.
  const canEditDates = vacation.status !== 'ended';
  const statusLabel = vacation.status === 'active' ? 'Active' : vacation.status === 'draft' ? 'Draft' : 'Ended';
  const mixedCurrency = new Set(pending.map((t) => t.currency)).size > 1;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />
      <View style={[styles.header, { paddingTop: insets.top + Spacing.sm }]}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={24} color={Colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{vacation.name}</Text>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => router.push('/vacation')}
            accessibilityRole="button"
            accessibilityLabel="View all vacations"
          >
            <Ionicons name="list-outline" size={20} color={Colors.textPrimary} />
          </Pressable>
          <Pressable onPress={handleDelete} accessibilityRole="button" accessibilityLabel="Delete vacation">
            <Ionicons name="trash-outline" size={20} color={Colors.error} />
          </Pressable>
        </View>
      </View>

      <View style={styles.metaRow}>
        <View style={[styles.statusPill, vacation.status === 'active' && styles.statusPillActive]}>
          <Text style={[styles.statusText, vacation.status === 'active' && styles.statusTextActive]}>{statusLabel}</Text>
        </View>
        {canEditDates ? (
          <Pressable
            style={styles.datesBtn}
            onPress={() => { setDatesToken((t) => t + 1); setPendingPresent('dates'); }}
            accessibilityRole="button"
            accessibilityLabel={vacation.start_date ? 'Edit dates' : 'Add dates'}
          >
            <Ionicons name="calendar-outline" size={12} color={Colors.textSecondary} />
            <Text style={styles.dates} numberOfLines={1}>
              {vacation.start_date && vacation.end_date
                ? `${formatDayLabel(vacation.start_date)} – ${formatDayLabelWithYear(vacation.end_date)}`
                : 'Add dates'}
            </Text>
          </Pressable>
        ) : (
          vacation.start_date && vacation.end_date && (
            <Text style={styles.dates} numberOfLines={1}>
              {formatDayLabel(vacation.start_date)} – {formatDayLabelWithYear(vacation.end_date)}
            </Text>
          )
        )}
        {vacation.splitwise_group_name && (
          <View style={styles.groupChip}>
            <Ionicons name="people-outline" size={12} color={Colors.primary} />
            <Text style={styles.groupChipText} numberOfLines={1}>{vacation.splitwise_group_name}</Text>
          </View>
        )}
      </View>

      <View style={styles.lifecycleRow}>
        {canStart && (
          <Pressable style={styles.lifecycleBtn} onPress={handleStart} accessibilityRole="button" accessibilityLabel="Start now">
            <Text style={styles.lifecycleBtnText}>Start now</Text>
          </Pressable>
        )}
        {canEnd && (
          <Pressable style={styles.lifecycleBtn} onPress={handleEnd} accessibilityRole="button" accessibilityLabel="End now">
            <Text style={styles.lifecycleBtnText}>End now</Text>
          </Pressable>
        )}
        <Pressable
          style={styles.lifecycleBtnSecondary}
          onPress={() => { setAddToken((t) => t + 1); setPendingPresent('add'); }}
          accessibilityRole="button"
          accessibilityLabel="Add transactions"
        >
          <Text style={styles.lifecycleBtnSecondaryText}>Add transactions</Text>
        </Pressable>
      </View>

      <FlatList
        data={pending}
        keyExtractor={(t) => t.id}
        contentContainerStyle={[styles.list, selectMode && { paddingBottom: SELECT_BAR_CONTENT_HEIGHT + insets.bottom }]}
        ListHeaderComponent={
          pending.length > 0 ? (
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionHeader}>To split ({pending.length})</Text>
              <Pressable
                onPress={splitAllTogether}
                disabled={mixedCurrency}
                accessibilityRole="button"
                accessibilityLabel="Split all together"
              >
                <Text style={[styles.splitAllText, mixedCurrency && styles.splitAllTextDisabled]}>Split all together</Text>
              </Pressable>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <TransactionRow
            transaction={item}
            onSkip={() => handleSkip(item.id)}
            onRemove={() => handleRemove(item.id)}
            onSplit={() => openCombine([item])}
            onLongPress={() => { setSelectMode(true); setSelectedIds(new Set([item.id])); }}
            selectMode={selectMode}
            selected={selectedIds.has(item.id)}
            onToggleSelect={() => toggleSelect(item.id)}
          />
        )}
        ListFooterComponent={
          history.length > 0 ? (
            <View style={styles.historySection}>
              <Text style={styles.sectionHeader}>Already split</Text>
              {history.map((h) => (
                <HistoryRecapRow key={h.id} item={h} />
              ))}
            </View>
          ) : null
        }
      />

      {selectMode && (
        <View style={[styles.selectBar, { paddingBottom: Spacing.lg + insets.bottom }]}>
          <Pressable
            style={styles.selectCancel}
            onPress={() => { setSelectMode(false); setSelectedIds(new Set()); }}
            accessibilityRole="button"
            accessibilityLabel="Cancel selection"
          >
            <Text style={styles.selectCancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.selectSplit, selectedIds.size === 0 && styles.selectSplitDisabled]}
            onPress={openSelectSplit}
            disabled={selectedIds.size === 0}
            accessibilityRole="button"
            accessibilityLabel="Split selected together"
          >
            <Text style={styles.selectSplitText}>Split together ({selectedIds.size})</Text>
          </Pressable>
        </View>
      )}

      <FriendPickerSheet
        ref={pickerRef}
        transaction={combineTxs && combineTxs.length === 1 ? combineTxs[0] : null}
        combineTransactions={combineTxs && combineTxs.length > 1 ? combineTxs : undefined}
        openToken={pickerToken}
        groupId={vacation.splitwise_group_id ?? undefined}
        groupMemberIds={vacation.splitwise_group_member_ids ?? undefined}
        onSuccess={handleSplitSuccess}
      />
      <AddToVacationSheet
        ref={addRef}
        vacationId={vacation.id}
        openToken={addToken}
        onDone={() => { addRef.current?.dismiss(); refresh(); }}
      />
      <EditDatesSheet
        ref={datesRef}
        startDate={vacation.start_date}
        endDate={vacation.end_date}
        openToken={datesToken}
        onSave={handleSaveDates}
      />
    </View>
  );
}

function HistoryRecapRow({ item }: { item: HistoryItem }) {
  const color = merchantColor(item.merchant_name);
  return (
    <View style={styles.recapRow}>
      <View style={[styles.recapAvatar, { backgroundColor: color + '18' }]}>
        <Text style={[styles.recapAvatarText, { color }]}>{item.merchant_name[0].toUpperCase()}</Text>
      </View>
      <View style={styles.recapInfo}>
        <Text style={styles.recapName} numberOfLines={1}>{item.merchant_name}</Text>
        {item.source === 'splitwise' ? (
          <Text style={styles.recapSplit} numberOfLines={1}>
            {item.payer_name} paid · your share ${(item.split?.amount_each ?? 0).toFixed(2)}
          </Text>
        ) : item.split && (
          <Text style={styles.recapSplit} numberOfLines={1}>
            {item.split.friend_names.join(', ')} · ${item.split.amount_each.toFixed(2)} each
          </Text>
        )}
      </View>
      <Text style={styles.recapAmount}>${item.amount.toFixed(2)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  notFound: { marginTop: 100, textAlign: 'center', color: Colors.textSecondary },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm,
  },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: Colors.textPrimary, marginHorizontal: Spacing.md, textAlign: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingHorizontal: Spacing.lg, marginBottom: Spacing.md },
  statusPill: { backgroundColor: Colors.surfaceMuted, borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  statusPillActive: { backgroundColor: Colors.successLight },
  statusText: { fontSize: 11, fontWeight: '600', color: Colors.textSecondary },
  statusTextActive: { color: Colors.success },
  // flexShrink lets a long date range give way to the group chip beside it
  // rather than pushing it off the row.
  datesBtn: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, flexShrink: 1, minWidth: 0 },
  dates: { flexShrink: 1, minWidth: 0, fontSize: 12, color: Colors.textTertiary },
  // The chip must be allowed to shrink, or a long group name grows it past the
  // screen edge; numberOfLines can only ellipsize once the width is bounded.
  groupChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.primaryMuted, borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4, flexShrink: 1, maxWidth: '100%' },
  groupChipText: { fontSize: 11, fontWeight: '600', color: Colors.primary, flexShrink: 1, minWidth: 0 },
  lifecycleRow: { flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.lg, marginBottom: Spacing.md },
  lifecycleBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 10, paddingHorizontal: Spacing.lg },
  lifecycleBtnText: { color: Colors.textInverse, fontSize: 13, fontWeight: '700' },
  lifecycleBtnSecondary: { backgroundColor: Colors.surfaceMuted, borderRadius: Radius.md, paddingVertical: 10, paddingHorizontal: Spacing.lg },
  lifecycleBtnSecondaryText: { color: Colors.textPrimary, fontSize: 13, fontWeight: '700' },
  list: { padding: Spacing.lg, gap: 8 },
  sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.sm },
  sectionHeader: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  splitAllText: { fontSize: 13, fontWeight: '600', color: Colors.primary },
  splitAllTextDisabled: { color: Colors.textTertiary },
  historySection: { marginTop: Spacing.xl },
  recapRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: Radius.lg,
    padding: Spacing.md, marginBottom: 8, ...Shadow.sm,
  },
  recapAvatar: { width: 36, height: 36, borderRadius: Radius.sm, justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md },
  recapAvatarText: { fontSize: 14, fontWeight: '700' },
  recapInfo: { flex: 1 },
  recapName: { fontSize: 14, fontWeight: '600', color: Colors.textPrimary },
  recapSplit: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  recapAmount: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  selectBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', gap: Spacing.md,
    padding: Spacing.lg, backgroundColor: Colors.surface, borderTopWidth: 1, borderTopColor: Colors.border,
  },
  selectCancel: { paddingVertical: 16, paddingHorizontal: Spacing.xl, borderRadius: Radius.lg, backgroundColor: Colors.surfaceMuted, justifyContent: 'center', alignItems: 'center' },
  selectCancelText: { fontSize: 15, fontWeight: '600', color: Colors.textSecondary },
  selectSplit: { flex: 1, borderRadius: Radius.lg, backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center', ...Shadow.sm },
  selectSplitDisabled: { backgroundColor: Colors.surfaceMuted },
  selectSplitText: { fontSize: 15, fontWeight: '700', color: Colors.textInverse },
});
