import { useCallback, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { getHistoryTransactions, getSplitDecision } from '@/lib/db';
import { TransactionWithSplit, SplitDecision, Transaction } from '@/lib/types';
import { useTransactionStore } from '@/stores/transactionStore';
import { FriendPickerSheet } from '@/components/FriendPickerSheet';
import { HistoryActionSheet } from '@/components/HistoryActionSheet';
import { useToast } from '@/components/ToastProvider';
import { Colors, Radius, Shadow, Spacing, merchantColor } from '@/lib/theme';

export default function HistoryScreen() {
  const [rows, setRows] = useState<TransactionWithSplit[]>([]);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [editDecision, setEditDecision] = useState<SplitDecision | null>(null);
  const [pickerMode, setPickerMode] = useState<'create' | 'edit'>('create');
  const pickerRef = useRef<BottomSheetModal>(null);
  const actionRef = useRef<BottomSheetModal>(null);
  const deleteSplit = useTransactionStore((s) => s.deleteSplit);
  const toast = useToast();

  const refreshHistory = useCallback(() => {
    getHistoryTransactions().then(setRows);
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshHistory();
    }, [refreshHistory])
  );

  async function handleRowPress(item: TransactionWithSplit) {
    if (item.status === 'skipped') {
      // Split a previously-skipped transaction (create mode).
      setEditDecision(null);
      setPickerMode('create');
      setSelected(item);
      pickerRef.current?.present();
    } else {
      // Split row: offer edit/delete.
      setSelected(item);
      actionRef.current?.present();
    }
  }

  async function handleEdit() {
    if (!selected) return;
    const decision = await getSplitDecision(selected.id);
    if (!decision) {
      toast.show('Could not load this split. Please try again.', 'error');
      return;
    }
    actionRef.current?.dismiss();
    setEditDecision(decision);
    setPickerMode('edit');
    pickerRef.current?.present();
  }

  function handleDelete() {
    if (!selected) return;
    const tx = selected;
    actionRef.current?.dismiss();
    Alert.alert(
      'Delete split?',
      `This removes the Splitwise expense for ${tx.merchant_name} and moves it back to your transactions.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const decision = await getSplitDecision(tx.id);
            if (!decision) {
              toast.show('Could not load this split. Please try again.', 'error');
              return;
            }
            try {
              await deleteSplit(tx.id, decision.splitwise_expense_id);
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

  function handlePickerSuccess(amountEach: number) {
    pickerRef.current?.dismiss();
    toast.show(
      pickerMode === 'edit' ? 'Split updated' : `Added! Others owe you $${amountEach.toFixed(2)}`,
      'success'
    );
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
        transaction={selected}
        mode={pickerMode}
        editDecision={editDecision}
        onSuccess={handlePickerSuccess}
      />
      <HistoryActionSheet
        ref={actionRef}
        transaction={selected as TransactionWithSplit | null}
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

function HistoryRow({ item, onPress }: { item: TransactionWithSplit; onPress: () => void }) {
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
        <Text style={styles.date}>{date}</Text>
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
