// mobile/components/FriendPickerSheet.tsx
import { forwardRef, memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  BottomSheetModal,
  BottomSheetView,
  BottomSheetTextInput,
  BottomSheetFlatList,
} from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { useFriendStore } from '@/stores/friendStore';
import { useAuthStore } from '@/stores/authStore';
import { useTransactionStore } from '@/stores/transactionStore';
import { getSplitDecision, upsertSplitDecision } from '@/lib/db';
import { createExpense, updateExpense, deleteExpense, getExpense, SplitwiseAuthError } from '@/lib/splitwise';
import { SplitwiseFriend, Transaction, SplitDecision } from '@/lib/types';
import { useToast } from '@/components/ToastProvider';
import { Colors, Radius, Shadow, Spacing, merchantColor } from '@/lib/theme';

type SplitMode = 'equal' | 'custom';
const STEP = 0.5;

function summarizeMerchants(members: Transaction[]): string {
  const names = members.map((m) => m.merchant_name);
  if (names.length <= 2) return names.join(', ');
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

interface Props {
  transaction: Transaction | null;
  combineTransactions?: Transaction[]; // when present, this is a combined split
  mode?: 'create' | 'edit';
  editDecision?: SplitDecision | null;
  // Changes each time the host presents the sheet, so the pre-fill effect
  // re-runs on every open — even when re-editing the same transaction after
  // dismissing without saving (otherwise stale uncommitted edits would linger).
  openToken?: number;
  onSuccess: (amountEach: number) => void;
}

export const FriendPickerSheet = forwardRef<BottomSheetModal, Props>(
  ({ transaction, combineTransactions, mode = 'create', editDecision, openToken, onSuccess }, ref) => {
    const { friends, isLoading } = useFriendStore();
    const user_id = useAuthStore((s) => s.user_id);
    const markSplit = useTransactionStore((s) => s.markSplit);
    const commitCombinedSplit = useTransactionStore((s) => s.commitCombinedSplit);

    const members = useMemo(
      () =>
        combineTransactions && combineTransactions.length > 0
          ? combineTransactions
          : transaction
          ? [transaction]
          : [],
      [combineTransactions, transaction]
    );
    const isCombine = (combineTransactions?.length ?? 0) > 0;
    const totalAmount = useMemo(() => members.reduce((s, t) => s + t.amount, 0), [members]);
    const currency = members[0]?.currency ?? 'USD';

    const [title, setTitle] = useState('');

    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [query, setQuery] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [splitMode, setSplitMode] = useState<SplitMode>('equal');
    const [customAmounts, setCustomAmounts] = useState<Record<string, number>>({});
    const toast = useToast();

    useEffect(() => {
      if (mode !== 'edit' || !editDecision) {
        // Reset so an edit session's pre-fill never leaks into a later create.
        setSelected(new Set());
        setCustomAmounts({});
        setSplitMode('equal');
        return;
      }
      setSelected(new Set(editDecision.friend_ids));
      let ignored = false;
      (async () => {
        try {
          const shares = await getExpense(editDecision.splitwise_expense_id);
          if (ignored) return;
          const amounts: Record<string, number> = {};
          editDecision.friend_ids.forEach((fid) => {
            amounts[fid] = shares[fid] ?? 0;
          });
          setCustomAmounts(amounts);
          // Equal vs. custom is decided from the friends' shares only; the owner
          // absorbs any rounding remainder, so an equal split where the owner's
          // share differs by cents is still correctly detected as equal. The
          // tradeoff: a custom split whose friend shares happen to be equal
          // (unequal owner share) reads as equal and re-equalizes on a no-op save.
          const vals = Object.values(amounts);
          const allEqual = vals.length === 0 || vals.every((v) => Math.abs(v - vals[0]) < 0.005);
          setSplitMode(allEqual ? 'equal' : 'custom');
        } catch {
          // Network/auth failure: keep friends selected, default to equal split.
          if (!ignored) setSplitMode('equal');
        }
      })();
      return () => {
        ignored = true;
      };
      // Re-run on every open (openToken) and when the edited transaction changes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, editDecision?.transaction_id, openToken]);

    // Pre-fill the title on every open: stored description for edits, a merchant
    // summary for combined splits, otherwise the single transaction's merchant.
    useEffect(() => {
      if (mode === 'edit' && editDecision) {
        setTitle(editDecision.description || members[0]?.merchant_name || '');
      } else if (isCombine) {
        setTitle(summarizeMerchants(members));
      } else {
        setTitle(members[0]?.merchant_name || '');
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openToken]);

    const filtered = useMemo(() => {
      const q = query.trim().toLowerCase();
      return q ? friends.filter((f) => f.display_name.toLowerCase().includes(q)) : friends;
    }, [friends, query]);

    const selectedFriends = useMemo(
      () => friends.filter((f) => selected.has(f.id)),
      [friends, selected]
    );

    if (members.length === 0) return null;

    const totalCents = Math.round(totalAmount * 100);
    const n = selected.size + 1;
    const equalShareCents = selected.size > 0 ? Math.floor(totalCents / n) : 0;

    const friendTotalCents =
      splitMode === 'custom'
        ? selectedFriends.reduce(
            (sum, f) => sum + Math.round((customAmounts[f.id] ?? 0) * 100),
            0
          )
        : equalShareCents * selected.size;

    const ownerShareCents = totalCents - friendTotalCents;
    const isOverBudget = ownerShareCents < -1;
    const ctaDisabled = selected.size === 0 || submitting || isOverBudget || title.trim() === '';

    // Stable so memoized EqualRows only re-render when their own selection flips.
    const toggle = useCallback((id: string) => {
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }, []);

    function switchToCustom() {
      const baseShareCents = Math.floor(totalCents / n);
      const amounts: Record<string, number> = {};
      selectedFriends.forEach((f) => {
        amounts[f.id] = baseShareCents / 100;
      });
      setCustomAmounts(amounts);
      setSplitMode('custom');
    }

    function adjustAmount(id: string, delta: number) {
      setCustomAmounts((prev) => {
        const current = prev[id] ?? 0;
        const next = Math.max(0, Math.round((current + delta) * 100) / 100);
        return { ...prev, [id]: next };
      });
    }

    function commitAmount(id: string, value: number) {
      setCustomAmounts((prev) => ({ ...prev, [id]: value }));
    }

    async function handleAddToSplitwise() {
      if (ctaDisabled) return;
      setSubmitting(true);
      const friendIds = selectedFriends.map((f) => f.id);
      const friendNames = selectedFriends.map((f) => f.display_name);
      const desc = title.trim();
      const shares = splitMode === 'custom' ? { friendShares: customAmounts } : {};
      try {
        if (mode === 'edit' && editDecision) {
          const { amount_each } = await updateExpense(editDecision.splitwise_expense_id, {
            amount: totalAmount,
            description: desc,
            currency,
            currentUserId: user_id!,
            friendIds,
            ...shares,
          });
          for (const t of members) {
            await upsertSplitDecision({
              // Reuse the loaded decision's id for its own row; other members
              // conflict on transaction_id so their generated id is ignored.
              id: t.id === editDecision.transaction_id ? editDecision.id : `${t.id}-${Date.now()}`,
              transaction_id: t.id,
              splitwise_expense_id: editDecision.splitwise_expense_id,
              friend_ids: friendIds,
              friend_names: friendNames,
              amount_each,
              created_at: editDecision.created_at,
              description: desc,
            });
          }
          onSuccess(amount_each);
          return;
        }

        // Create. Idempotency check only applies to a single transaction.
        if (!isCombine) {
          const existing = await getSplitDecision(members[0].id);
          if (existing) {
            await markSplit(members[0].id);
            onSuccess(existing.amount_each);
            return;
          }
        }

        const { expense_id, amount_each } = await createExpense({
          amount: totalAmount,
          description: desc,
          currency,
          currentUserId: user_id!,
          friendIds,
          ...shares,
        });

        const ts = Date.now();
        const createdAt = new Date().toISOString();
        const decisions: SplitDecision[] = members.map((t) => ({
          id: `${t.id}-${ts}`,
          transaction_id: t.id,
          splitwise_expense_id: expense_id,
          friend_ids: friendIds,
          friend_names: friendNames,
          amount_each,
          created_at: createdAt,
          description: desc,
        }));
        try {
          // Persist all member rows + statuses atomically.
          await commitCombinedSplit(decisions);
        } catch (dbErr) {
          // Local commit failed after the remote expense was created — undo the
          // remote side so no orphan is left and a retry won't create a duplicate.
          try {
            await deleteExpense(expense_id);
          } catch {
            // Best-effort rollback; surface the original failure below.
          }
          throw dbErr;
        }
        onSuccess(amount_each);
      } catch (err) {
        if (err instanceof SplitwiseAuthError) {
          toast.show('Splitwise session expired. Please sign in again.', 'error');
        } else {
          toast.show('Failed to add expense. Please try again.', 'error');
        }
      } finally {
        setSubmitting(false);
      }
    }

    const titleColor = merchantColor(title || '?');
    const titleInitial = (title || '?')[0].toUpperCase();

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={['55%', '90%']}
        enablePanDownToClose
        handleIndicatorStyle={styles.indicator}
        backgroundStyle={styles.sheetBg}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
      >
        <BottomSheetView style={styles.container}>
          {/* Title + total */}
          <View style={styles.txSummary}>
            <View style={[styles.txAvatar, { backgroundColor: titleColor + '18' }]}>
              <Text style={[styles.txAvatarText, { color: titleColor }]}>{titleInitial}</Text>
            </View>
            <View style={styles.txInfo}>
              <BottomSheetTextInput
                style={styles.titleInput}
                value={title}
                onChangeText={setTitle}
                placeholder="Split title"
                placeholderTextColor={Colors.textTertiary}
                accessibilityLabel="Split title"
                returnKeyType="done"
              />
              <Text style={styles.txTotal}>${totalAmount.toFixed(2)}</Text>
            </View>
          </View>

          {/* Equal / Custom segmented control */}
          {selected.size > 0 && (
            <View style={styles.segmented}>
              <Pressable
                style={[styles.segBtn, splitMode === 'equal' && styles.segBtnActive]}
                onPress={() => setSplitMode('equal')}
                accessibilityRole="button"
                accessibilityState={{ selected: splitMode === 'equal' }}
              >
                <Text style={[styles.segText, splitMode === 'equal' && styles.segTextActive]}>
                  Equal
                </Text>
              </Pressable>
              <Pressable
                style={[styles.segBtn, splitMode === 'custom' && styles.segBtnActive]}
                onPress={switchToCustom}
                accessibilityRole="button"
                accessibilityState={{ selected: splitMode === 'custom' }}
              >
                <Text style={[styles.segText, splitMode === 'custom' && styles.segTextActive]}>
                  Custom
                </Text>
              </Pressable>
            </View>
          )}

          {splitMode === 'equal' ? (
            <>
              {/* Equal split preview */}
              {selected.size > 0 && (
                <View style={styles.splitPreview}>
                  <Ionicons
                    name="people-outline"
                    size={16}
                    color={Colors.primary}
                    style={{ marginRight: 6 }}
                  />
                  <Text style={styles.splitPreviewText}>
                    ${(ownerShareCents / 100).toFixed(2)} each · {n} people
                  </Text>
                </View>
              )}

              {/* Search */}
              <View style={styles.searchRow}>
                <Ionicons
                  name="search-outline"
                  size={16}
                  color={Colors.textTertiary}
                  style={styles.searchIcon}
                />
                <BottomSheetTextInput
                  style={styles.searchInput}
                  placeholder="Search friends…"
                  placeholderTextColor={Colors.textTertiary}
                  value={query}
                  onChangeText={setQuery}
                  autoCorrect={false}
                  clearButtonMode="while-editing"
                  returnKeyType="search"
                  accessibilityLabel="Search friends"
                />
              </View>

              <Text style={styles.sectionLabel}>
                {query !== '' && filtered.length === 0
                  ? `No results for "${query}"`
                  : 'Select friends to split with'}
              </Text>

              {isLoading ? (
                <ActivityIndicator color={Colors.primary} style={styles.spinner} />
              ) : friends.length === 0 ? (
                <View style={styles.emptyContainer}>
                  <Ionicons name="people-outline" size={32} color={Colors.textTertiary} />
                  <Text style={styles.emptyText}>No Splitwise friends found.</Text>
                </View>
              ) : (
                <BottomSheetFlatList
                  data={filtered}
                  keyExtractor={(f) => f.id}
                  style={styles.list}
                  keyboardShouldPersistTaps="handled"
                  renderItem={({ item }) => (
                    <EqualRow
                      friend={item}
                      isSelected={selected.has(item.id)}
                      onToggle={toggle}
                    />
                  )}
                />
              )}
            </>
          ) : (
            <>
              {/* Owner share card */}
              <View style={[styles.ownerCard, isOverBudget && styles.ownerCardError]}>
                <View>
                  <Text style={[styles.ownerLabel, isOverBudget && styles.ownerLabelError]}>
                    Your share
                  </Text>
                  {isOverBudget && (
                    <Text style={styles.ownerHint}>Reduce friend amounts to balance</Text>
                  )}
                </View>
                <Text style={[styles.ownerAmount, isOverBudget && styles.ownerAmountError]}>
                  {isOverBudget ? '—' : `$${(ownerShareCents / 100).toFixed(2)}`}
                </Text>
              </View>

              <Text style={styles.sectionLabel}>Custom amounts</Text>

              <BottomSheetFlatList
                data={selectedFriends}
                keyExtractor={(f) => f.id}
                style={styles.list}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <CustomRow
                    friend={item}
                    amount={customAmounts[item.id] ?? 0}
                    onDecrease={() => adjustAmount(item.id, -STEP)}
                    onIncrease={() => adjustAmount(item.id, STEP)}
                    onCommit={(v) => commitAmount(item.id, v)}
                  />
                )}
              />
            </>
          )}

          {/* CTA */}
          <Pressable
            style={({ pressed }) => [
              styles.addBtn,
              ctaDisabled && styles.addBtnDisabled,
              pressed && !ctaDisabled && styles.addBtnPressed,
            ]}
            onPress={handleAddToSplitwise}
            disabled={ctaDisabled}
            accessibilityRole="button"
            accessibilityLabel="Add split to Splitwise"
          >
            {submitting ? (
              <ActivityIndicator color={Colors.textInverse} />
            ) : (
              <>
                <Ionicons
                  name="checkmark-circle-outline"
                  size={18}
                  color={ctaDisabled ? Colors.textTertiary : Colors.textInverse}
                  style={{ marginRight: 6 }}
                />
                <Text style={[styles.addBtnText, ctaDisabled && styles.addBtnTextDisabled]}>
                  {mode === 'edit' ? 'Save changes' : 'Add to Splitwise'}
                </Text>
              </>
            )}
          </Pressable>
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

const EqualRow = memo(function EqualRow({
  friend,
  isSelected,
  onToggle,
}: {
  friend: SplitwiseFriend;
  isSelected: boolean;
  onToggle: (id: string) => void;
}) {
  const initial = friend.display_name[0].toUpperCase();
  const avatarColor = merchantColor(friend.display_name);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.friendRow,
        isSelected && styles.friendRowSelected,
        pressed && !isSelected && styles.friendRowPressed,
      ]}
      onPress={() => onToggle(friend.id)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: isSelected }}
      accessibilityLabel={friend.display_name}
    >
      <View style={[styles.avatar, { backgroundColor: avatarColor + '18' }]}>
        <Text style={[styles.avatarText, { color: avatarColor }]}>{initial}</Text>
      </View>
      <Text style={[styles.friendName, isSelected && styles.friendNameSelected]}>
        {friend.display_name}
      </Text>
      <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
        {isSelected && <Ionicons name="checkmark" size={13} color={Colors.textInverse} />}
      </View>
    </Pressable>
  );
});

function CustomRow({
  friend,
  amount,
  onDecrease,
  onIncrease,
  onCommit,
}: {
  friend: SplitwiseFriend;
  amount: number;
  onDecrease: () => void;
  onIncrease: () => void;
  onCommit: (value: number) => void;
}) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(amount.toFixed(2));

  useEffect(() => {
    if (!focused) setText(amount.toFixed(2));
  }, [amount, focused]);

  function handleBlur() {
    setFocused(false);
    const parsed = parseFloat(text);
    if (!isNaN(parsed) && parsed >= 0) {
      const rounded = Math.round(parsed * 100) / 100;
      onCommit(rounded);
      setText(rounded.toFixed(2));
    } else {
      setText(amount.toFixed(2));
    }
  }

  const initial = friend.display_name[0].toUpperCase();
  const avatarColor = merchantColor(friend.display_name);

  return (
    <View style={styles.customRow}>
      <View style={[styles.avatar, { backgroundColor: avatarColor + '18' }]}>
        <Text style={[styles.avatarText, { color: avatarColor }]}>{initial}</Text>
      </View>
      <Text style={styles.customName} numberOfLines={1}>
        {friend.display_name}
      </Text>
      <View style={styles.stepper}>
        <Pressable
          style={({ pressed }) => [styles.stepBtn, pressed && styles.stepBtnPressed]}
          onPress={onDecrease}
          accessibilityLabel={`Decrease ${friend.display_name}'s share`}
        >
          <Ionicons name="remove" size={18} color={Colors.textPrimary} />
        </Pressable>
        <View style={styles.stepAmountWrap}>
          <Text style={styles.stepDollar}>$</Text>
          <BottomSheetTextInput
            style={styles.stepInput}
            value={text}
            onChangeText={setText}
            onFocus={() => setFocused(true)}
            onBlur={handleBlur}
            keyboardType="decimal-pad"
            selectTextOnFocus
            accessibilityLabel={`${friend.display_name}'s share amount`}
          />
        </View>
        <Pressable
          style={({ pressed }) => [styles.stepBtn, pressed && styles.stepBtnPressed]}
          onPress={onIncrease}
          accessibilityLabel={`Increase ${friend.display_name}'s share`}
        >
          <Ionicons name="add" size={18} color={Colors.textPrimary} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  indicator: { backgroundColor: Colors.border, width: 36 },
  sheetBg: { backgroundColor: Colors.surface },
  container: { flex: 1, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },

  txSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  txAvatar: {
    width: 48,
    height: 48,
    borderRadius: Radius.md,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  txAvatarText: { fontSize: 20, fontWeight: '700' },
  txInfo: { flex: 1 },
  titleInput: {
    fontSize: 17,
    fontWeight: '700',
    color: Colors.textPrimary,
    paddingVertical: 2,
  },
  txTotal: {
    fontSize: 24,
    fontWeight: '800',
    color: Colors.textPrimary,
    letterSpacing: -0.5,
  },

  segmented: {
    flexDirection: 'row',
    backgroundColor: Colors.surfaceMuted,
    borderRadius: Radius.md,
    padding: 3,
    marginBottom: Spacing.md,
  },
  segBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: Radius.sm,
    alignItems: 'center',
  },
  segBtnActive: { backgroundColor: Colors.surface, ...Shadow.sm },
  segText: { fontSize: 14, fontWeight: '600', color: Colors.textSecondary },
  segTextActive: { color: Colors.textPrimary },

  splitPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.primaryMuted,
    borderRadius: Radius.md,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.md,
  },
  splitPreviewText: { fontSize: 14, color: Colors.primary, fontWeight: '600' },

  ownerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.primaryMuted,
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
  },
  ownerCardError: { backgroundColor: Colors.errorLight },
  ownerLabel: { fontSize: 14, fontWeight: '600', color: Colors.primary },
  ownerLabelError: { color: Colors.error },
  ownerHint: { fontSize: 11, color: Colors.error, marginTop: 2 },
  ownerAmount: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.primary,
    fontVariant: ['tabular-nums'],
  },
  ownerAmountError: { color: Colors.error },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceMuted,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    height: 40,
  },
  searchIcon: { marginRight: Spacing.sm },
  searchInput: { flex: 1, fontSize: 15, color: Colors.textPrimary, height: 40 },

  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: Spacing.sm,
  },

  spinner: { marginTop: 40 },
  emptyContainer: { alignItems: 'center', paddingTop: 40, gap: Spacing.md },
  emptyText: { fontSize: 14, color: Colors.textSecondary },

  list: { flex: 1 },

  friendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    marginBottom: Spacing.xs,
    backgroundColor: Colors.surfaceMuted,
  },
  friendRowSelected: { backgroundColor: Colors.primaryMuted },
  friendRowPressed: { backgroundColor: Colors.border },

  avatar: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  avatarText: { fontSize: 14, fontWeight: '700' },

  friendName: { flex: 1, fontSize: 15, color: Colors.textPrimary, fontWeight: '500' },
  friendNameSelected: { fontWeight: '600', color: Colors.primary },

  checkbox: {
    width: 22,
    height: 22,
    borderRadius: Radius.sm,
    borderWidth: 1.5,
    borderColor: Colors.border,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.surface,
  },
  checkboxSelected: { backgroundColor: Colors.primary, borderColor: Colors.primary },

  customRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    marginBottom: Spacing.xs,
    backgroundColor: Colors.surfaceMuted,
    minHeight: 60,
  },
  customName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: Colors.textPrimary,
    marginRight: Spacing.sm,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  stepBtn: {
    width: 36,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stepBtnPressed: { backgroundColor: Colors.surfaceMuted },
  stepAmountWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.xs,
    minWidth: 72,
    justifyContent: 'center',
  },
  stepDollar: { fontSize: 13, color: Colors.textSecondary, fontWeight: '500' },
  stepInput: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.textPrimary,
    fontVariant: ['tabular-nums'],
    minWidth: 52,
    textAlign: 'center',
    height: 44,
    paddingHorizontal: 2,
  },

  addBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.lg,
    paddingVertical: 16,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.md,
    marginBottom: Spacing.md,
    minHeight: 52,
    ...Shadow.sm,
  },
  addBtnDisabled: { backgroundColor: Colors.surfaceMuted },
  addBtnPressed: { backgroundColor: Colors.primaryDark },
  addBtnText: { color: Colors.textInverse, fontSize: 16, fontWeight: '700' },
  addBtnTextDisabled: { color: Colors.textTertiary },
});
