// mobile/components/AddToVacationSheet.tsx
import { forwardRef, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheetModal, BottomSheetView, BottomSheetFlatList } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { getNewTransactions, assignTransactionsToVacation } from '@/lib/db';
import { useToast } from '@/components/ToastProvider';
import { Transaction } from '@/lib/types';
import { Colors, Radius, Shadow, Spacing, merchantColor } from '@/lib/theme';

interface Props {
  vacationId: string;
  openToken?: number;
  onDone: () => void;
}

export const AddToVacationSheet = forwardRef<BottomSheetModal, Props>(
  ({ vacationId, openToken, onDone }, ref) => {
    const toast = useToast();
    const [candidates, setCandidates] = useState<Transaction[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
      setSelected(new Set());
      getNewTransactions().then(setCandidates).catch(() => setCandidates([]));
    }, [openToken]);

    function toggle(id: string) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }

    async function confirm() {
      if (selected.size === 0) return;
      setSubmitting(true);
      try {
        await assignTransactionsToVacation(vacationId, [...selected]);
        onDone();
      } catch {
        toast.show('Could not add transactions. Please try again.', 'error');
      } finally {
        setSubmitting(false);
      }
    }

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={['70%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        handleIndicatorStyle={styles.indicator}
        backgroundStyle={styles.sheetBg}
      >
        <BottomSheetView style={styles.container}>
          <Text style={styles.title}>Add transactions</Text>
          {candidates.length === 0 ? (
            <Text style={styles.empty}>No unassigned transactions to add.</Text>
          ) : (
            <BottomSheetFlatList
              data={candidates}
              keyExtractor={(t) => t.id}
              style={styles.list}
              renderItem={({ item }) => {
                const isSelected = selected.has(item.id);
                const color = merchantColor(item.merchant_name);
                return (
                  <Pressable
                    style={[styles.row, isSelected && styles.rowSelected]}
                    onPress={() => toggle(item.id)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isSelected }}
                    accessibilityLabel={`Select ${item.merchant_name}`}
                  >
                    <View style={[styles.avatar, { backgroundColor: color + '18' }]}>
                      <Text style={[styles.avatarText, { color }]}>{item.merchant_name[0].toUpperCase()}</Text>
                    </View>
                    <Text style={styles.name} numberOfLines={1}>{item.merchant_name}</Text>
                    <Text style={styles.amount}>${item.amount.toFixed(2)}</Text>
                    <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
                      {isSelected && <Ionicons name="checkmark" size={13} color={Colors.textInverse} />}
                    </View>
                  </Pressable>
                );
              }}
            />
          )}
          <Pressable
            style={({ pressed }) => [
              styles.confirmBtn,
              (selected.size === 0 || submitting) && styles.confirmBtnDisabled,
              pressed && selected.size > 0 && styles.confirmBtnPressed,
            ]}
            onPress={confirm}
            disabled={selected.size === 0 || submitting}
            accessibilityRole="button"
            accessibilityLabel="Add to vacation"
          >
            <Text style={[styles.confirmText, selected.size === 0 && styles.confirmTextDisabled]}>
              Add {selected.size > 0 ? `(${selected.size})` : ''}
            </Text>
          </Pressable>
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

const styles = StyleSheet.create({
  indicator: { backgroundColor: Colors.border, width: 36 },
  sheetBg: { backgroundColor: Colors.surface },
  container: { flex: 1, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  title: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary, marginBottom: Spacing.md },
  empty: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.xxl },
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    marginBottom: Spacing.xs,
    backgroundColor: Colors.surfaceMuted,
  },
  rowSelected: { backgroundColor: Colors.primaryMuted },
  avatar: { width: 36, height: 36, borderRadius: Radius.sm, justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md },
  avatarText: { fontSize: 14, fontWeight: '700' },
  name: { flex: 1, fontSize: 15, color: Colors.textPrimary, fontWeight: '500' },
  amount: { fontSize: 14, fontWeight: '600', color: Colors.textPrimary, marginRight: Spacing.md },
  checkbox: {
    width: 22, height: 22, borderRadius: Radius.sm, borderWidth: 1.5, borderColor: Colors.border,
    justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.surface,
  },
  checkboxSelected: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  confirmBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg, paddingVertical: 16,
    justifyContent: 'center', alignItems: 'center', marginTop: Spacing.md, marginBottom: Spacing.md, ...Shadow.sm,
  },
  confirmBtnDisabled: { backgroundColor: Colors.surfaceMuted },
  confirmBtnPressed: { backgroundColor: Colors.primaryDark },
  confirmText: { color: Colors.textInverse, fontSize: 16, fontWeight: '700' },
  confirmTextDisabled: { color: Colors.textTertiary },
});
