// mobile/components/AddToVacationSheet.tsx
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetFlatList,
  BottomSheetFooter,
  type BottomSheetFooterProps,
} from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { getNewTransactions, assignTransactionsToVacation, getSplitwiseInbox } from '@/lib/db';
import { useTransactionStore } from '@/stores/transactionStore';
import { useToast } from '@/components/ToastProvider';
import { useSheetFooterInset } from '@/hooks/useSheetFooterInset';
import { SplitwiseInboxItem, Transaction } from '@/lib/types';
import { Colors, Radius, Shadow, Spacing, merchantColor } from '@/lib/theme';

interface Props {
  vacationId: string;
  openToken?: number;
  onDone: () => void;
}

// One flat list over two kinds of candidate, so the pinned footer and the
// single scroll position carry over from the Plaid-only version unchanged.
type Row =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'tx'; key: string; tx: Transaction }
  | { kind: 'inbox'; key: string; item: SplitwiseInboxItem };

export const AddToVacationSheet = forwardRef<BottomSheetModal, Props>(
  ({ vacationId, openToken, onDone }, ref) => {
    const toast = useToast();
    const { onFooterLayout, bottomInset, contentPaddingBottom } = useSheetFooterInset();
    // Accepting goes through the store, not the db directly: the Transactions
    // tab loads its inbox slice once on mount, so a direct write would leave
    // the card sitting there until that screen remounts.
    const acceptInboxItem = useTransactionStore((s) => s.acceptInboxItem);
    const [candidates, setCandidates] = useState<Transaction[]>([]);
    const [inboxItems, setInboxItems] = useState<SplitwiseInboxItem[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [selectedExpenses, setSelectedExpenses] = useState<Set<string>>(new Set());
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
      setSelected(new Set());
      setSelectedExpenses(new Set());
      getNewTransactions().then(setCandidates).catch(() => setCandidates([]));
      getSplitwiseInbox().then(setInboxItems).catch(() => setInboxItems([]));
    }, [openToken]);

    const selectedCount = selected.size + selectedExpenses.size;

    const rows: Row[] = [
      ...(inboxItems.length > 0
        ? [{ kind: 'header', key: 'h:sw', label: 'From Splitwise' } as Row,
           ...inboxItems.map((item): Row => ({ kind: 'inbox', key: `sw:${item.expense_id}`, item }))]
        : []),
      ...(candidates.length > 0
        ? [{ kind: 'header', key: 'h:tx', label: 'Unassigned' } as Row,
           ...candidates.map((tx): Row => ({ kind: 'tx', key: tx.id, tx }))]
        : []),
    ];

    function toggleIn(setFn: typeof setSelected, id: string) {
      setFn((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }

    async function confirm() {
      if (selectedCount === 0) return;
      setSubmitting(true);
      try {
        if (selected.size > 0) {
          await assignTransactionsToVacation(vacationId, [...selected]);
        }
        // Imported expenses are already split on Splitwise, so they land in
        // the trip's recap rather than its "To split" list. The bucket is
        // ignored downstream whenever a vacation applies, but pass the one
        // that vacation spend always resolves to anyway.
        for (const expenseId of selectedExpenses) {
          const item = inboxItems.find((i) => i.expense_id === expenseId);
          if (item) await acceptInboxItem(item, 'travel', vacationId);
        }
        onDone();
      } catch {
        toast.show('Could not add transactions. Please try again.', 'error');
      } finally {
        setSubmitting(false);
      }
    }

    // The sheet renders the footer as a component type, so a change to
    // `renderFooter`'s identity remounts the footer subtree. Keep the deps to
    // what actually affects rendering and route the press through a ref, so
    // the handler never goes stale on `vacationId`/`onDone` (the parent
    // passes `onDone` as an inline arrow — a new identity every render).
    const confirmRef = useRef(confirm);
    confirmRef.current = confirm;

    const renderFooter = useCallback(
      // The footer style is opaque so list rows scrolling under the pinned
      // footer don't show through in the gaps beside the button.
      (footerProps: BottomSheetFooterProps) => (
        <BottomSheetFooter {...footerProps} bottomInset={bottomInset} style={styles.footer}>
          <View testID="add-to-vacation-footer" onLayout={onFooterLayout}>
            <Pressable
              style={({ pressed }) => [
                styles.confirmBtn,
                (selectedCount === 0 || submitting) && styles.confirmBtnDisabled,
                pressed && selectedCount > 0 && styles.confirmBtnPressed,
              ]}
              onPress={() => confirmRef.current()}
              disabled={selectedCount === 0 || submitting}
              accessibilityRole="button"
              accessibilityLabel="Add to vacation"
            >
              <Text style={[styles.confirmText, selectedCount === 0 && styles.confirmTextDisabled]}>
                Add {selectedCount > 0 ? `(${selectedCount})` : ''}
              </Text>
            </Pressable>
          </View>
        </BottomSheetFooter>
      ),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [selectedCount, submitting, bottomInset, onFooterLayout]
    );

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={['70%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        handleIndicatorStyle={styles.indicator}
        backgroundStyle={styles.sheetBg}
        footerComponent={renderFooter}
      >
        <BottomSheetFlatList
          testID="add-to-vacation-list"
          data={rows}
          keyExtractor={(row) => row.key}
          style={styles.list}
          contentContainerStyle={[styles.listContent, { paddingBottom: contentPaddingBottom }]}
          ListHeaderComponent={<Text style={styles.title}>Add transactions</Text>}
          ListEmptyComponent={<Text style={styles.empty}>Nothing left to add.</Text>}
          renderItem={({ item: row }) => {
            if (row.kind === 'header') {
              return <Text style={styles.sectionHeader}>{row.label}</Text>;
            }
            const isInbox = row.kind === 'inbox';
            const title = isInbox ? row.item.description : row.tx.merchant_name;
            const amount = isInbox ? row.item.cost : row.tx.amount;
            const id = isInbox ? row.item.expense_id : row.tx.id;
            const isSelected = isInbox ? selectedExpenses.has(id) : selected.has(id);
            const color = merchantColor(title);
            return (
              <Pressable
                style={[styles.row, isSelected && styles.rowSelected]}
                onPress={() => toggleIn(isInbox ? setSelectedExpenses : setSelected, id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isSelected }}
                accessibilityLabel={`Select ${title}`}
              >
                <View style={[styles.avatar, { backgroundColor: color + '18' }]}>
                  <Text style={[styles.avatarText, { color }]}>{title[0].toUpperCase()}</Text>
                </View>
                <View style={styles.rowText}>
                  <Text style={styles.name} numberOfLines={1}>{title}</Text>
                  {isInbox && (
                    <Text style={styles.subtitle} numberOfLines={1}>
                      {row.item.payer_name} paid · your share ${row.item.my_share.toFixed(2)}
                    </Text>
                  )}
                </View>
                <Text style={styles.amount}>${amount.toFixed(2)}</Text>
                <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
                  {isSelected && <Ionicons name="checkmark" size={13} color={Colors.textInverse} />}
                </View>
              </Pressable>
            );
          }}
        />
      </BottomSheetModal>
    );
  }
);

const styles = StyleSheet.create({
  indicator: { backgroundColor: Colors.border, width: 36 },
  sheetBg: { backgroundColor: Colors.surface },
  title: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary, marginBottom: Spacing.md },
  empty: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.xxl },
  list: { flex: 1 },
  // paddingBottom is dynamic — see contentPaddingBottom above the FlatList,
  // which reserves room for the pinned footer's measured height.
  listContent: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
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
  rowText: { flex: 1, minWidth: 0 },
  name: { fontSize: 15, color: Colors.textPrimary, fontWeight: '500' },
  subtitle: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  sectionHeader: {
    fontSize: 12, fontWeight: '700', color: Colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginTop: Spacing.md, marginBottom: Spacing.xs,
  },
  amount: { fontSize: 14, fontWeight: '600', color: Colors.textPrimary, marginRight: Spacing.md },
  checkbox: {
    width: 22, height: 22, borderRadius: Radius.sm, borderWidth: 1.5, borderColor: Colors.border,
    justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.surface,
  },
  checkboxSelected: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  footer: { backgroundColor: Colors.surface },
  confirmBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg, paddingVertical: 16,
    justifyContent: 'center', alignItems: 'center',
    marginHorizontal: Spacing.xl, marginTop: Spacing.md, marginBottom: Spacing.md, ...Shadow.sm,
  },
  confirmBtnDisabled: { backgroundColor: Colors.surfaceMuted },
  confirmBtnPressed: { backgroundColor: Colors.primaryDark },
  confirmText: { color: Colors.textInverse, fontSize: 16, fontWeight: '700' },
  confirmTextDisabled: { color: Colors.textTertiary },
});
