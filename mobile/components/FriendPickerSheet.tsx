// mobile/components/FriendPickerSheet.tsx
import { forwardRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { useFriendStore } from '@/stores/friendStore';
import { useAuthStore } from '@/stores/authStore';
import { useTransactionStore } from '@/stores/transactionStore';
import { getSplitDecision, insertSplitDecision, updateTransactionStatus } from '@/lib/db';
import { createExpense, SplitwiseAuthError } from '@/lib/splitwise';
import { SplitwiseFriend, Transaction } from '@/lib/types';
import { useToast } from '@/components/ToastProvider';
import { Colors, Radius, Shadow, Spacing, merchantColor } from '@/lib/theme';

interface Props {
  transaction: Transaction | null;
  onSuccess: (amountEach: number) => void;
}

export const FriendPickerSheet = forwardRef<BottomSheetModal, Props>(
  ({ transaction, onSuccess }, ref) => {
    const { friends, isLoading } = useFriendStore();
    const user_id = useAuthStore((s) => s.user_id);
    const markSplit = useTransactionStore((s) => s.markSplit);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [submitting, setSubmitting] = useState(false);
    const toast = useToast();

    if (!transaction) return null;

    const n = selected.size + 1;
    const amountEach = transaction.amount / n;

    function toggle(id: string) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }

    async function handleAddToSplitwise() {
      if (selected.size === 0 || submitting) return;
      setSubmitting(true);
      try {
        const existing = await getSplitDecision(transaction!.id);
        if (existing) {
          await updateTransactionStatus(transaction!.id, 'split');
          await markSplit(transaction!.id);
          onSuccess(existing.amount_each);
          return;
        }

        const selectedFriends = friends.filter((f) => selected.has(f.id));
        const { expense_id, amount_each } = await createExpense({
          amount: transaction!.amount,
          description: transaction!.merchant_name,
          currency: transaction!.currency,
          currentUserId: user_id!,
          friendIds: selectedFriends.map((f) => f.id),
        });

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await insertSplitDecision({
              id: `${transaction!.id}-${Date.now()}`,
              transaction_id: transaction!.id,
              splitwise_expense_id: expense_id,
              friend_ids: selectedFriends.map((f) => f.id),
              friend_names: selectedFriends.map((f) => f.display_name),
              amount_each,
              created_at: new Date().toISOString(),
            });
            break;
          } catch {
            if (attempt === 3) throw new Error('DB_WRITE_FAILED');
          }
        }

        await markSplit(transaction!.id);
        onSuccess(amount_each);
      } catch (err) {
        if (err instanceof SplitwiseAuthError) {
          toast.show('Splitwise session expired. Please sign in again.', 'error');
        } else {
          toast.show('Failed to add expense. Please try again.', 'error');
        }
        setSubmitting(false);
        setSelected(new Set());
      }
    }

    const merchantInitial = (transaction.merchant_name ?? '?')[0].toUpperCase();
    const merchantBg = merchantColor(transaction.merchant_name ?? '?');

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={['55%', '85%']}
        enablePanDownToClose
        handleIndicatorStyle={styles.indicator}
        backgroundStyle={styles.sheetBg}
      >
        <BottomSheetView style={styles.container}>
          {/* Transaction summary */}
          <View style={styles.txSummary}>
            <View style={[styles.txAvatar, { backgroundColor: merchantBg + '18' }]}>
              <Text style={[styles.txAvatarText, { color: merchantBg }]}>{merchantInitial}</Text>
            </View>
            <View style={styles.txInfo}>
              <Text style={styles.txMerchant} numberOfLines={1}>{transaction.merchant_name}</Text>
              <Text style={styles.txTotal}>${transaction.amount.toFixed(2)}</Text>
            </View>
          </View>

          {/* Split preview */}
          {selected.size > 0 && (
            <View style={styles.splitPreview}>
              <Ionicons name="people-outline" size={16} color={Colors.primary} style={{ marginRight: 6 }} />
              <Text style={styles.splitPreviewText}>
                ${amountEach.toFixed(2)} each · {n} people
              </Text>
            </View>
          )}

          {/* Section label */}
          <Text style={styles.sectionLabel}>Select friends to split with</Text>

          {/* Friends list */}
          {isLoading ? (
            <ActivityIndicator color={Colors.primary} style={styles.spinner} />
          ) : friends.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="people-outline" size={32} color={Colors.textTertiary} />
              <Text style={styles.emptyText}>No Splitwise friends found.</Text>
            </View>
          ) : (
            <FlatList
              data={friends}
              keyExtractor={(f) => f.id}
              style={styles.friendList}
              renderItem={({ item }) => (
                <FriendRow
                  friend={item}
                  isSelected={selected.has(item.id)}
                  onToggle={() => toggle(item.id)}
                />
              )}
            />
          )}

          {/* CTA */}
          <Pressable
            style={({ pressed }) => [
              styles.addBtn,
              (selected.size === 0 || submitting) && styles.addBtnDisabled,
              pressed && selected.size > 0 && !submitting && styles.addBtnPressed,
            ]}
            onPress={handleAddToSplitwise}
            disabled={selected.size === 0 || submitting}
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
                  color={selected.size === 0 ? Colors.textTertiary : Colors.textInverse}
                  style={{ marginRight: 6 }}
                />
                <Text style={[styles.addBtnText, selected.size === 0 && styles.addBtnTextDisabled]}>
                  Add to Splitwise
                </Text>
              </>
            )}
          </Pressable>
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

function FriendRow({
  friend,
  isSelected,
  onToggle,
}: {
  friend: SplitwiseFriend;
  isSelected: boolean;
  onToggle: () => void;
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
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: isSelected }}
      accessibilityLabel={friend.display_name}
    >
      <View style={[styles.friendAvatar, { backgroundColor: avatarColor + '18' }]}>
        <Text style={[styles.friendAvatarText, { color: avatarColor }]}>{initial}</Text>
      </View>
      <Text style={[styles.friendName, isSelected && styles.friendNameSelected]}>
        {friend.display_name}
      </Text>
      <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
        {isSelected && <Ionicons name="checkmark" size={13} color={Colors.textInverse} />}
      </View>
    </Pressable>
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
  txMerchant: {
    fontSize: 17,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  txTotal: {
    fontSize: 24,
    fontWeight: '800',
    color: Colors.textPrimary,
    letterSpacing: -0.5,
  },

  splitPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.primaryMuted,
    borderRadius: Radius.md,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    marginBottom: Spacing.md,
  },
  splitPreviewText: {
    fontSize: 14,
    color: Colors.primary,
    fontWeight: '600',
  },

  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: Spacing.sm,
  },

  spinner: { marginTop: 40 },
  emptyContainer: {
    alignItems: 'center',
    paddingTop: 40,
    gap: Spacing.md,
  },
  emptyText: {
    fontSize: 14,
    color: Colors.textSecondary,
  },

  friendList: { flex: 1 },
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
  friendAvatar: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  friendAvatarText: { fontSize: 14, fontWeight: '700' },
  friendName: {
    flex: 1,
    fontSize: 15,
    color: Colors.textPrimary,
    fontWeight: '500',
  },
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
  checkboxSelected: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
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
