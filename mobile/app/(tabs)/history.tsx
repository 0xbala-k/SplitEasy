import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { showDialog } from '@/lib/dialog';
import { getHistoryTransactions, getSplitDecision, getTransactionsByIds } from '@/lib/db';
import { HistoryItem, SplitDecision, Transaction } from '@/lib/types';
import { useTransactionStore } from '@/stores/transactionStore';
import { FriendPickerSheet } from '@/components/FriendPickerSheet';
import { HistoryActionSheet } from '@/components/HistoryActionSheet';
import { useToast } from '@/components/ToastProvider';
import { Colors, Radius, Shadow, Spacing, merchantColor } from '@/lib/theme';

// Adapt a single-split HistoryItem back to a Transaction for the picker's
// single-edit / split-from-skipped flows. Carries the real currency so re-saving
// preserves the Splitwise currency_code. pending/created_at don't affect the
// expense, so safe defaults are fine.
function asTransaction(item: HistoryItem): Transaction {
  return {
    id: item.id,
    merchant_name: item.merchant_name,
    amount: item.amount,
    currency: item.currency,
    date: item.date,
    status: item.status,
    pending: false,
    created_at: item.date,
  };
}

export default function HistoryScreen() {
  const [rows, setRows] = useState<HistoryItem[]>([]);
  const [selected, setSelected] = useState<HistoryItem | null>(null);
  const [editDecision, setEditDecision] = useState<SplitDecision | null>(null);
  const [combineTxs, setCombineTxs] = useState<Transaction[] | null>(null);
  const [pickerMode, setPickerMode] = useState<'create' | 'edit'>('create');
  const [pending, setPending] = useState<null | 'picker' | 'action'>(null);
  const [pickerToken, setPickerToken] = useState(0);
  const pickerRef = useRef<BottomSheetModal>(null);
  const actionRef = useRef<BottomSheetModal>(null);
  const deleteSplit = useTransactionStore((s) => s.deleteSplit);
  const deleteCombinedSplit = useTransactionStore((s) => s.deleteCombinedSplit);
  const toast = useToast();

  const refreshHistory = useCallback(() => {
    getHistoryTransactions().then(setRows).catch(console.error);
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshHistory();
    }, [refreshHistory])
  );

  // Present sheets from an effect (after the modal has mounted), not synchronously
  // in the tap handler — on the first tap the modal ref is still null otherwise.
  useEffect(() => {
    if (pending === 'picker') {
      pickerRef.current?.present();
      setPending(null);
    } else if (pending === 'action') {
      actionRef.current?.present();
      setPending(null);
    }
  }, [pending]);

  function handleRowPress(item: HistoryItem) {
    if (item.status === 'skipped') {
      // Split a previously-skipped transaction (create mode).
      setEditDecision(null);
      setCombineTxs(null);
      setPickerMode('create');
      setSelected(item);
      setPickerToken((t) => t + 1);
      setPending('picker');
    } else {
      // Split row (single or combined): offer edit/delete.
      setSelected(item);
      setPending('action');
    }
  }

  async function handleEdit() {
    if (!selected) return;
    if (selected.combined) {
      // Combined split: load all member transactions + the shared decision
      // (any member's row carries the shared expense id, friends, description).
      const [members, decision] = await Promise.all([
        getTransactionsByIds(selected.combined.transaction_ids),
        getSplitDecision(selected.combined.transaction_ids[0]),
      ]);
      if (!decision || members.length === 0) {
        toast.show('Could not load this split. Please try again.', 'error');
        return;
      }
      actionRef.current?.dismiss();
      setCombineTxs(members);
      setEditDecision(decision);
      setPickerMode('edit');
      setPickerToken((t) => t + 1);
      setPending('picker');
      return;
    }
    const decision = await getSplitDecision(selected.id);
    if (!decision) {
      toast.show('Could not load this split. Please try again.', 'error');
      return;
    }
    actionRef.current?.dismiss();
    setCombineTxs(null);
    setEditDecision(decision);
    setPickerMode('edit');
    setPickerToken((t) => t + 1);
    setPending('picker');
  }

  function handleDelete() {
    if (!selected) return;
    const item = selected;
    actionRef.current?.dismiss();
    const label = item.combined ? `${item.combined.count} transactions` : item.merchant_name;
    showDialog(
      'Delete split?',
      `This removes the Splitwise expense for ${label} and moves ${item.combined ? 'them' : 'it'} back to your transactions.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              if (item.combined) {
                await deleteCombinedSplit(item.combined.transaction_ids, item.combined.expense_id);
              } else {
                const decision = await getSplitDecision(item.id);
                if (!decision) {
                  toast.show('Could not load this split. Please try again.', 'error');
                  return;
                }
                await deleteSplit(item.id, decision.splitwise_expense_id);
              }
              toast.show('Split deleted', 'success');
              refreshHistory();
            } catch {
              toast.show('Failed to delete. Please try again.', 'error');
            }
          },
        },
      ]
    );
  }

  function handlePickerSuccess(_amountEach: number) {
    pickerRef.current?.dismiss();
    toast.show(pickerMode === 'edit' ? 'Split updated' : 'Split added', 'success');
    refreshHistory();
  }

  return (
    <View style={[styles.root, { paddingTop: Constants.statusBarHeight }]}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>History</Text>
        {rows.length > 0 && (
          <Text style={styles.headerSub}>{rows.length} transaction{rows.length !== 1 ? 's' : ''}</Text>
        )}
      </View>

      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => <HistoryRow item={item} onPress={() => handleRowPress(item)} />}
        />
      )}

      <FriendPickerSheet
        ref={pickerRef}
        transaction={combineTxs ? null : selected ? asTransaction(selected) : null}
        combineTransactions={combineTxs ?? undefined}
        mode={pickerMode}
        editDecision={editDecision}
        openToken={pickerToken}
        onSuccess={handlePickerSuccess}
      />
      <HistoryActionSheet
        ref={actionRef}
        transaction={selected}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
    </View>
  );
}

function EmptyState() {
  return (
    <View style={styles.emptyContainer}>
      <View style={styles.emptyIcon}>
        <Ionicons name="time-outline" size={40} color={Colors.textTertiary} />
      </View>
      <Text style={styles.emptyTitle}>No history yet</Text>
      <Text style={styles.emptySubtitle}>
        Split or skip transactions to see them here.
      </Text>
    </View>
  );
}

function HistoryRow({ item, onPress }: { item: HistoryItem; onPress: () => void }) {
  const date = new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const isSplit = item.status === 'split' && item.split;
  const initial = (item.merchant_name ?? '?')[0].toUpperCase();
  const avatarColor = merchantColor(item.merchant_name ?? '?');

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        item.status === 'skipped'
          ? `Split ${item.merchant_name}`
          : `Edit or delete split for ${item.merchant_name}`
      }
    >
      <View style={[styles.avatar, { backgroundColor: avatarColor + '20' }]}>
        <Text style={[styles.avatarText, { color: avatarColor }]}>{initial}</Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.merchant} numberOfLines={1}>{item.merchant_name}</Text>
        <Text style={styles.date}>
          {date}
          {item.combined ? ` · ${item.combined.count} transactions` : ''}
        </Text>
        {isSplit ? (
          <View style={styles.splitBadge}>
            <Ionicons name="people-outline" size={11} color={Colors.success} style={{ marginRight: 3 }} />
            <Text style={styles.splitText}>
              {item.split!.friend_names.join(', ')} · ${item.split!.amount_each.toFixed(2)} each
            </Text>
          </View>
        ) : (
          <View style={styles.skippedBadge}>
            <Text style={styles.skippedText}>Skipped · tap to split</Text>
          </View>
        )}
      </View>
      <Text style={styles.amount}>${item.amount.toFixed(2)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },

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
  headerSub: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 2,
    fontWeight: '500',
  },

  list: { padding: Spacing.lg, paddingTop: Spacing.sm, gap: 8 },

  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xxxl,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: Radius.xxl,
    backgroundColor: Colors.surfaceMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.xl,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginBottom: Spacing.sm,
  },
  emptySubtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 21,
  },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    ...Shadow.sm,
  },
  cardPressed: { backgroundColor: Colors.surfaceMuted },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  avatarText: {
    fontSize: 17,
    fontWeight: '700',
  },
  info: { flex: 1, marginRight: Spacing.sm },
  merchant: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.textPrimary,
    marginBottom: 2,
  },
  date: {
    fontSize: 12,
    color: Colors.textTertiary,
    marginBottom: 6,
  },
  splitBadge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  splitText: {
    fontSize: 12,
    color: Colors.success,
    fontWeight: '500',
    flex: 1,
  },
  skippedBadge: {},
  skippedText: {
    fontSize: 12,
    color: Colors.textTertiary,
    fontWeight: '500',
  },
  amount: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
});
