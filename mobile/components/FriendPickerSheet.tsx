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
import { useFriendStore } from '@/stores/friendStore';
import { useAuthStore } from '@/stores/authStore';
import { useTransactionStore } from '@/stores/transactionStore';
import { getSplitDecision, insertSplitDecision, updateTransactionStatus } from '@/lib/db';
import { createExpense, SplitwiseAuthError } from '@/lib/splitwise';
import { SplitwiseFriend, Transaction } from '@/lib/types';
import { useToast } from '@/components/ToastProvider';

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
        // Idempotency check
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

        // Write split_decision + update status (retry up to 3 times)
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

    return (
      <BottomSheetModal ref={ref} snapPoints={['60%', '90%']} enablePanDownToClose>
        <BottomSheetView style={styles.container}>
          <Text style={styles.header}>{transaction.merchant_name}</Text>
          <Text style={styles.amount}>${transaction.amount.toFixed(2)}</Text>
          {selected.size > 0 && (
            <Text style={styles.share}>
              ${amountEach.toFixed(2)} each ({n} people)
            </Text>
          )}

          {isLoading ? (
            <ActivityIndicator style={styles.spinner} />
          ) : friends.length === 0 ? (
            <Text style={styles.empty}>No Splitwise friends found.</Text>
          ) : (
            <FlatList
              data={friends}
              keyExtractor={(f) => f.id}
              renderItem={({ item }) => (
                <FriendRow
                  friend={item}
                  isSelected={selected.has(item.id)}
                  onToggle={() => toggle(item.id)}
                />
              )}
            />
          )}

          <Pressable
            style={[styles.addBtn, (selected.size === 0 || submitting) && styles.addBtnDisabled]}
            onPress={handleAddToSplitwise}
            disabled={selected.size === 0 || submitting}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.addBtnText}>Add to Splitwise</Text>
            )}
          </Pressable>
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

function FriendRow({ friend, isSelected, onToggle }: {
  friend: SplitwiseFriend;
  isSelected: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable style={[styles.row, isSelected && styles.rowSelected]} onPress={onToggle}>
      <Text style={styles.rowName}>{friend.display_name}</Text>
      {isSelected && <Text style={styles.check}>✓</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  header: { fontSize: 18, fontWeight: '700', color: '#111' },
  amount: { fontSize: 28, fontWeight: '800', color: '#111', marginVertical: 4 },
  share: { fontSize: 14, color: '#555', marginBottom: 12 },
  spinner: { marginTop: 40 },
  empty: { color: '#888', textAlign: 'center', marginTop: 40 },
  row: { paddingVertical: 14, paddingHorizontal: 16, borderRadius: 10, marginBottom: 8, backgroundColor: '#f5f5f5', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowSelected: { backgroundColor: '#EBF2FF' },
  rowName: { fontSize: 15, color: '#111' },
  check: { fontSize: 16, color: '#007AFF' },
  addBtn: { backgroundColor: '#007AFF', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 16 },
  addBtnDisabled: { backgroundColor: '#B0C8F5' },
  addBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
