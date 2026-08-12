// mobile/components/FriendPickerSheet.tsx
import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  BottomSheetModal,
  BottomSheetTextInput,
  BottomSheetFlatList,
  BottomSheetFooter,
  type BottomSheetFooterProps,
} from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFriendStore } from '@/stores/friendStore';
import { useAuthStore } from '@/stores/authStore';
import { useTransactionStore } from '@/stores/transactionStore';
import { getSplitDecision, upsertSplitDecision } from '@/lib/db';
import { createExpense, updateExpense, deleteExpense, getExpense, SplitwiseAuthError } from '@/lib/splitwise';
import { SplitwiseFriend, Transaction, SplitDecision } from '@/lib/types';
import { useToast } from '@/components/ToastProvider';
import { Colors, Radius, Shadow, Spacing, merchantColor } from '@/lib/theme';
import { OWNER_FALLBACK_ID, ReceiptItem, computeReceiptShares, toFriendShares } from '@/lib/receipt';
import { scanReceipt } from '@/lib/receiptScan';
import { generateId } from '@/lib/id';
import { ReceiptCapture } from '@/components/ReceiptCapture';
import { ReceiptItemRow, ReceiptParticipant } from '@/components/ReceiptItemRow';
import { ReceiptSummary } from '@/components/ReceiptSummary';

type SplitMode = 'equal' | 'custom' | 'receipt';
type ReceiptStage = 'capture' | 'assign';
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
  groupId?: string;
  groupMemberIds?: string[];
}

export const FriendPickerSheet = forwardRef<BottomSheetModal, Props>(
  ({ transaction, combineTransactions, mode = 'create', editDecision, openToken, onSuccess, groupId, groupMemberIds }, ref) => {
    const { friends, isLoading } = useFriendStore();
    const user_id = useAuthStore((s) => s.user_id);
    const markSplit = useTransactionStore((s) => s.markSplit);
    const commitCombinedSplit = useTransactionStore((s) => s.commitCombinedSplit);
    const insets = useSafeAreaInsets();

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
    const [receiptStage, setReceiptStage] = useState<ReceiptStage>('capture');
    const [scanning, setScanning] = useState(false);
    const [items, setItems] = useState<ReceiptItem[]>([]);
    const [taxCents, setTaxCents] = useState(0);
    const [tipCents, setTipCents] = useState(0);
    const [useReceiptTotal, setUseReceiptTotal] = useState(false);
    const autoToggledRef = useRef(false);
    const toast = useToast();

    // Receipt-mode state is never loaded from a persisted edit decision (see
    // getExpense below — it only reconstructs friend shares, not items/tax/
    // tip), so it must reset on every open regardless of create vs. edit,
    // unlike selected/customAmounts/splitMode which the effect below re-fills.
    //
    // This reset runs during RENDER (not as a useEffect), deliberately. If it
    // ran as an effect instead, it would sit in the same commit's effect-flush
    // as the reconciliation auto-toggle effect further down — and that effect
    // closes over *this render's* `items`/`receiptDeltaCents`, computed from
    // the *previous* session's (not-yet-reset) items, while `autoToggledRef`
    // would already have been synchronously cleared by the earlier-declared
    // reset effect. That combination (stale positive delta + freshly-cleared
    // latch, both visible in the same pass) let a brand-new, unscanned sheet
    // inherit `useReceiptTotal: true` from the session that was just closed.
    // A render-phase update avoids the two-effects-same-stale-closure window
    // entirely: React discards this in-progress render and restarts the
    // component synchronously with the reset state before committing or
    // running ANY effect for this commit, so every effect that runs afterward
    // — including the auto-toggle effect — only ever observes already-reset
    // state for a new `openToken`. This is the state-adjustment-during-render
    // pattern the React docs use for a getDerivedStateFromProps replacement.
    const [resetOpenToken, setResetOpenToken] = useState(openToken);
    if (openToken !== resetOpenToken) {
      setResetOpenToken(openToken);
      setReceiptStage('capture');
      setScanning(false);
      setItems([]);
      setTaxCents(0);
      setTipCents(0);
      setUseReceiptTotal(false);
      autoToggledRef.current = false;
    }

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
      const base = q ? friends.filter((f) => f.display_name.toLowerCase().includes(q)) : friends;
      if (!groupMemberIds || groupMemberIds.length === 0) return base;
      const memberSet = new Set(groupMemberIds);
      return [...base].sort((a, b) => Number(memberSet.has(b.id)) - Number(memberSet.has(a.id)));
    }, [friends, query, groupMemberIds]);

    const selectedFriends = useMemo(
      () => friends.filter((f) => selected.has(f.id)),
      [friends, selected]
    );

    // Stable so memoized EqualRows only re-render when their own selection flips.
    const toggle = useCallback((id: string) => {
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }, []);

    // Receipt math (Task 6). These must run unconditionally, alongside the
    // CTA-state hooks below, before the bail-out further down.
    const ownerId = user_id ?? OWNER_FALLBACK_ID;
    const friendIdsOrdered = useMemo(() => selectedFriends.map((f) => f.id), [selectedFriends]);
    const receiptParticipants: ReceiptParticipant[] = useMemo(
      () => [{ id: ownerId, label: 'You' }, ...selectedFriends.map((f) => ({ id: f.id, label: f.display_name }))],
      [ownerId, selectedFriends]
    );
    const receipt = useMemo(
      () => computeReceiptShares({ ownerId, friendIds: friendIdsOrdered, items, taxCents, tipCents }),
      [ownerId, friendIdsOrdered, items, taxCents, tipCents]
    );
    // The bank-charged amount, independent of `effectiveTotal` below (which
    // itself depends on `useReceiptTotal`) — this is what ReceiptSummary
    // reconciles the receipt total against.
    const chargedCents = Math.round(totalAmount * 100);
    const receiptDeltaCents = chargedCents - receipt.receiptTotalCents;
    const effectiveTotal =
      splitMode === 'receipt' && useReceiptTotal ? receipt.receiptTotalCents / 100 : totalAmount;

    // Drop assignee ids that no longer correspond to a selected friend (or the
    // owner) whenever the friend selection changes, so a deselected friend's
    // items don't silently keep charging them.
    useEffect(() => {
      const valid = new Set([ownerId, ...friendIdsOrdered]);
      setItems((prev) => {
        let dirty = false;
        const next = prev.map((it) => {
          const kept = it.assignees.filter((a) => valid.has(a));
          if (kept.length === it.assignees.length) return it;
          dirty = true;
          return { ...it, assignees: kept };
        });
        return dirty ? next : prev; // identity-stable when nothing changed, so `receipt`'s memo doesn't re-run needlessly
      });
    }, [ownerId, friendIdsOrdered]);

    // Reconciliation auto-toggle: if the itemized receipt total ends up more
    // than a cent above the bank-charged amount, default to charging the
    // receipt total once (the owner otherwise silently eats the difference).
    // Fires only once per open/scan; after that the user's manual toggle wins.
    // `items.length > 0` is a belt-and-suspenders guard (the primary defense
    // against firing on stale/pre-reset data is the render-phase reset above,
    // which guarantees `items` is already [] for any effect in a fresh
    // open's first committed render) — real items are required for a
    // trustworthy receipt total in the first place, since an empty receipt
    // can only show a negative delta if tax/tip alone exceed the charge.
    useEffect(() => {
      if (items.length > 0 && receiptDeltaCents < -1 && !autoToggledRef.current) {
        autoToggledRef.current = true;
        setUseReceiptTotal(true);
      }
    }, [items.length, receiptDeltaCents]);

    // Derived CTA state is computed here (before the bail-out below) because
    // the footer's useCallback is a hook and needs it, and every hook must
    // run unconditionally before an early return.
    const totalCents = Math.round(effectiveTotal * 100);
    const n = selected.size + 1;
    const equalShareCents = selected.size > 0 ? Math.floor(totalCents / n) : 0;

    const friendTotalCents =
      splitMode === 'receipt'
        ? friendIdsOrdered.reduce((s, id) => s + (receipt.totalPerParticipantCents[id] ?? 0), 0)
        : splitMode === 'custom'
        ? selectedFriends.reduce(
            (sum, f) => sum + Math.round((customAmounts[f.id] ?? 0) * 100),
            0
          )
        : equalShareCents * selected.size;

    const ownerShareCents = totalCents - friendTotalCents;
    const isOverBudget = ownerShareCents < -1;
    const receiptBlocked =
      splitMode === 'receipt' &&
      (receiptStage === 'capture' || scanning || items.length === 0 || receipt.unassignedItemIds.length > 0);
    const ctaDisabled =
      selected.size === 0 || submitting || isOverBudget || title.trim() === '' || receiptBlocked;

    // The footer is rendered by the sheet as a component type, so whenever
    // `renderFooter`'s identity changes the whole footer subtree remounts.
    // That forces a narrow dep list — which would otherwise leave the CTA
    // holding a stale `handleAddToSplitwise` (stale title/customAmounts/
    // splitMode) whenever those change without flipping `ctaDisabled`.
    // Routing the press through a ref keeps the handler current without
    // widening the deps.
    const submitRef = useRef<() => void>(() => {});

    const renderFooter = useCallback(
      // The footer style is opaque so list rows scrolling under the pinned
      // footer don't show through in the gaps beside the button.
      (footerProps: BottomSheetFooterProps) => (
        <BottomSheetFooter {...footerProps} bottomInset={insets.bottom} style={styles.footer}>
          <Pressable
            style={({ pressed }) => [
              styles.addBtn,
              ctaDisabled && styles.addBtnDisabled,
              pressed && !ctaDisabled && styles.addBtnPressed,
            ]}
            onPress={() => submitRef.current()}
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
        </BottomSheetFooter>
      ),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [ctaDisabled, submitting, mode, insets.bottom]
    );

    // Every hook must run before this bail-out, or the render that first
    // supplies a transaction adds hooks the previous render didn't have and
    // React throws "rendered more hooks than during the previous render" —
    // which unmounts the whole tree (blank screen) on tapping Split.
    if (members.length === 0) return null;

    function switchToCustom() {
      const baseShareCents = Math.floor(totalCents / n);
      const amounts: Record<string, number> = {};
      selectedFriends.forEach((f) => {
        amounts[f.id] = baseShareCents / 100;
      });
      setCustomAmounts(amounts);
      setSplitMode('custom');
    }

    function switchToReceipt() {
      setSplitMode('receipt');
      setReceiptStage(items.length > 0 ? 'assign' : 'capture');
    }

    function addReceiptItem() {
      setItems((prev) => [
        ...prev,
        { id: generateId('ritem'), name: '', priceCents: 0, assignees: [] },
      ]);
    }

    // These four are deliberately functional setState updaters keyed by
    // itemId, NOT closures over the `items` variable in scope — ReceiptItemRow
    // is memoized with a comparator that ignores callback identity, so a
    // memoized row may invoke whatever closure it last rendered with. Keying
    // off `prev` + itemId makes that safe regardless of which render's
    // closure actually runs.
    function updateReceiptItemName(itemId: string, name: string) {
      setItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, name } : it)));
    }

    function updateReceiptItemPriceCents(itemId: string, priceCents: number) {
      setItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, priceCents } : it)));
    }

    function deleteReceiptItem(itemId: string) {
      setItems((prev) => prev.filter((it) => it.id !== itemId));
    }

    function updateReceiptItemAssignees(itemId: string, assignees: string[]) {
      setItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, assignees } : it)));
    }

    async function runReceiptScan(source: 'camera' | 'library') {
      setScanning(true);
      try {
        const outcome = await scanReceipt(source);
        if (outcome.status === 'ok') {
          const seeded: ReceiptItem[] = outcome.receipt.items.map((it) => ({
            id: generateId('ritem'),
            name: it.name,
            priceCents: it.price_cents,
            quantity: it.quantity,
            assignees: [],
          }));
          setItems(seeded);
          setTaxCents(outcome.receipt.tax_cents);
          setTipCents(outcome.receipt.tip_cents);
          setReceiptStage('assign');
        } else if (outcome.status === 'failed') {
          toast.show(
            outcome.reason === 'parse'
              ? "Couldn't read that receipt. Enter items manually."
              : outcome.reason === 'network'
              ? 'Network error scanning the receipt. Enter items manually.'
              : "Couldn't process that photo. Enter items manually.",
            'error'
          );
          setReceiptStage('assign');
        }
        // cancelled: stay on the capture stage, nothing to do.
      } finally {
        setScanning(false);
      }
    }

    function handleRetakePhoto() {
      setItems([]);
      setTaxCents(0);
      setTipCents(0);
      setUseReceiptTotal(false);
      autoToggledRef.current = false;
      setReceiptStage('capture');
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
      const shares =
        splitMode === 'receipt'
          ? { friendShares: toFriendShares(receipt, ownerId) }
          : splitMode === 'custom'
          ? { friendShares: customAmounts }
          : {};
      try {
        if (mode === 'edit' && editDecision) {
          const { amount_each } = await updateExpense(editDecision.splitwise_expense_id, {
            amount: effectiveTotal,
            description: desc,
            currency,
            currentUserId: user_id!,
            friendIds,
            groupId,
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
          amount: effectiveTotal,
          description: desc,
          currency,
          currentUserId: user_id!,
          friendIds,
          groupId,
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

    // Keep the pinned footer's press handler pointing at this render's
    // closure (see submitRef above).
    submitRef.current = handleAddToSplitwise;

    const titleColor = merchantColor(title || '?');
    const titleInitial = (title || '?')[0].toUpperCase();

    // Header content differs by mode but must be a single element (not an
    // inline component) — see the ListHeaderComponent prop below.
    const listHeader = (
      <View>
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

        {/* Equal / Custom / Receipt segmented control */}
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
            {/* Unavailable for combined-transaction splits — a receipt is one physical purchase. */}
            {!isCombine && (
              <Pressable
                style={[styles.segBtn, splitMode === 'receipt' && styles.segBtnActive]}
                onPress={switchToReceipt}
                accessibilityRole="button"
                accessibilityState={{ selected: splitMode === 'receipt' }}
              >
                <Text style={[styles.segText, splitMode === 'receipt' && styles.segTextActive]}>
                  Receipt
                </Text>
              </Pressable>
            )}
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
          </>
        ) : splitMode === 'custom' ? (
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
          </>
        ) : (
          <>
            {receiptStage === 'capture' ? (
              <ReceiptCapture
                scanning={scanning}
                onTakePhoto={() => runReceiptScan('camera')}
                onChoosePhoto={() => runReceiptScan('library')}
                onSkip={() => setReceiptStage('assign')}
              />
            ) : (
              <>
                <ReceiptSummary
                  itemsTotalCents={receipt.enteredItemsTotalCents}
                  taxCents={taxCents}
                  tipCents={tipCents}
                  onChangeTaxCents={setTaxCents}
                  onChangeTipCents={setTipCents}
                  chargedCents={chargedCents}
                  useReceiptTotal={useReceiptTotal}
                  onChangeUseReceiptTotal={setUseReceiptTotal}
                  onRetakePhoto={handleRetakePhoto}
                  hasUnassignedItems={receipt.unassignedItemIds.length > 0}
                />
                <Pressable
                  style={({ pressed }) => [styles.addItemBtn, pressed && styles.addItemBtnPressed]}
                  onPress={addReceiptItem}
                  accessibilityRole="button"
                  accessibilityLabel="Add item"
                >
                  <Ionicons name="add-circle-outline" size={18} color={Colors.primary} style={{ marginRight: 6 }} />
                  <Text style={styles.addItemText}>Add item</Text>
                </Pressable>
                <Text style={styles.sectionLabel}>Items</Text>
              </>
            )}
          </>
        )}
      </View>
    );

    // isLoading/empty replace the list body only in equal mode (custom mode's
    // data is the already-selected friends, which is never empty in practice).
    const listEmpty =
      splitMode === 'equal' ? (
        isLoading ? (
          <ActivityIndicator color={Colors.primary} style={styles.spinner} />
        ) : friends.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Ionicons name="people-outline" size={32} color={Colors.textTertiary} />
            <Text style={styles.emptyText}>No Splitwise friends found.</Text>
          </View>
        ) : null
      ) : splitMode === 'receipt' ? (
        scanning ? (
          <ActivityIndicator color={Colors.primary} style={styles.spinner} />
        ) : receiptStage === 'assign' ? (
          <View style={styles.emptyContainer}>
            <Ionicons name="receipt-outline" size={32} color={Colors.textTertiary} />
            <Text style={styles.emptyText}>No items yet. Tap “Add item” to enter one manually.</Text>
          </View>
        ) : null
      ) : null;

    const data: (SplitwiseFriend | ReceiptItem)[] =
      splitMode === 'equal' ? filtered : splitMode === 'custom' ? selectedFriends : items;

    // Per-person breakdown strip pinned to the bottom of the list content
    // (the FlatList's own footer prop — unrelated to, and safe alongside,
    // the sheet's pinned `footerComponent` CTA).
    const receiptListFooter =
      splitMode === 'receipt' && receiptStage === 'assign' ? (
        <View style={styles.receiptFooterStrip}>
          {receiptParticipants.map((p) => (
            <View key={p.id} style={styles.receiptFooterRow}>
              <Text style={styles.receiptFooterName} numberOfLines={1}>
                {p.label}
              </Text>
              <Text style={styles.receiptFooterAmount}>
                ${((receipt.totalPerParticipantCents[p.id] ?? 0) / 100).toFixed(2)}
              </Text>
            </View>
          ))}
        </View>
      ) : null;

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={['55%', '90%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        handleIndicatorStyle={styles.indicator}
        backgroundStyle={styles.sheetBg}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        footerComponent={renderFooter}
      >
        <BottomSheetFlatList
          data={data}
          keyExtractor={(x: { id: string }) => x.id}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={listHeader}
          ListEmptyComponent={listEmpty}
          ListFooterComponent={receiptListFooter}
          renderItem={({ item }) => {
            if (splitMode === 'equal') {
              const friend = item as SplitwiseFriend;
              return <EqualRow friend={friend} isSelected={selected.has(friend.id)} onToggle={toggle} />;
            }
            if (splitMode === 'custom') {
              const friend = item as SplitwiseFriend;
              return (
                <CustomRow
                  friend={friend}
                  amount={customAmounts[friend.id] ?? 0}
                  onDecrease={() => adjustAmount(friend.id, -STEP)}
                  onIncrease={() => adjustAmount(friend.id, STEP)}
                  onCommit={(v) => commitAmount(friend.id, v)}
                />
              );
            }
            const receiptItem = item as ReceiptItem;
            return (
              <ReceiptItemRow
                item={receiptItem}
                participants={receiptParticipants}
                onChangeName={updateReceiptItemName}
                onChangePriceCents={updateReceiptItemPriceCents}
                onDelete={deleteReceiptItem}
                onChangeAssignees={updateReceiptItemAssignees}
              />
            );
          }}
        />
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
      <Text style={[styles.friendName, isSelected && styles.friendNameSelected]} numberOfLines={1}>
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
  listContent: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, paddingBottom: 90 },
  footer: { backgroundColor: Colors.surface },

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
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.md,
    marginBottom: Spacing.md,
    minHeight: 52,
    ...Shadow.sm,
  },
  addBtnDisabled: { backgroundColor: Colors.surfaceMuted },
  addBtnPressed: { backgroundColor: Colors.primaryDark },
  addBtnText: { color: Colors.textInverse, fontSize: 16, fontWeight: '700' },
  addBtnTextDisabled: { color: Colors.textTertiary },

  addItemBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.primaryMuted,
    borderRadius: Radius.md,
    paddingVertical: Spacing.sm,
    marginBottom: Spacing.md,
  },
  addItemBtnPressed: { backgroundColor: Colors.primaryLight },
  addItemText: { fontSize: 14, fontWeight: '600', color: Colors.primary },

  receiptFooterStrip: {
    marginTop: Spacing.sm,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  receiptFooterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  receiptFooterName: { flex: 1, fontSize: 13, color: Colors.textSecondary, marginRight: Spacing.sm },
  receiptFooterAmount: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.textPrimary,
    fontVariant: ['tabular-nums'],
  },
});
