import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StatusBar, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import NetInfo from '@react-native-community/netinfo';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTransactionStore } from '@/stores/transactionStore';
import { usePlaidStore } from '@/stores/plaidStore';
import { TransactionRow } from '@/components/TransactionRow';
import { ReauthBanner } from '@/components/ReauthBanner';
import { OfflineBanner } from '@/components/OfflineBanner';
import { FriendPickerSheet } from '@/components/FriendPickerSheet';
import { useToast } from '@/components/ToastProvider';
import { Transaction } from '@/lib/types';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { Colors, Spacing, Radius, Shadow } from '@/lib/theme';

export default function NewTransactionsScreen() {
  const router = useRouter();
  const topInset = Constants.statusBarHeight;
  const { transactions, isLoading, load, refresh, skip } = useTransactionStore();
  const needsReauth = usePlaidStore((s) => s.needs_reauth);
  const [isConnected, setIsConnected] = useState(true);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const sheetRef = useRef<BottomSheetModal>(null);
  const toast = useToast();
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [combineTxs, setCombineTxs] = useState<Transaction[] | null>(null);
  const [pickerToken, setPickerToken] = useState(0);

  useEffect(() => {
    load();
    refresh();
    const unsub = NetInfo.addEventListener((state) => setIsConnected(!!state.isConnected));
    return unsub;
  }, []);

  function openSheet(tx: Transaction) {
    setCombineTxs(null);
    setSelected(tx);
    setPickerToken((t) => t + 1);
    sheetRef.current?.present();
  }

  function enterSelect(tx: Transaction) {
    setSelectMode(true);
    setSelectedIds(new Set([tx.id]));
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function cancelSelect() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  function openCombine() {
    const members = transactions.filter((t) => selectedIds.has(t.id));
    if (members.length === 0) return;
    setSelected(null);
    setCombineTxs(members);
    setPickerToken((t) => t + 1);
    sheetRef.current?.present();
  }

  function handleSplitSuccess(amountEach: number) {
    sheetRef.current?.dismiss();
    cancelSelect();
    toast.show(`Added! Others owe you $${amountEach.toFixed(2)}`, 'success');
  }

  function handleReauth() {
    router.push('/(auth)/bank-connect');
  }

  const isEmptyAndLoaded = !isLoading && transactions.length === 0;

  return (
    <View style={[styles.root, { paddingTop: topInset }]}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Transactions</Text>
          {transactions.length > 0 && (
            <Text style={styles.headerSub}>
              {transactions.length} pending split{transactions.length !== 1 ? 's' : ''}
            </Text>
          )}
        </View>
        {transactions.length > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{transactions.length}</Text>
          </View>
        )}
      </View>

      {needsReauth && <ReauthBanner onPress={handleReauth} />}
      {!isConnected && <OfflineBanner />}

      {isLoading && transactions.length === 0 ? (
        <LoadingSkeleton />
      ) : isEmptyAndLoaded ? (
        <EmptyState />
      ) : (
        <FlatList
          data={transactions}
          keyExtractor={(t) => t.id}
          contentContainerStyle={styles.list}
          extraData={{ selectMode, selectedIds }}
          refreshControl={
            <RefreshControl
              refreshing={isLoading}
              onRefresh={refresh}
              tintColor={Colors.primary}
            />
          }
          renderItem={({ item }) => (
            <TransactionRow
              transaction={item}
              onSkip={() => skip(item.id)}
              onSplit={() => openSheet(item)}
              onLongPress={() => enterSelect(item)}
              selectMode={selectMode}
              selected={selectedIds.has(item.id)}
              onToggleSelect={() => toggleSelect(item.id)}
            />
          )}
        />
      )}

      <FriendPickerSheet
        ref={sheetRef}
        transaction={selected}
        combineTransactions={combineTxs ?? undefined}
        openToken={pickerToken}
        onSuccess={handleSplitSuccess}
      />
      {selectMode && (
        <View style={styles.selectBar}>
          <Pressable
            style={styles.selectCancel}
            onPress={cancelSelect}
            accessibilityRole="button"
            accessibilityLabel="Cancel selection"
          >
            <Text style={styles.selectCancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.selectSplit, selectedIds.size === 0 && styles.selectSplitDisabled]}
            onPress={openCombine}
            disabled={selectedIds.size === 0}
            accessibilityRole="button"
            accessibilityLabel="Split selected together"
          >
            <Ionicons name="people-outline" size={16} color={Colors.textInverse} style={{ marginRight: 6 }} />
            <Text style={styles.selectSplitText}>Split together ({selectedIds.size})</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function EmptyState() {
  return (
    <View style={styles.emptyContainer}>
      <View style={styles.emptyIcon}>
        <Ionicons name="checkmark-done-circle-outline" size={48} color={Colors.success} />
      </View>
      <Text style={styles.emptyTitle}>All caught up!</Text>
      <Text style={styles.emptySubtitle}>
        New transactions from your connected bank will appear here.
      </Text>
    </View>
  );
}

function LoadingSkeleton() {
  return (
    <View style={styles.list}>
      {[1, 2, 3].map((i) => (
        <View key={i} style={styles.skeletonCard}>
          <View style={styles.skeletonAvatar} />
          <View style={styles.skeletonLines}>
            <View style={[styles.skeletonLine, { width: '55%' }]} />
            <View style={[styles.skeletonLine, { width: '30%', marginTop: 6 }]} />
          </View>
          <View style={[styles.skeletonLine, { width: 52, height: 20 }]} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
    backgroundColor: Colors.bg,
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
  badge: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.full,
    minWidth: 28,
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
  },
  badgeText: {
    color: Colors.textInverse,
    fontSize: 13,
    fontWeight: '700',
  },

  list: { padding: Spacing.lg, gap: 10 },

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
    backgroundColor: Colors.successLight,
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

  skeletonCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  skeletonAvatar: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    backgroundColor: Colors.surfaceMuted,
    marginRight: Spacing.md,
  },
  skeletonLines: { flex: 1, marginRight: Spacing.md },
  skeletonLine: {
    height: 14,
    borderRadius: Radius.sm,
    backgroundColor: Colors.surfaceMuted,
  },

  selectBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: Spacing.md,
    padding: Spacing.lg,
    backgroundColor: Colors.surface,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  selectCancel: {
    paddingVertical: 16,
    paddingHorizontal: Spacing.xl,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surfaceMuted,
    justifyContent: 'center',
    alignItems: 'center',
  },
  selectCancelText: { fontSize: 15, fontWeight: '600', color: Colors.textSecondary },
  selectSplit: {
    flex: 1,
    flexDirection: 'row',
    paddingVertical: 16,
    borderRadius: Radius.lg,
    backgroundColor: Colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    ...Shadow.sm,
  },
  selectSplitDisabled: { backgroundColor: Colors.surfaceMuted },
  selectSplitText: { fontSize: 15, fontWeight: '700', color: Colors.textInverse },
});
