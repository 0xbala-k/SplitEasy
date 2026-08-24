import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StatusBar, StyleSheet, Text, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTransactionStore } from '@/stores/transactionStore';
import { usePlaidStore } from '@/stores/plaidStore';
import { TransactionRow } from '@/components/TransactionRow';
import { VacationBanner } from '@/components/VacationBanner';
import { ReauthBanner } from '@/components/ReauthBanner';
import { OfflineBanner } from '@/components/OfflineBanner';
import { FriendPickerSheet } from '@/components/FriendPickerSheet';
import { useToast } from '@/components/ToastProvider';
import { showDialog } from '@/lib/dialog';
import { getSplitDecision, getTransactionsByIds, deleteTransactionsByPlaidIds, removeTransactionFromVacation } from '@/lib/db';
import { Transaction, SplitDecision, ReviewItem, SplitwiseInboxItem } from '@/lib/types';
import { Bucket } from '@/lib/buckets';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { Colors, Spacing, Radius, Shadow, merchantColor } from '@/lib/theme';
import { resolveBucket } from '@/lib/buckets';
import { BucketPickerSheet } from '@/components/BucketPickerSheet';
import { useBucketEditor } from '@/hooks/useBucketEditor';

// Clears the absolute-positioned selectBar so it doesn't cover the last row.
const SELECT_BAR_CLEARANCE = 88;

// Adapt a review item back to a Transaction for the picker's single-edit
// flow. amount/currency/date come from the item (already the posted values
// after rekeying); pending/created_at don't affect the expense, so safe
// defaults are fine. Mirrors history.tsx's asTransaction.
function reviewItemAsTransaction(item: ReviewItem): Transaction {
  return {
    id: item.transaction_ids[0],
    merchant_name: item.merchant_name,
    amount: item.amount,
    currency: item.currency,
    date: item.date,
    status: 'split',
    pending: false,
    created_at: item.date,
  };
}

export default function NewTransactionsScreen() {
  const router = useRouter();
  const topInset = useSafeAreaInsets().top;
  const {
    transactions, isLoading, review, load, refresh, skip, loadReview, resolveReview,
    deleteSplit, deleteCombinedSplit, merchantBuckets, setBucket,
    splitwiseInbox, loadInbox, acceptInboxItem, dismissInboxItem,
    splitwiseAuthExpired, clearSplitwiseAuthExpired,
  } = useTransactionStore();
  const needsReauth = usePlaidStore((s) => s.needs_reauth);
  const [isConnected, setIsConnected] = useState(true);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const sheetRef = useRef<BottomSheetModal>(null);
  const toast = useToast();
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [combineTxs, setCombineTxs] = useState<Transaction[] | null>(null);
  const [pickerToken, setPickerToken] = useState(0);
  const [pendingPresent, setPendingPresent] = useState(false);
  const [editDecision, setEditDecision] = useState<SplitDecision | null>(null);
  const [pickerMode, setPickerMode] = useState<'create' | 'edit'>('create');
  const [reviewResolveIds, setReviewResolveIds] = useState<string[] | null>(null);
  const [inboxTarget, setInboxTarget] = useState<SplitwiseInboxItem | null>(null);
  const inboxSheetRef = useRef<BottomSheetModal>(null);
  const [inboxPendingPresent, setInboxPendingPresent] = useState(false);

  useEffect(() => {
    load();
    loadReview();
    loadInbox();
    refresh().then(() => loadReview());
    const unsub = NetInfo.addEventListener((state) => setIsConnected(!!state.isConnected));
    return unsub;
  }, []);

  // The poll swallows its own errors so it can't fail the Plaid refresh; this
  // is the one place a dead Splitwise session becomes visible.
  useEffect(() => {
    if (!splitwiseAuthExpired) return;
    toast.show('Splitwise session expired. Please sign in again.', 'error');
    clearSplitwiseAuthExpired();
  }, [splitwiseAuthExpired, clearSplitwiseAuthExpired, toast]);

  // Present from an effect, after the sheet has rendered with a target —
  // BucketPickerSheet returns null while it has no bucket, so on the first tap
  // the ref is still null and a synchronous present() silently does nothing.
  useEffect(() => {
    if (!inboxPendingPresent) return;
    inboxSheetRef.current?.present();
    setInboxPendingPresent(false);
  }, [inboxPendingPresent]);

  function openInboxAccept(item: SplitwiseInboxItem) {
    setInboxTarget(item);
    setInboxPendingPresent(true);
  }

  async function handleInboxBucket(bucket: Bucket) {
    if (!inboxTarget) return;
    const item = inboxTarget;
    inboxSheetRef.current?.dismiss();
    setInboxTarget(null);
    try {
      await acceptInboxItem(item, bucket);
      toast.show('Added to History', 'success');
    } catch {
      toast.show('Could not add that expense. Please try again.', 'error');
    }
  }

  async function handleInboxDismiss(item: SplitwiseInboxItem) {
    try {
      await dismissInboxItem(item.expense_id);
    } catch {
      toast.show('Could not dismiss that expense. Please try again.', 'error');
    }
  }

  // Reload local state (not a Plaid refresh) on every focus, so a re-tag made
  // elsewhere (e.g. teaching a merchant a new bucket from Spending) is
  // reflected in this screen's bucket guesses. refresh() stays mount-only
  // above — running it on every tab switch would hit the network needlessly.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Present from an effect, after the sheet has rendered with the chosen
  // transaction — same reason as the history screen. FriendPickerSheet renders
  // null while it has no transaction, so on the first tap sheetRef.current is
  // still null and a synchronous present() silently does nothing.
  useEffect(() => {
    if (!pendingPresent) return;
    sheetRef.current?.present();
    setPendingPresent(false);
  }, [pendingPresent]);

  function openSheet(tx: Transaction) {
    setCombineTxs(null);
    setEditDecision(null);
    setPickerMode('create');
    setReviewResolveIds(null);
    setSelected(tx);
    setPickerToken((t) => t + 1);
    setPendingPresent(true);
  }

  const bucketEditor = useBucketEditor(setBucket);

  function openBucketSheet(tx: Transaction) {
    bucketEditor.open({
      ids: [tx.id],
      merchantName: tx.merchant_name,
      bucket: resolveBucket(tx, merchantBuckets).bucket,
      locked: !!tx.vacation_id,
      onRemoveFromVacation: tx.vacation_id
        ? () => removeTransactionFromVacation(tx.id).then(() => load())
        : undefined,
    });
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
    // A single Splitwise expense has one currency; block combining across currencies.
    if (new Set(members.map((t) => t.currency)).size > 1) {
      toast.show('Select transactions in the same currency to combine.', 'error');
      return;
    }
    setSelected(null);
    setEditDecision(null);
    setPickerMode('create');
    setReviewResolveIds(null);
    setCombineTxs(members);
    setPickerToken((t) => t + 1);
    setPendingPresent(true);
  }

  async function openReviewEdit(item: ReviewItem) {
    if (item.transaction_ids.length > 1) {
      const [members, decision] = await Promise.all([
        getTransactionsByIds(item.transaction_ids),
        getSplitDecision(item.transaction_ids[0]),
      ]);
      if (!decision || members.length === 0) {
        toast.show('Could not load this split. Please try again.', 'error');
        return;
      }
      setSelected(null);
      setCombineTxs(members);
      setEditDecision(decision);
    } else {
      const decision = await getSplitDecision(item.transaction_ids[0]);
      if (!decision) {
        toast.show('Could not load this split. Please try again.', 'error');
        return;
      }
      setCombineTxs(null);
      setSelected(reviewItemAsTransaction(item));
      setEditDecision(decision);
    }
    setPickerMode('edit');
    setReviewResolveIds(item.transaction_ids);
    setPickerToken((t) => t + 1);
    setPendingPresent(true);
  }

  function openReviewReversed(item: ReviewItem) {
    const isCombined = item.transaction_ids.length > 1;
    const label = isCombined ? `${item.transaction_ids.length} transactions` : item.merchant_name;
    showDialog(
      'Charge reversed',
      `The pending charge for ${label} never posted. This removes the Splitwise expense and clears it from your review queue.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete expense',
          style: 'destructive',
          onPress: async () => {
            try {
              if (isCombined) {
                await deleteCombinedSplit(item.transaction_ids, item.expense_id);
              } else {
                await deleteSplit(item.transaction_ids[0], item.expense_id);
              }
              await deleteTransactionsByPlaidIds(item.transaction_ids);
              await load();
              await loadReview();
              toast.show('Reversed charge removed', 'success');
            } catch {
              toast.show('Failed to remove. Please try again.', 'error');
            }
          },
        },
      ]
    );
  }

  function handleSplitSuccess(amountEach: number) {
    sheetRef.current?.dismiss();
    if (reviewResolveIds) {
      const ids = reviewResolveIds;
      setReviewResolveIds(null);
      setEditDecision(null);
      setPickerMode('create');
      resolveReview(ids);
      toast.show('Split updated', 'success');
      return;
    }
    cancelSelect();
    toast.show(`Added! Others owe you $${amountEach.toFixed(2)}`, 'success');
  }

  function handleReauth() {
    router.push('/(auth)/bank-connect');
  }

  async function handleRefresh() {
    await refresh();
    await loadReview();
    await loadInbox();
  }

  const isEmptyAndLoaded =
    !isLoading && transactions.length === 0 && review.length === 0 && splitwiseInbox.length === 0;
  const listExtraData = useMemo(() => ({ selectMode, selectedIds }), [selectMode, selectedIds]);

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

      <VacationBanner />

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
          contentContainerStyle={[styles.list, selectMode && styles.listWithSelectBar]}
          extraData={listExtraData}
          refreshControl={
            <RefreshControl
              refreshing={isLoading}
              onRefresh={handleRefresh}
              tintColor={Colors.primary}
            />
          }
          ListHeaderComponent={
            <>
              <ReviewSection items={review} onAmountChanged={openReviewEdit} onReversed={openReviewReversed} />
              <SplitwiseSection
                items={splitwiseInbox}
                onAccept={openInboxAccept}
                onDismiss={handleInboxDismiss}
              />
            </>
          }
          ListEmptyComponent={transactions.length === 0 ? <EmptyState /> : null}
          renderItem={({ item }) => (
            <TransactionRow
              transaction={item}
              onSkip={() => skip(item.id)}
              onSplit={() => openSheet(item)}
              onLongPress={() => enterSelect(item)}
              selectMode={selectMode}
              selected={selectedIds.has(item.id)}
              onToggleSelect={() => toggleSelect(item.id)}
              bucket={resolveBucket(item, merchantBuckets).bucket}
              bucketLocked={!!item.vacation_id}
              onBucketPress={() => openBucketSheet(item)}
            />
          )}
        />
      )}

      <FriendPickerSheet
        ref={sheetRef}
        transaction={selected}
        combineTransactions={combineTxs ?? undefined}
        mode={pickerMode}
        editDecision={editDecision}
        openToken={pickerToken}
        onSuccess={handleSplitSuccess}
      />
      <BucketPickerSheet ref={bucketEditor.sheetRef} {...bucketEditor.sheetProps} />
      <BucketPickerSheet
        ref={inboxSheetRef}
        bucket={inboxTarget ? resolveBucket({
          merchant_name: inboxTarget.description,
          plaid_category: null,
          bucket: null,
          vacation_id: null,
        }, merchantBuckets).bucket : null}
        merchantName={inboxTarget?.description ?? ''}
        onSelect={handleInboxBucket}
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

// Pinned "Needs review" section rendered as the FlatList's ListHeaderComponent
// (not a nested list), per the product decision: transactions whose
// pending→posted transition needs attention surface here, not in a new tab.
function ReviewSection({
  items,
  onAmountChanged,
  onReversed,
}: {
  items: ReviewItem[];
  onAmountChanged: (item: ReviewItem) => void;
  onReversed: (item: ReviewItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <View style={styles.reviewSection}>
      <Text style={styles.reviewHeading}>Needs review · {items.length}</Text>
      {items.map((item) => (
        <ReviewRow
          key={item.id}
          item={item}
          onPress={() => (item.reason === 'amount_changed' ? onAmountChanged(item) : onReversed(item))}
        />
      ))}
    </View>
  );
}

function ReviewRow({ item, onPress }: { item: ReviewItem; onPress: () => void }) {
  const initial = (item.merchant_name ?? '?')[0].toUpperCase();
  const avatarColor = merchantColor(item.merchant_name ?? '?');
  const isAmountChanged = item.reason === 'amount_changed';

  return (
    <Pressable
      style={({ pressed }) => [styles.reviewCard, pressed && styles.reviewCardPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        isAmountChanged
          ? `Review amount change for ${item.merchant_name}`
          : `Review reversed charge for ${item.merchant_name}`
      }
    >
      <View style={[styles.avatar, { backgroundColor: avatarColor + '18' }]}>
        <Text style={[styles.avatarText, { color: avatarColor }]}>{initial}</Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.merchant} numberOfLines={1}>{item.merchant_name}</Text>
        {isAmountChanged ? (
          <Text style={styles.reviewDetail}>
            ${(item.amount_changed_from ?? 0).toFixed(2)} → ${item.amount.toFixed(2)}
          </Text>
        ) : (
          <Text style={styles.reviewDetail}>Charge reversed</Text>
        )}
        {item.split.friend_names.length > 0 && (
          <View style={styles.reviewSplitBadge}>
            <Ionicons name="people-outline" size={11} color={Colors.textSecondary} style={{ marginRight: 3 }} />
            <Text style={styles.reviewSplitText} numberOfLines={1}>
              {item.split.friend_names.join(', ')}
            </Text>
          </View>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
    </Pressable>
  );
}

// Friend-paid Splitwise expenses awaiting approval, rendered in the FlatList's
// header alongside "Needs review". These never enter the main list: they are
// not 'new' transactions and have nothing to split — only accept or dismiss.
function SplitwiseSection({
  items,
  onAccept,
  onDismiss,
}: {
  items: SplitwiseInboxItem[];
  onAccept: (item: SplitwiseInboxItem) => void;
  onDismiss: (item: SplitwiseInboxItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <View style={styles.reviewSection}>
      <Text style={styles.reviewHeading}>From Splitwise · {items.length}</Text>
      {items.map((item) => (
        <InboxRow
          key={item.expense_id}
          item={item}
          onPress={() => onAccept(item)}
          onDismiss={() => onDismiss(item)}
        />
      ))}
    </View>
  );
}

function InboxRow({
  item, onPress, onDismiss,
}: {
  item: SplitwiseInboxItem;
  onPress: () => void;
  onDismiss: () => void;
}) {
  const initial = (item.description || '?')[0].toUpperCase();
  const avatarColor = merchantColor(item.description || '?');

  return (
    <Pressable
      style={({ pressed }) => [styles.reviewCard, pressed && styles.reviewCardPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Add ${item.description} to history`}
    >
      <View style={[styles.avatar, { backgroundColor: avatarColor + '20' }]}>
        <Text style={[styles.avatarText, { color: avatarColor }]}>{initial}</Text>
      </View>
      {/* minWidth: 0 lets the subtitle truncate instead of pushing the amount
          off the row on web, where a flex item's default min-width is its
          content size, not 0. */}
      <View style={styles.inboxInfo}>
        <Text style={styles.merchant} numberOfLines={1}>{item.description}</Text>
        <Text style={styles.reviewDetail} numberOfLines={1}>
          {item.payer_name} paid · your share ${item.my_share.toFixed(2)}
        </Text>
      </View>
      <Text style={styles.amount}>${item.cost.toFixed(2)}</Text>
      <Pressable
        onPress={onDismiss}
        hitSlop={12}
        style={styles.inboxDismiss}
        accessibilityRole="button"
        accessibilityLabel={`Dismiss ${item.description}`}
      >
        <Ionicons name="close" size={18} color={Colors.textTertiary} />
      </Pressable>
    </Pressable>
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
  listWithSelectBar: { paddingBottom: SELECT_BAR_CLEARANCE },

  reviewSection: {
    marginBottom: Spacing.sm,
    gap: 10,
  },
  reviewHeading: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.warning,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 2,
  },
  reviewCard: {
    backgroundColor: Colors.warningLight,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    ...Shadow.sm,
  },
  reviewCardPressed: { backgroundColor: Colors.surfaceMuted },
  reviewDetail: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontWeight: '600',
    marginTop: 2,
  },
  reviewSplitBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  reviewSplitText: {
    flex: 1,
    fontSize: 12,
    color: Colors.textSecondary,
    fontWeight: '500',
  },

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
  },
  amount: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  inboxInfo: { flex: 1, minWidth: 0, marginRight: Spacing.sm },
  inboxDismiss: { marginLeft: Spacing.sm, padding: 4 },

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
