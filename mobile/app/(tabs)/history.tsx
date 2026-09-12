import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  getHistoryTransactions,
  getExcludedTransactions,
  removeTransactionFromVacation,
} from '@/lib/db';
import { HistoryItem } from '@/lib/types';
import { formatDayLabel } from '@/lib/date';
import { useTransactionStore } from '@/stores/transactionStore';
import { FriendPickerSheet } from '@/components/FriendPickerSheet';
import { HistoryActionSheet } from '@/components/HistoryActionSheet';
import { BucketChip } from '@/components/BucketChip';
import { BucketPickerSheet } from '@/components/BucketPickerSheet';
import { useBucketEditor } from '@/hooks/useBucketEditor';
import { useSplitEditor } from '@/hooks/useSplitEditor';
import { Colors, Radius, Shadow, Spacing, merchantColor } from '@/lib/theme';

// A row imported from Splitwise: someone else paid, so it is read-only here.
function isImported(item: HistoryItem): boolean {
  return item.source === 'splitwise';
}

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<HistoryItem[]>([]);
  const [filter, setFilter] = useState<'all' | 'excluded'>('all');
  const setBucket = useTransactionStore((s) => s.setBucket);

  const refreshHistory = useCallback(() => {
    const load = filter === 'excluded' ? getExcludedTransactions() : getHistoryTransactions();
    load.then(setRows).catch(console.error);
  }, [filter]);

  // History keeps its own list state (unlike Transactions/Spending, which
  // read straight from a store), so the editor needs to be told how to
  // refresh it after a write.
  const bucketEditor = useBucketEditor(setBucket, refreshHistory);

  const splitEditor = useSplitEditor({
    onChange: refreshHistory,
    // The Excluded filter shows skipped rows too, and while it is on the only
    // sensible action is Restore — so it wins over the imported/default rule.
    resolveMode: useCallback(
      (item: HistoryItem) =>
        filter === 'excluded'
          ? 'excluded'
          : item.source === 'splitwise'
          ? 'readOnly'
          : 'default',
      [filter]
    ),
  });

  // A combined row is one Splitwise expense over several transactions, so
  // re-tagging it has to move every member.
  function openBucketSheet(item: HistoryItem) {
    if (!item.bucket) return;
    bucketEditor.open({
      ids: item.combined?.transaction_ids ?? [item.id],
      merchantName: item.merchant_name,
      bucket: item.bucket,
      locked: !!item.vacation_id,
      onRemoveFromVacation: item.vacation_id
        ? () => removeTransactionFromVacation(item.id)   // combined + vacation-locked shouldn't co-occur; single id is correct here
        : undefined,
    });
  }

  useFocusEffect(
    useCallback(() => {
      refreshHistory();
    }, [refreshHistory])
  );

  // useFocusEffect only re-fires on focus, not merely because refreshHistory's
  // identity changed — so switching filters while already focused needs its
  // own reload trigger.
  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>History</Text>
        {rows.length > 0 && (
          <Text style={styles.headerSub}>{rows.length} transaction{rows.length !== 1 ? 's' : ''}</Text>
        )}
      </View>

      <View style={styles.filterRow}>
        <Pressable
          style={[styles.filterChip, filter === 'all' && styles.filterChipActive]}
          onPress={() => setFilter('all')}
          accessibilityRole="button"
          accessibilityState={{ selected: filter === 'all' }}
        >
          <Text style={[styles.filterChipText, filter === 'all' && styles.filterChipTextActive]}>All</Text>
        </Pressable>
        <Pressable
          style={[styles.filterChip, filter === 'excluded' && styles.filterChipActive]}
          onPress={() => setFilter('excluded')}
          accessibilityRole="button"
          accessibilityState={{ selected: filter === 'excluded' }}
        >
          <Text style={[styles.filterChipText, filter === 'excluded' && styles.filterChipTextActive]}>Excluded</Text>
        </Pressable>
      </View>

      {rows.length === 0 ? (
        <EmptyState excluded={filter === 'excluded'} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <HistoryRow item={item} onPress={() => splitEditor.openFor(item)} onBucketPress={() => openBucketSheet(item)} />
          )}
        />
      )}

      <FriendPickerSheet ref={splitEditor.pickerRef} {...splitEditor.pickerProps} />
      <HistoryActionSheet ref={splitEditor.actionRef} {...splitEditor.actionProps} />
      <BucketPickerSheet ref={bucketEditor.sheetRef} {...bucketEditor.sheetProps} />
    </View>
  );
}

function EmptyState({ excluded }: { excluded: boolean }) {
  if (excluded) {
    return (
      <View style={styles.emptyContainer}>
        <View style={styles.emptyIcon}>
          <Ionicons name="archive-outline" size={40} color={Colors.textTertiary} />
        </View>
        <Text style={styles.emptyTitle}>No excluded transactions.</Text>
      </View>
    );
  }
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

function HistoryRow({
  item, onPress, onBucketPress,
}: {
  item: HistoryItem;
  onPress: () => void;
  onBucketPress: () => void;
}) {
  const date = formatDayLabel(item.date);
  const isSplit = item.status === 'split' && item.split;
  const initial = (item.merchant_name ?? '?')[0].toUpperCase();
  const avatarColor = merchantColor(item.merchant_name ?? '?');

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        isImported(item)
          ? `Options for ${item.merchant_name}`
          : item.status === 'skipped'
            ? `Split ${item.merchant_name}`
            : `Edit or delete split for ${item.merchant_name}`
      }
    >
      <View style={[styles.avatar, { backgroundColor: avatarColor + '20' }]}>
        <Text style={[styles.avatarText, { color: avatarColor }]}>{initial}</Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.merchant} numberOfLines={1}>{item.merchant_name}</Text>
        <View style={styles.metaRow}>
          <Text style={styles.date} numberOfLines={1}>
            {date}
            {item.combined ? ` · ${item.combined.count} transactions` : ''}
          </Text>
          {item.bucket && (
            <BucketChip
              bucket={item.bucket}
              locked={!!item.vacation_id}
              onPress={onBucketPress}
            />
          )}
        </View>
        {isImported(item) ? (
          <View style={styles.splitBadge}>
            <Ionicons name="people-outline" size={11} color={Colors.success} style={{ marginRight: 3 }} />
            <Text style={styles.splitText} numberOfLines={1}>
              {item.payer_name} paid · your share ${(item.split?.amount_each ?? 0).toFixed(2)}
            </Text>
          </View>
        ) : isSplit ? (
          <View style={styles.splitBadge}>
            <Ionicons name="people-outline" size={11} color={Colors.success} style={{ marginRight: 3 }} />
            <Text style={styles.splitText} numberOfLines={1}>
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

  filterRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.xl,
    marginBottom: Spacing.sm,
  },
  filterChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: Radius.xxl,
    backgroundColor: Colors.surfaceMuted,
  },
  filterChipActive: {
    backgroundColor: Colors.textPrimary,
  },
  filterChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  filterChipTextActive: {
    color: Colors.surface,
  },

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
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  // flexShrink + minWidth: 0 lets the date truncate instead of pushing the
  // (flexShrink: 0) bucket chip off the row on web, where a flex item's
  // default min-width is its content size, not 0.
  date: {
    fontSize: 12,
    color: Colors.textTertiary,
    flexShrink: 1,
    minWidth: 0,
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
